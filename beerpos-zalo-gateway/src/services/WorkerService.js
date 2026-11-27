const os = require('os');
const crypto = require('crypto');
const QueueService = require('./QueueService');
const SettingsService = require('./SettingsService');
const { createProvider } = require('../providers');
const logger = require('../logger');

const WORKER_STATE = {
  STOPPED: 'stopped',
  RUNNING: 'running',
  PAUSED: 'paused',
};

/**
 * WorkerService — vong lap xu ly job nen.
 *
 * Yeu cau:
 *  - Chay nen, khong tao nhieu worker thua.
 *  - Co lease (job bi khoa trong thoi gian xu ly).
 *  - Co timeout cho provider.
 *  - Co recovery job treo sau restart.
 *  - Khong xu ly trung job (lease UPDATE ... WHERE).
 *  - Co gioi han so lan thu + exponential backoff.
 *  - KHONG giu transaction DB khi goi provider.
 */
class WorkerService {
  constructor(opts = {}) {
    this.queue = opts.queue || new QueueService();
    this.settings = opts.settings || new SettingsService();
    this.workerId = opts.workerId || `${os.hostname()}-${process.pid}-${crypto
      .randomBytes(3)
      .toString('hex')}`;

    this.intervalMs = Math.max(Number(opts.intervalMs) || this._defaultInterval(), 1000);
    this.batchSize = Math.min(Math.max(Number(opts.batchSize) || this._defaultBatch(), 1), 50);
    this.leaseSeconds = Math.max(
      Math.round((Number(opts.leaseMs) || this._defaultLease()) / 1000),
      5
    );
    this.concurrency = Math.min(Math.max(Number(opts.concurrency) || 1, 1), 10);

    this.state = WORKER_STATE.STOPPED;
    this.timer = null;
    this.running = false;
    this.stats = { processed: 0, sent: 0, failed: 0, retried: 0, unknown: 0 };
  }

  _defaultInterval() {
    return this.settings.getInt('worker_interval_ms', 2000);
  }

  _defaultBatch() {
    return this.settings.getInt('worker_batch_size', 10);
  }

  _defaultLease() {
    return 60000;
  }

  /** Bat dau vong lap worker. */
  start() {
    if (this.state === WORKER_STATE.RUNNING) return this.getStatus();
    this.state = WORKER_STATE.RUNNING;
    this.timer = setInterval(() => {
      this.tick().catch((e) => {
        logger.error('[WORKER] tick error', { error: e.message });
      });
    }, this.intervalMs);
    // unref() de timer khong giu process song
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    logger.info('[WORKER] Da bat dau', {
      workerId: this.workerId,
      intervalMs: this.intervalMs,
      batchSize: this.batchSize,
    });
    return this.getStatus();
  }

  /** Dung vong lap worker. */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.state = WORKER_STATE.STOPPED;
    logger.info('[WORKER] Da dung', { workerId: this.workerId });
    return this.getStatus();
  }

  getStatus() {
    return {
      state: this.state,
      workerId: this.workerId,
      intervalMs: this.intervalMs,
      batchSize: this.batchSize,
      concurrency: this.concurrency,
      stats: { ...this.stats },
    };
  }

  /**
   * Chay 1 vong: recover -> lease -> xu ly.
   */
  async tick() {
    if (this.running) return { skipped: true };
    this.running = true;
    try {
      // 1. Job processing bi treo -> tra ve queued.
      const recovered = this.queue.recoverStaleJobs();
      if (recovered > 0) {
        logger.warn('[WORKER] Da hoi phuc job treo', { count: recovered });
      }

      // 2. Lease job.
      const jobs = this.queue.leaseJobs({
        limit: this.batchSize,
        workerId: this.workerId,
        leaseSeconds: this.leaseSeconds,
      });
      if (!jobs.length) return { processed: 0, recovered };

      // 3. Xu ly TUUAN TUU (khong don ep provider).
      for (const job of jobs) {
        await this.processJob(job);
      }

      return { processed: jobs.length, recovered };
    } finally {
      this.running = false;
    }
  }

  /**
   * Xu ly 1 job.
   * @param {object} job
   */
  async processJob(job) {
    const provider = this.settings.getProvider();
    const startedAt = new Date().toISOString();

    // KHONG giu transaction DB o day - chi doc du lieu snapshot tu job.
    const requestPayload = {
      groupId: job.group_id,
      text: job.message_content,
      customerId: job.customer_id,
      paymentId: job.payment_id,
      // KHONG gui groupId tuy bien — dung snapshot trong job.
    };

    let result;
    try {
      result = await this._callProvider(provider, requestPayload);
    } catch (e) {
      result = {
        success: false,
        errorCode: 'UNKNOWN',
        errorMessage: e.message,
        deliveryStatus: 'unknown',
        retryable: false,
        raw: null,
      };
    }

    const completedAt = new Date().toISOString();

    // Ghi log 1 lan thu.
    this.queue.logAttempt({
      jobId: job.id,
      provider: provider.name,
      requestPayload: {
        groupId: job.group_id,
        textLength: job.message_content.length,
      },
      responsePayload: result.raw,
      status: result.success ? 'sent' : result.deliveryStatus || 'failed',
      errorMessage: result.success ? null : result.errorMessage,
      startedAt,
      completedAt,
    });

    this.stats.processed += 1;

    if (result.success) {
      this.queue.markSent(job.id, { providerResponse: result });
      this.stats.sent += 1;
      logger.info('[WORKER] Job gui thanh cong', {
        jobId: job.id,
        provider: provider.name,
        deliveryStatus: result.deliveryStatus,
      });
      return;
    }

    // Timeout / khong xac dinh -> KHONG retry tu dong.
    if (result.deliveryStatus === 'unknown') {
      this.queue.markUnknown(job.id, {
        error: result.errorMessage || 'Khong xac dinh ket qua gui tin',
        providerResponse: result,
      });
      this.stats.unknown += 1;
      logger.warn('[WORKER] Job khong xac dinh - KHONG tu retry', {
        jobId: job.id,
        error: result.errorMessage,
      });
      return;
    }

    // Loi tam thoi + con lan thu -> retry voi backoff.
    const maxAttempts = job.max_attempts || 4;
    const attempts = job.attempts || 1;
    if (result.retryable && attempts < maxAttempts) {
      const delays = this.settings.getRetryDelays();
      const delayMs = delays[Math.min(attempts - 1, delays.length - 1)];
      this.queue.markRetry(job.id, {
        error: result.errorMessage,
        providerResponse: result,
        delaySeconds: Math.ceil(delayMs / 1000),
      });
      this.stats.retried += 1;
      logger.warn('[WORKER] Job se thu lai', {
        jobId: job.id,
        attempts,
        delayMs,
        error: result.errorMessage,
      });
      return;
    }

    this.queue.markFailed(job.id, {
      error: result.errorMessage || 'Gui tin that bai',
      providerResponse: result,
    });
    this.stats.failed += 1;
    logger.error('[WORKER] Job that bai', {
      jobId: job.id,
      attempts,
      error: result.errorMessage,
    });
  }

  /** Goi provider voi timeout. */
  async _callProvider(provider, payload) {
    const timeoutMs = require('../config').config.provider.timeoutMs;
    let timer = null;

    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`Provider timeout sau ${timeoutMs}ms`);
        e.code = 'ETIMEDOUT';
        e.uncertain = true;
        reject(e);
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });

    try {
      const res = await Promise.race([provider.sendMessage(payload), timeoutPromise]);
      return res;
    } catch (e) {
      if (e.code === 'ETIMEDOUT' || e.uncertain) {
        return {
          success: false,
          errorCode: 'TIMEOUT',
          errorMessage: e.message,
          deliveryStatus: 'unknown',
          retryable: false,
          raw: null,
        };
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

module.exports = WorkerService;
module.exports.WORKER_STATE = WORKER_STATE;
