const JobRepository = require('../database/repositories/JobRepository');
const MessageRepository = require('../database/repositories/MessageRepository');
const AuditService = require('./AuditService');
const { badRequest, conflict, notFound } = require('../utils/errors');

const { JOB_STATUS } = JobRepository;
const { AUDIT_ACTIONS } = AuditService;

/** Trang thai cho phep retry thu cong. */
const RETRYABLE_STATUSES = [JOB_STATUS.FAILED, JOB_STATUS.NO_GROUP, JOB_STATUS.CANCELLED];

/** Trang thai cho phep huy. */
const CANCELLABLE_STATUSES = [JOB_STATUS.QUEUED, JOB_STATUS.RETRY];

class QueueService {
  constructor(repos) {
    this.jobs = (repos && repos.jobs) || new JobRepository();
    this.messages = (repos && repos.messages) || new MessageRepository();
    this.audit = (repos && repos.audit) || new AuditService();
  }

  /**
   * Tao job moi. Neu idempotency_key da ton tai -> tra job cu (khong tao moi).
   * @param {object} row
   * @returns {{job: object, created: boolean}}
   */
  enqueue(row) {
    const key = String(row.idempotencyKey || '').trim();
    if (!key) {
      throw badRequest('Thieu Idempotency-Key', 'VALIDATION_ERROR');
    }

    const existing = this.jobs.findByIdempotencyKey(key);
    if (existing) return { job: existing, created: false };

    try {
      const job = this.jobs.insert({
        idempotencyKey: key,
        paymentId: row.paymentId,
        customerId: row.customerId,
        customerName: row.customerName,
        groupId: row.groupId,
        groupName: row.groupName,
        messageContent: row.messageContent,
        provider: row.provider,
        status: JOB_STATUS.QUEUED,
        maxAttempts: row.maxAttempts,
      });
      return { job, created: true };
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        // Race condition: 2 request cung idempotency key.
        const again = this.jobs.findByIdempotencyKey(key);
        if (again) return { job: again, created: false };
      }
      throw e;
    }
  }

  /** Lease job cho worker. */
  leaseJobs(opts = {}) {
    return this.jobs.leaseJobs(opts);
  }

  /** Job processing bi treo -> queued lai. */
  recoverStaleJobs() {
    return this.jobs.recoverStaleJobs();
  }

  /** Ghi log 1 lan thu gui. */
  logAttempt(row) {
    return this.messages.insert(row);
  }

  listAttempts(jobId) {
    return this.messages.listByJob(jobId);
  }

  markSent(id, opts = {}) {
    return this.jobs.markSent(id, opts);
  }

  markFailed(id, opts = {}) {
    return this.jobs.markFailed(id, opts);
  }

  markUnknown(id, opts = {}) {
    return this.jobs.markUnknown(id, opts);
  }

  markRetry(id, opts = {}) {
    return this.jobs.markRetry(id, opts);
  }

  getJob(id) {
    const job = this.jobs.findById(id);
    if (!job) throw notFound('Khong tim thay job', 'JOB_NOT_FOUND');
    return job;
  }

  list(opts = {}) {
    const res = this.jobs.list(opts);
    return {
      total: res.total,
      page: res.page,
      limit: res.limit,
      items: res.items.map((j) => this.toDto(j)),
    };
  }

  /**
   * Retry thu cong. KHONG cho retry job `unknown` (nguy co tin trung).
   */
  retry(id, opts = {}) {
    const job = this.getJob(id);

    if (job.status === JOB_STATUS.UNKNOWN) {
      throw conflict(
        'Job dang co trang thai khong xac dinh - khong the tu dong gui lai vi co nguy co tao tin trung. Can kiem tra thu cong.',
        'UNSAFE_RETRY'
      );
    }
    if (!RETRYABLE_STATUSES.includes(job.status)) {
      throw conflict(
        `Job dang o trang thai "${job.status}" - khong the retry`,
        'INVALID_STATE'
      );
    }

    const updated = this.jobs.requeue(id);
    this.audit.record({
      action: AUDIT_ACTIONS.JOB_RETRY,
      entityType: 'job',
      entityId: id,
      details: { from: job.status, to: updated.status, reason: opts.reason || null },
    });
    return this.toDto(updated);
  }

  /** Huy job chua duoc gui / chua bat dau xu ly. */
  cancel(id, opts = {}) {
    const job = this.getJob(id);

    if (!CANCELLABLE_STATUSES.includes(job.status)) {
      throw conflict(
        `Job dang o trang thai "${job.status}" - khong the huy`,
        'INVALID_STATE'
      );
    }

    const updated = this.jobs.cancel(id);
    this.audit.record({
      action: AUDIT_ACTIONS.JOB_CANCEL,
      entityType: 'job',
      entityId: id,
      details: { from: job.status, to: updated.status, reason: opts.reason || null },
    });
    return this.toDto(updated);
  }

  countsByStatus() {
    return this.jobs.countsByStatus();
  }

  toDto(job) {
    let providerResponse = null;
    if (job.provider_response) {
      try {
        providerResponse = JSON.parse(job.provider_response);
      } catch (_) {
        providerResponse = { raw: job.provider_response };
      }
    }
    return {
      id: job.id,
      idempotencyKey: job.idempotency_key,
      paymentId: job.payment_id,
      customerId: job.customer_id,
      customerName: job.customer_name,
      groupId: job.group_id,
      groupName: job.group_name,
      messageContent: job.message_content,
      provider: job.provider,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      nextRetryAt: job.next_retry_at,
      lastError: job.last_error,
      providerResponse,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      processedAt: job.processed_at,
      deliveryStatus:
        providerResponse && providerResponse.deliveryStatus ? providerResponse.deliveryStatus : null,
    };
  }
}

module.exports = QueueService;
module.exports.JOB_STATUS = JOB_STATUS;
module.exports.RETRYABLE_STATUSES = RETRYABLE_STATUSES;
module.exports.CANCELLABLE_STATUSES = CANCELLABLE_STATUSES;
