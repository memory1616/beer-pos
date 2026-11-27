/**
 * NotificationWorker — Worker gửi thông báo công nợ nền
 * ─────────────────────────────────────────────────────────────────────────────
 * Vòng lặp:
 *   1. Phục hồi job bị kẹt (lease hết hạn) — đảm bảo không mất job sau restart.
 *   2. Lease một lô job đang chờ (khóa để 2 worker không xử lý trùng).
 *   3. Gửi qua provider được cấu hình.
 *   4. Cập nhật trạng thái + ghi lịch sử vào `debt_notifications`.
 *
 * Nguyên tắc:
 *  - KHÔNG busy-wait: dùng setTimeout lặp lại (không setInterval chồng nhau).
 *  - KHÔNG tạo nhiều timer không được clear: `stop()` clear sạch.
 *  - KHÔNG gây CPU 100%: mỗi vòng có batch limit + interval tối thiểu.
 *  - Lỗi provider KHÔNG làm hỏng tiến trình (mọi lỗi bị bắt & log).
 *  - Job 'unknown' KHÔNG retry mù (nguy cơ gửi trùng).
 */

const logger = require('../../utils/logger');
const NotificationJobService = require('./NotificationJobService');
const ProviderFactory = require('./provider');
const { DELIVERY_STATUS } = require('./provider/NotificationProvider');

/** Trạng thái worker. */
const WORKER_STATE = {
  STOPPED: 'stopped',
  RUNNING: 'running',
};

/** Singleton. */
let _instance = null;

class NotificationWorker {
  constructor(opts = {}) {
    this.workerId = String(opts.workerId || `notify-worker-${process.pid}`);
    this.intervalMs = Math.min(
      Math.max(parseInt(opts.intervalMs, 10) || this._defaultInterval(), 1000),
      10 * 60 * 1000
    );
    this.batchSize = Math.min(
      Math.max(parseInt(opts.batchSize, 10) || this._defaultBatch(), 1),
      50
    );
    this.state = WORKER_STATE.STOPPED;
    this.timer = null;
    this.running = false;
    /** Đếm số job đã xử lý (để test / chẩn đoán). */
    this.stats = { processed: 0, sent: 0, failed: 0, retried: 0, noGroup: 0, unknown: 0 };
  }

  _defaultInterval() {
    try {
      const db = require('../../../database');
      const row = db
        .prepare("SELECT value FROM settings WHERE key = 'debt_notify_worker_interval_ms'")
        .get();
      const v = parseInt(row && row.value, 10);
      return Number.isFinite(v) && v > 0 ? v : 15000;
    } catch (_) {
      return 15000;
    }
  }

  _defaultBatch() {
    try {
      const db = require('../../../database');
      const row = db
        .prepare("SELECT value FROM settings WHERE key = 'debt_notify_job_batch_size'")
        .get();
      const v = parseInt(row && row.value, 10);
      return Number.isFinite(v) && v > 0 ? v : 10;
    } catch (_) {
      return 10;
    }
  }

  /** Worker có đang chạy không. */
  isRunning() {
    return this.state === WORKER_STATE.RUNNING;
  }

  /**
   * Bắt đầu worker.
   * @param {object} [opts] { immediate: chạy 1 vòng ngay không }
   */
  start(opts = {}) {
    if (this.state === WORKER_STATE.RUNNING) {
      return { success: true, alreadyRunning: true };
    }
    this.state = WORKER_STATE.RUNNING;
    logger.info('[NOTIFY_WORKER] Worker đã khởi động', {
      workerId: this.workerId,
      intervalMs: this.intervalMs,
      batchSize: this.batchSize,
    });

    const tick = async () => {
      if (this.state !== WORKER_STATE.RUNNING) return;
      try {
        await this.runOnce();
      } catch (e) {
        logger.error('[NOTIFY_WORKER] Vòng lặp lỗi', { error: e.message });
      }
      // Lên lịch vòng tiếp theo (KHÔNG setInterval → không chồng vòng).
      if (this.state === WORKER_STATE.RUNNING) {
        this.timer = setTimeout(tick, this.intervalMs);
        if (this.timer.unref) this.timer.unref();
      }
    };

    if (opts.immediate !== false) {
      // Chạy vòng đầu tiên ngay (không chặn start).
      setImmediate(tick);
    } else {
      this.timer = setTimeout(tick, this.intervalMs);
      if (this.timer.unref) this.timer.unref();
    }

    return { success: true };
  }

  /** Dừng worker & clear timer. */
  stop() {
    this.state = WORKER_STATE.STOPPED;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('[NOTIFY_WORKER] Worker đã dừng', { workerId: this.workerId });
    return { success: true };
  }

  /**
   * Chạy 1 vòng xử lý.
   * @returns {Promise<object>} thống kê vòng
   */
  async runOnce() {
    if (this.running) {
      return { skipped: true, reason: 'ALREADY_RUNNING' };
    }
    this.running = true;

    const summary = { processed: 0, sent: 0, failed: 0, retried: 0, noGroup: 0, unknown: 0 };

    try {
      // 1. Phục hồi job bị kẹt.
      NotificationJobService.recoverStaleJobs();

      // 2. Lease job.
      const jobs = NotificationJobService.leaseJobs({
        limit: this.batchSize,
        workerId: this.workerId,
      });
      if (!jobs.length) {
        return summary;
      }

      // 3. Gửi từng job (TUẦN TỰ để không dồn ép provider).
      for (const job of jobs) {
        const res = await this.processJob(job);
        summary.processed += 1;
        if (res.status === 'sent') summary.sent += 1;
        else if (res.status === 'retry') summary.retried += 1;
        else if (res.status === 'failed') summary.failed += 1;
        else if (res.status === 'no_group') summary.noGroup += 1;
        else if (res.status === 'unknown') summary.unknown += 1;

        this.stats.processed += 1;
        this.stats[res.status] = (this.stats[res.status] || 0) + 1;
      }
    } catch (e) {
      logger.error('[NOTIFY_WORKER] runOnce error', { error: e.message });
    } finally {
      this.running = false;
    }

    return summary;
  }

  /**
   * Xử lý 1 job: gửi qua provider + cập nhật trạng thái + ghi lịch sử.
   */
  async processJob(job) {
    const jobId = job.id;
    const groupId = String(job.group_id || '').trim();

    // Không có group id → 'no_group' (không gửi).
    if (!groupId) {
      NotificationJobService.markFailed(
        jobId,
        {
          errorCode: 'INVALID_GROUP',
          errorMessage: 'Job không có Group ID',
          deliveryStatus: 'failed',
          retryable: false,
        },
        job.attempts
      );
      this._writeHistory(job, {
        status: 'skipped',
        error: 'Job không có Group ID',
      });
      return { status: 'no_group' };
    }

    const provider = ProviderFactory.getProvider(job.provider);

    let result;
    try {
      result = await provider.sendMessage({
        groupId,
        text: job.content_snapshot || '',
        groupName: job.group_name_snapshot || null,
      });
    } catch (e) {
      logger.error('[NOTIFY_WORKER] Provider ném exception', {
        jobId,
        error: e.message,
      });
      result = {
        success: false,
        errorCode: 'UNKNOWN_ERROR',
        errorMessage: e.message,
        retryable: true,
        deliveryStatus: DELIVERY_STATUS.FAILED,
      };
    }

    if (result && result.success) {
      NotificationJobService.markSent(jobId, result);
      this._writeHistory(job, {
        status: 'sent',
        groupId,
        providerMessageId: result.providerMessageId,
        deliveryStatus: result.deliveryStatus,
      });
      logger.info('[NOTIFY_WORKER] Đã gửi thông báo', {
        jobId,
        customerId: job.customer_id,
        groupId,
        provider: job.provider,
      });
      return { status: 'sent' };
    }

    // Thất bại → phân loại retry / failed / unknown.
    const deliveryStatus = (result && result.deliveryStatus) || DELIVERY_STATUS.FAILED;
    NotificationJobService.markFailed(jobId, result || {}, job.attempts);

    const finalStatus =
      deliveryStatus === 'unknown'
        ? 'unknown'
        : result && result.retryable !== false && job.attempts < NotificationJobService.maxAttempts()
          ? 'retry'
          : 'failed';

    this._writeHistory(job, {
      status: 'failed',
      groupId,
      error: (result && result.errorMessage) || 'Gửi thất bại',
      deliveryStatus,
    });

    logger.error('[NOTIFY_WORKER] Gửi thông báo thất bại', {
      jobId,
      customerId: job.customer_id,
      groupId,
      status: finalStatus,
      attempts: job.attempts,
      error: (result && result.errorMessage) || null,
    });

    return { status: finalStatus };
  }

  /**
   * Ghi 1 dòng lịch sử vào `debt_notifications` (bảng lịch sử CŨ — giữ tương thích).
   * Không ghi trùng (kiểm tra theo job_id).
   */
  _writeHistory(job, opts = {}) {
    if (NotificationJobService.hasHistoryRow(job.id)) return null;
    try {
      const db = require('../../../database');
      const info = db
        .prepare(
          `INSERT INTO debt_notifications
             (customer_id, customer_name, channel, group_id, event_type,
              amount, applied_amount, credit_amount, balance_before, balance_after,
              content, status, error, source, transaction_id, sent_at,
              job_id, provider, delivery_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          job.customer_id,
          job.customer_name || null,
          job.provider || 'mock',
          opts.groupId !== undefined ? opts.groupId : job.group_id || null,
          job.event_type || 'payment',
          job.amount || 0,
          job.applied_amount || 0,
          job.credit_amount || 0,
          job.balance_before || 0,
          job.balance_after || 0,
          job.content_snapshot || null,
          opts.status || 'failed',
          opts.error || null,
          job.source || null,
          job.transaction_id ?? null,
          opts.status === 'sent' ? new Date().toISOString() : null,
          job.id,
          job.provider || null,
          opts.deliveryStatus || null
        );
      return info.lastInsertRowid;
    } catch (e) {
      logger.error('[NOTIFY_WORKER] Ghi lịch sử thông báo lỗi', { error: e.message });
      return null;
    }
  }

  /** Thống kê worker. */
  getStatus() {
    return {
      state: this.state,
      workerId: this.workerId,
      intervalMs: this.intervalMs,
      batchSize: this.batchSize,
      stats: { ...this.stats },
    };
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/** Lấy singleton worker. */
function getWorker() {
  if (!_instance) _instance = new NotificationWorker();
  return _instance;
}

/** Tạo worker riêng (dùng trong test / script chạy độc lập). */
function createWorker(opts = {}) {
  return new NotificationWorker(opts);
}

/** Dừng & xoá singleton. */
function stopWorker() {
  if (_instance) {
    _instance.stop();
    _instance = null;
  }
}

/**
 * Khởi động worker nền (gọi từ server.js).
 * Tôn trọng `NOTIFICATION_WORKER_ENABLED` / `settings.debt_notify_worker_enabled`.
 */
function startBackgroundWorker() {
  const db = require('../../../database');

  const envFlag = String(process.env.NOTIFICATION_WORKER_ENABLED || '').trim().toLowerCase();
  let enabled = envFlag !== '0' && envFlag !== 'false';
  if (!envFlag) {
    try {
      const row = db
        .prepare("SELECT value FROM settings WHERE key = 'debt_notify_worker_enabled'")
        .get();
      enabled = !row || row.value !== '0';
    } catch (_) {
      enabled = true;
    }
  }

  if (!enabled) {
    logger.info('[NOTIFY_WORKER] Worker bị tắt qua cấu hình');
    return { success: false, skipped: true, reason: 'DISABLED' };
  }
  if (process.env.DISABLE_BACKGROUND_JOBS === '1') {
    logger.info('[NOTIFY_WORKER] Worker bị tắt qua DISABLE_BACKGROUND_JOBS');
    return { success: false, skipped: true, reason: 'DISABLED' };
  }

  const worker = getWorker();
  worker.start();
  return { success: true, worker };
}

module.exports = {
  WORKER_STATE,
  NotificationWorker,
  Worker: NotificationWorker,
  getWorker,
  createWorker,
  stopWorker,
  startBackgroundWorker,
};
