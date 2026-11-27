/**
 * NotificationJobService — Hàng đợi bền vững cho thông báo công nợ
 * ─────────────────────────────────────────────────────────────────────────────
 * Mô hình: TRANSACTIONAL OUTBOX (đơn giản hoá cho SQLite, 1 tiến trình).
 *
 *   Payment Service
 *     → tạo bút toán (transaction đã commit)
 *     → enqueueNotificationJob()   [ghi 1 dòng vào debt_notification_jobs]
 *     → NotificationWorker          [lease → gửi → cập nhật trạng thái]
 *     → Provider Adapter
 *
 * Tính chất:
 *  - BỀN VỮNG: job nằm trong DB → không mất khi restart.
 *  - IDEMPOTENT: `idempotency_key` = transaction_id + event_type + group_id,
 *    UNIQUE → 1 payment chỉ tạo được 1 job cho đúng 1 nhóm.
 *  - SNAPSHOT: group_id + nội dung tin nhắn được chụp lại tại thời điểm tạo
 *    job → retry KHÔNG dựng lại nội dung từ số dư công nợ mới.
 *
 * Trạng thái job:
 *   queued     — vừa tạo, chờ worker
 *   processing — worker đã lease
 *   sent       — provider đã xác nhận tiếp nhận (accepted)
 *   retry      — lỗi tạm thời, sẽ thử lại
 *   failed     — lỗi vĩnh viễn hoặc hết số lần retry
 *   no_group   — khách chưa được liên kết Group ID hợp lệ
 *   cancelled  — bị huỷ theo thao tác quản trị
 *   unknown    — không xác định được kết quả (timeout) → KHÔNG retry mù
 */

const db = require('../../../database');
const logger = require('../../utils/logger');
const { PLATFORMS } = require('../debt/constants');

// ── Hằng số ──────────────────────────────────────────────────────────────────

const JOB_STATUS = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  SENT: 'sent',
  RETRY: 'retry',
  FAILED: 'failed',
  NO_GROUP: 'no_group',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
};

/** Các trạng thái KHÔNG được gửi lại tự động. */
const TERMINAL_STATUSES = [JOB_STATUS.SENT, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED];

/** Event type của job. */
const JOB_EVENT_TYPES = {
  PAYMENT: 'payment',
  MANUAL_DEBT: 'manual_debt',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Sinh idempotency key: transaction_id + event_type + group_id.
 * - Có transaction_id → key ổn định (chống tạo job trùng khi webhook retry).
 * - Không có transaction_id → dùng khoá dự phòng theo thời điểm + khách.
 */
function buildIdempotencyKey(opts = {}) {
  const eventType = opts.eventType || JOB_EVENT_TYPES.PAYMENT;
  const groupId = opts.groupId ? String(opts.groupId).trim() : 'NO_GROUP';
  const txId = opts.transactionId;

  if (txId !== null && txId !== undefined && txId !== '' && !Number.isNaN(Number(txId))) {
    return `${eventType}:tx:${Number(txId)}:grp:${groupId}`;
  }
  // Không có transaction_id → key theo thời điểm (mỗi lần gọi là 1 job riêng).
  return `${eventType}:ts:${Date.now()}:cust:${opts.customerId || 0}:grp:${groupId}`;
}

/** Đọc setting. */
function getSetting(key, fallback = null) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value !== undefined && row.value !== null ? row.value : fallback;
  } catch (_) {
    return fallback;
  }
}

// ── Truy vấn ─────────────────────────────────────────────────────────────────

/**
 * Tìm Group ID DUY NHẤT của khách (platform zalo_personal, status active).
 *
 * ⚠️ QUY TẮC NGHIỆP VỤ BẤT DI BẤT DỊCH:
 *  - 1 khách = 1 nhóm = 1 Group ID.
 *  - KHÔNG dùng `ORDER BY id DESC LIMIT 1` để "chọn nhóm mới nhất" để giải
 *    quyết dữ liệu trùng — nếu có nhiều dòng active thì đó là DỮ LIỆU LỖI và
 *    phải được báo cáo, không được âm thầm chọn 1.
 *  - Nếu không có Group ID hợp lệ → KHÔNG gửi tin.
 *
 * @returns {{groupId:string|null, groupName:string|null, rowId:number|null, ambiguous:boolean, activeCount:number}}
 */
function findCustomerGroup(customerId) {
  const custId = parseInt(customerId, 10);
  const empty = {
    groupId: null,
    groupName: null,
    rowId: null,
    ambiguous: false,
    activeCount: 0,
  };
  if (!custId || Number.isNaN(custId)) return empty;

  try {
    const rows = db
      .prepare(
        `SELECT id, group_id, group_name
           FROM debt_customer_groups
          WHERE customer_id = ? AND platform = ? AND status = 'active'
          ORDER BY id ASC`
      )
      .all(custId, PLATFORMS.ZALO_PERSONAL);

    if (!rows.length) return empty;

    // Nhiều dòng active → dữ liệu vi phạm ràng buộc 1:1 → KHÔNG gửi.
    if (rows.length > 1) {
      logger.error('[NOTIFY_JOB] Dữ liệu vi phạm 1 khách ↔ 1 nhóm — KHÔNG gửi tin', {
        customerId: custId,
        activeRows: rows.length,
        groupIds: rows.map((r) => r.group_id),
      });
      return {
        groupId: null,
        groupName: null,
        rowId: null,
        ambiguous: true,
        activeCount: rows.length,
      };
    }

    const row = rows[0];
    const gid = row.group_id ? String(row.group_id).trim() : '';
    if (!gid) return { ...empty, rowId: row.id, activeCount: 1 };

    return {
      groupId: gid,
      groupName: row.group_name ? String(row.group_name) : null,
      rowId: row.id,
      ambiguous: false,
      activeCount: 1,
    };
  } catch (e) {
    logger.error('[NOTIFY_JOB] findCustomerGroup error', { error: e.message });
    return empty;
  }
}

// ── Tạo job ──────────────────────────────────────────────────────────────────

/**
 * Tạo notification job cho 1 sự kiện thanh toán.
 *
 * @param {object} opts
 * @param {number} opts.customerId
 * @param {string} [opts.customerName]
 * @param {number|null} [opts.transactionId] - id bút toán debt_transactions
 * @param {string} [opts.eventType]
 * @param {string} [opts.content]   - nội dung tin nhắn (snapshot)
 * @param {number} [opts.amount]
 * @param {number} [opts.applied]
 * @param {number} [opts.credit]
 * @param {number} [opts.balanceBefore]
 * @param {number} [opts.balanceAfter]
 * @param {string} [opts.source]
 * @param {string} [opts.provider]   - provider sẽ dùng (snapshot)
 * @returns {{success:boolean, jobId?:number, status?:string, error?:string, duplicate?:boolean, groupId?:string|null}}
 */
function enqueueJob(opts = {}) {
  const customerId = parseInt(opts.customerId, 10);
  if (!customerId || Number.isNaN(customerId)) {
    return { success: false, error: 'customerId không hợp lệ' };
  }

  const eventType = opts.eventType || JOB_EVENT_TYPES.PAYMENT;
  const group = findCustomerGroup(customerId);
  const provider = String(opts.provider || getSetting('debt_notify_provider', 'mock')).trim();

  // ── Không có nhóm hợp lệ → job 'no_group' (KHÔNG gửi, KHÔNG phải lỗi) ────
  if (!group.groupId) {
    const reason = group.ambiguous
      ? 'Khách đang liên kết nhiều nhóm Zalo — cần sửa dữ liệu (1 khách = 1 nhóm)'
      : 'Chưa liên kết nhóm Zalo cho khách này';

    const key = buildIdempotencyKey({
      customerId,
      eventType,
      groupId: group.ambiguous ? 'AMBIGUOUS' : 'NO_GROUP',
      transactionId: opts.transactionId,
    });

    try {
      const info = db
        .prepare(
          `INSERT OR IGNORE INTO debt_notification_jobs
             (customer_id, customer_name, transaction_id, event_type,
              group_id, group_name_snapshot, content_snapshot,
              amount, applied_amount, credit_amount, balance_before, balance_after,
              provider, status, attempts, max_attempts, last_error, source, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          customerId,
          opts.customerName || null,
          opts.transactionId ?? null,
          eventType,
          null,
          null,
          opts.content || null,
          roundMoney(opts.amount),
          roundMoney(opts.applied),
          roundMoney(opts.credit),
          roundMoney(opts.balanceBefore),
          roundMoney(opts.balanceAfter),
          provider,
          JOB_STATUS.NO_GROUP,
          0,
          maxAttempts(),
          reason,
          opts.source || null,
          key
        );
      return {
        success: true,
        jobId: info.changes === 0 ? null : info.lastInsertRowid,
        status: JOB_STATUS.NO_GROUP,
        groupId: null,
        error: reason,
        duplicate: info.changes === 0,
      };
    } catch (e) {
      logger.error('[NOTIFY_JOB] enqueue no_group error', { error: e.message });
      return { success: false, error: e.message };
    }
  }

  // ── Có nhóm → tạo job 'queued' ───────────────────────────────────────────
  const key = buildIdempotencyKey({
    customerId,
    eventType,
    groupId: group.groupId,
    transactionId: opts.transactionId,
  });

  try {
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO debt_notification_jobs
           (customer_id, customer_name, transaction_id, event_type,
            group_id, group_name_snapshot, content_snapshot,
            amount, applied_amount, credit_amount, balance_before, balance_after,
            provider, status, attempts, max_attempts, source, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        customerId,
        opts.customerName || null,
        opts.transactionId ?? null,
        eventType,
        group.groupId,
        group.groupName,
        opts.content || null,
        roundMoney(opts.amount),
        roundMoney(opts.applied),
        roundMoney(opts.credit),
        roundMoney(opts.balanceBefore),
        roundMoney(opts.balanceAfter),
        provider,
        JOB_STATUS.QUEUED,
        0,
        maxAttempts(),
        opts.source || null,
        key
      );

    // INSERT OR IGNORE → nếu key đã tồn tại thì KHÔNG có dòng mới được tạo.
    // `info.changes === 0` → job trùng → trả về job cũ (KHÔNG tạo job mới).
    if (info.changes === 0) {
      const existing = db
        .prepare('SELECT id, status FROM debt_notification_jobs WHERE idempotency_key = ?')
        .get(key);
      logger.info('[NOTIFY_JOB] Job trùng — không tạo lại', {
        key,
        jobId: existing ? existing.id : null,
        status: existing ? existing.status : null,
      });
      return {
        success: true,
        jobId: existing ? existing.id : null,
        status: existing ? existing.status : JOB_STATUS.QUEUED,
        groupId: group.groupId,
        duplicate: true,
      };
    }

    const jobId = info.lastInsertRowid;
    logger.info('[NOTIFY_JOB] Đã tạo job thông báo', {
      jobId,
      customerId,
      eventType,
      groupId: group.groupId,
      provider,
    });

    return {
      success: true,
      jobId,
      status: JOB_STATUS.QUEUED,
      groupId: group.groupId,
    };
  } catch (e) {
    logger.error('[NOTIFY_JOB] enqueue error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Ghi job thông báo BÊN TRONG một transaction đang mở (transactional outbox).
 *
 * ⚠️ Vì sao cần?
 *  Nếu bút toán thanh toán và job thông báo nằm trong CÙNG transaction thì
 *  không thể xảy ra tình huống "payment đã commit nhưng job chưa tạo" →
 *  không cần cơ chế reconciliation phức tạp.
 *
 * @param {object} opts - giống enqueueJob
 * @returns {{success:boolean, jobId?:number, status?:string, error?:string}}
 */
function insertJobInTransaction(opts = {}) {
  try {
    return enqueueJob(opts);
  } catch (e) {
    logger.error('[NOTIFY_JOB] insertJobInTransaction error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/** Số lần retry tối đa (mặc định 5). */
function maxAttempts() {
  const v = parseInt(getSetting('debt_notify_retry_max_attempts', '5'), 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 20) : 5;
}

// ── Worker API ───────────────────────────────────────────────────────────────

/**
 * Lấy & LEASE các job đang chờ.
 *
 * Lease = đặt `status='processing'` + `locked_until` + `locked_by` trong MỘT
 * transaction → 2 worker không thể cùng xử lý 1 job.
 *
 * @param {object} opts { limit, workerId, leaseMs }
 * @returns {Array<object>} các job đã lease
 */
function leaseJobs(opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 10, 1), 50);
  const workerId = String(opts.workerId || `worker-${process.pid}`);
  const leaseMs = Math.min(
    Math.max(parseInt(opts.leaseMs, 10) || leaseMsDefault(), 5000),
    30 * 60 * 1000
  );
  const now = new Date();
  const nowIso = now.toISOString();
  const lockedUntil = new Date(now.getTime() + leaseMs).toISOString();

  let candidates = [];
  try {
    // Job sẵn sàng:
    //  - status = 'queued' (chờ) hoặc 'retry' (đã tới giờ thử lại)
    //  - next_retry_at NULL hoặc <= now
    //  - KHÔNG bị lock còn hiệu lực
    candidates = db
      .prepare(
        `SELECT id FROM debt_notification_jobs
          WHERE status IN ('queued', 'retry')
            AND (next_retry_at IS NULL OR next_retry_at <= ?)
            AND (locked_until IS NULL OR locked_until <= ?)
          ORDER BY created_at ASC, id ASC
          LIMIT ?`
      )
      .all(nowIso, nowIso, limit);
  } catch (e) {
    logger.error('[NOTIFY_JOB] leaseJobs scan error', { error: e.message });
    return [];
  }

  const leased = [];
  const leaseTx = db.transaction((ids) => {
    for (const id of ids) {
      const res = db
        .prepare(
          `UPDATE debt_notification_jobs
              SET status = 'processing',
                  locked_until = ?,
                  locked_by = ?,
                  attempts = attempts + 1,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND status IN ('queued', 'retry')
              AND (locked_until IS NULL OR locked_until <= ?)`
        )
        .run(lockedUntil, workerId, id, nowIso);
      if (res.changes === 1) {
        const job = db
          .prepare('SELECT * FROM debt_notification_jobs WHERE id = ?')
          .get(id);
        if (job) leased.push(job);
      }
    }
  });

  try {
    leaseTx(candidates.map((c) => c.id));
  } catch (e) {
    logger.error('[NOTIFY_JOB] leaseJobs error', { error: e.message });
    return [];
  }

  return leased;
}

/** Thời hạn lease mặc định (ms). */
function leaseMsDefault() {
  const v = parseInt(getSetting('debt_notify_job_lease_ms', '120000'), 10);
  return Number.isFinite(v) && v > 0 ? v : 120000;
}

/**
 * Đánh dấu job đã gửi thành công.
 */
function markSent(jobId, result = {}) {
  const id = parseInt(jobId, 10);
  if (!id) return false;
  try {
    db.prepare(
      `UPDATE debt_notification_jobs
          SET status = 'sent',
              provider_message_id = ?,
              delivery_status = ?,
              sent_at = CURRENT_TIMESTAMP,
              last_error = NULL,
              last_error_code = NULL,
              locked_until = NULL,
              locked_by = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(
      result.providerMessageId || null,
      result.deliveryStatus || 'accepted',
      id
    );
    return true;
  } catch (e) {
    logger.error('[NOTIFY_JOB] markSent error', { error: e.message });
    return false;
  }
}

/**
 * Đánh dấu job thất bại (retry hoặc failed).
 * @param {number} jobId
 * @param {object} result ProviderResult
 * @param {number} jobAttempts - số lần đã thử (đã tính ở lease)
 */
function markFailed(jobId, result = {}, jobAttempts = 0) {
  const id = parseInt(jobId, 10);
  if (!id) return false;

  const deliveryStatus = result.deliveryStatus || 'failed';
  const attempts = Math.max(parseInt(jobAttempts, 10) || 0, 0);
  const limit = maxAttempts();

  try {
    // Trạng thái 'unknown' → KHÔNG retry mù (nguy cơ gửi trùng).
    if (deliveryStatus === 'unknown') {
      db.prepare(
        `UPDATE debt_notification_jobs
            SET status = 'unknown',
                last_error = ?,
                last_error_code = ?,
                delivery_status = ?,
                locked_until = NULL,
                locked_by = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(result.errorMessage || 'Không xác định kết quả', result.errorCode || null, deliveryStatus, id);
      return true;
    }

    const canRetry = result.retryable !== false && attempts < limit;
    if (canRetry) {
      const delay = backoffDelayMs(attempts);
      const nextRetryAt = new Date(Date.now() + delay).toISOString();
      db.prepare(
        `UPDATE debt_notification_jobs
            SET status = 'retry',
                next_retry_at = ?,
                last_error = ?,
                last_error_code = ?,
                delivery_status = ?,
                locked_until = NULL,
                locked_by = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(
        nextRetryAt,
        result.errorMessage || 'Gửi thất bại',
        result.errorCode || null,
        deliveryStatus,
        id
      );
      logger.warn('[NOTIFY_JOB] Job sẽ thử lại', {
        jobId: id,
        attempts,
        delayMs: delay,
        error: result.errorMessage,
      });
      return true;
    }

    db.prepare(
      `UPDATE debt_notification_jobs
          SET status = 'failed',
              last_error = ?,
              last_error_code = ?,
              delivery_status = ?,
              locked_until = NULL,
              locked_by = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(result.errorMessage || 'Gửi thất bại', result.errorCode || null, deliveryStatus, id);
    logger.error('[NOTIFY_JOB] Job thất bại vĩnh viễn', {
      jobId: id,
      attempts,
      error: result.errorMessage,
    });
    return true;
  } catch (e) {
    logger.error('[NOTIFY_JOB] markFailed error', { error: e.message });
    return false;
  }
}

/**
 * Độ trễ retry theo exponential backoff.
 * Lần 1: 1 phút · 2: 5 phút · 3: 15 phút · 4: 60 phút · 5: 180 phút
 */
function backoffDelayMs(attempt) {
  const base = Math.max(parseInt(getSetting('debt_notify_retry_base_delay_ms', '60000'), 10) || 60000, 1000);
  // Hệ số: 1, 5, 15, 60, 180 (nhân với base/60_000 để giữ đúng ngữ nghĩa
  // khi base được cấu hình khác).
  const factors = [1, 5, 15, 60, 180];
  const idx = Math.min(Math.max(attempt - 1, 0), factors.length - 1);
  const unit = Math.min(base, 60000);
  return unit * factors[idx];
}

/**
 * Huỷ job (quản trị) — không xoá, chỉ đổi trạng thái.
 */
function cancelJob(jobId, reason = '') {
  const id = parseInt(jobId, 10);
  if (!id) return { success: false, error: 'jobId không hợp lệ' };
  try {
    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(id);
    if (!job) return { success: false, error: 'Không tìm thấy job' };
    if (TERMINAL_STATUSES.includes(job.status)) {
      return {
        success: false,
        error: `Không thể huỷ job đang ở trạng thái "${job.status}"`,
      };
    }
    db.prepare(
      `UPDATE debt_notification_jobs
          SET status = 'cancelled',
              last_error = ?,
              locked_until = NULL,
              locked_by = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(reason || 'Huỷ bởi quản trị', id);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Đưa job về hàng đợi để gửi lại (thao tác quản trị).
 *
 * ⚠️ QUY TẮC:
 *  - Job 'sent' → KHÔNG cho gửi lại (tránh gửi trùng).
 *  - Job 'unknown' → cần xác minh trước → `force: true` mới cho phép.
 *  - Job 'failed' → cho phép gửi lại (reset attempts).
 */
function retryJob(jobId, opts = {}) {
  const id = parseInt(jobId, 10);
  if (!id) return { success: false, error: 'jobId không hợp lệ' };
  try {
    const job = db.prepare('SELECT * FROM debt_notification_jobs WHERE id = ?').get(id);
    if (!job) return { success: false, error: 'Không tìm thấy job' };

    if (job.status === JOB_STATUS.SENT) {
      return {
        success: false,
        error: 'Thông báo đã gửi thành công — không thể gửi lại (tránh gửi trùng)',
      };
    }
    if (job.status === JOB_STATUS.CANCELLED) {
      return { success: false, error: 'Job đã bị huỷ' };
    }
    if (job.status === JOB_STATUS.UNKNOWN && !opts.force) {
      return {
        success: false,
        error:
          'Trạng thái "không xác định" — tin có thể đã gửi. Cần xác minh trước khi gửi lại.',
        code: 'REQUIRES_VERIFICATION',
      };
    }

    db.prepare(
      `UPDATE debt_notification_jobs
          SET status = 'queued',
              attempts = 0,
              next_retry_at = NULL,
              last_error = NULL,
              last_error_code = NULL,
              locked_until = NULL,
              locked_by = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(id);

    logger.info('[NOTIFY_JOB] Job được đưa lại vào hàng đợi', { jobId: id, force: !!opts.force });
    return { success: true, jobId: id };
  } catch (e) {
    logger.error('[NOTIFY_JOB] retryJob error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Phục hồi job bị kẹt (worker chết giữa chừng → lease hết hạn).
 * Job 'processing' mà `locked_until` đã qua → về 'queued'.
 * @returns {number} số job được phục hồi
 */
function recoverStaleJobs() {
  const nowIso = new Date().toISOString();
  try {
    const res = db
      .prepare(
        `UPDATE debt_notification_jobs
            SET status = 'queued',
                locked_until = NULL,
                locked_by = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE status = 'processing'
            AND locked_until IS NOT NULL
            AND locked_until <= ?`
      )
      .run(nowIso);
    if (res.changes > 0) {
      logger.warn('[NOTIFY_JOB] Đã phục hồi job bị kẹt (lease hết hạn)', {
        count: res.changes,
      });
    }
    return res.changes;
  } catch (e) {
    logger.error('[NOTIFY_JOB] recoverStaleJobs error', { error: e.message });
    return 0;
  }
}

/**
 * Liệt kê job (cho UI).
 */
function listJobs(filters = {}) {
  const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);
  const where = [];
  const params = [];

  if (filters.status) {
    const statuses = String(filters.status)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (statuses.length) {
      where.push(`j.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
  }
  if (filters.customerId) {
    where.push('j.customer_id = ?');
    params.push(parseInt(filters.customerId, 10));
  }
  if (filters.transactionId) {
    where.push('j.transaction_id = ?');
    params.push(parseInt(filters.transactionId, 10));
  }
  if (filters.provider) {
    where.push('j.provider = ?');
    params.push(String(filters.provider));
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const items = db
      .prepare(
        `SELECT j.*, c.name AS customer_ref_name
           FROM debt_notification_jobs j
           LEFT JOIN customers c ON c.id = j.customer_id
           ${whereSql}
          ORDER BY j.id DESC
          LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);
    const total = db
      .prepare(`SELECT COUNT(*) AS c FROM debt_notification_jobs j ${whereSql}`)
      .get(...params);
    return { items, total: total ? total.c : 0, limit, offset };
  } catch (e) {
    logger.error('[NOTIFY_JOB] listJobs error', { error: e.message });
    return { items: [], total: 0, limit, offset };
  }
}

/**
 * Thống kê nhanh theo trạng thái.
 */
function getSummary() {
  try {
    const rows = db
      .prepare('SELECT status, COUNT(*) AS c FROM debt_notification_jobs GROUP BY status')
      .all();
    const out = {
      total: 0,
      queued: 0,
      processing: 0,
      sent: 0,
      retry: 0,
      failed: 0,
      no_group: 0,
      cancelled: 0,
      unknown: 0,
    };
    for (const r of rows) {
      out.total += r.c;
      if (Object.prototype.hasOwnProperty.call(out, r.status)) out[r.status] = r.c;
    }
    return out;
  } catch (e) {
    logger.error('[NOTIFY_JOB] getSummary error', { error: e.message });
    return {
      total: 0,
      queued: 0,
      processing: 0,
      sent: 0,
      retry: 0,
      failed: 0,
      no_group: 0,
      cancelled: 0,
      unknown: 0,
    };
  }
}

/**
 * Job đã có bản ghi lịch sử (debt_notifications) chưa?
 * Dùng để tránh ghi lịch sử trùng.
 */
function hasHistoryRow(jobId) {
  try {
    const row = db
      .prepare('SELECT id FROM debt_notifications WHERE job_id = ? LIMIT 1')
      .get(parseInt(jobId, 10));
    return !!row;
  } catch (_) {
    return false;
  }
}

module.exports = {
  JOB_STATUS,
  JOB_EVENT_TYPES,
  TERMINAL_STATUSES,
  buildIdempotencyKey,
  findCustomerGroup,
  enqueueJob,
  insertJobInTransaction,
  leaseJobs,
  markSent,
  markFailed,
  cancelJob,
  retryJob,
  recoverStaleJobs,
  listJobs,
  getSummary,
  hasHistoryRow,
  maxAttempts,
  backoffDelayMs,
  leaseMsDefault,
};
