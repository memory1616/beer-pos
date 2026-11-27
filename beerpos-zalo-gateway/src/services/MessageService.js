const GroupService = require('./GroupService');
const QueueService = require('./QueueService');
const SettingsService = require('./SettingsService');
const { badRequest, notFound } = require('../utils/errors');
const { config } = require('../config');

/**
 * MessageService — tiep nhan yeu cau gui tin tu BeerPOS.
 *
 * KHONG gui tin trong HTTP request. Chi tao job.
 */
class MessageService {
  constructor(repos) {
    this.groups = (repos && repos.groups) || new GroupService();
    this.queue = (repos && repos.queue) || new QueueService();
    this.settings = (repos && repos.settings) || new SettingsService();
  }

  /**
   * Tiep nhan 1 tin nhan.
   * @param {object} payload { paymentId, customerId, message }
   * @param {string} idempotencyKey
   * @returns {{accepted:boolean, job:object, created:boolean}}
   */
  accept(payload = {}, idempotencyKey) {
    const key = String(idempotencyKey || '').trim();
    if (!key) {
      throw badRequest('Thieu header Idempotency-Key', 'VALIDATION_ERROR');
    }

    const customerId = String(payload.customerId || '').trim();
    if (!customerId) {
      throw badRequest('Thieu customerId', 'VALIDATION_ERROR');
    }
    if (customerId.length > config.limits.maxCustomerIdLength) {
      throw badRequest('customerId qua dai', 'VALIDATION_ERROR');
    }

    const message = String(payload.message === undefined ? '' : payload.message).trim();
    if (!message) {
      throw badRequest('Noi dung tin nhan khong duoc de trong', 'VALIDATION_ERROR');
    }
    const maxLen = this.settings.getMaxMessageLength();
    if (message.length > maxLen) {
      throw badRequest(
        `Noi dung tin nhan qua dai (toi da ${maxLen} ky tu)`,
        'VALIDATION_ERROR'
      );
    }

    const paymentId = payload.paymentId ? String(payload.paymentId).trim() : null;

    // Idempotency: neu key da ton tai -> tra job cu, KHONG tao moi.
    const existing = this.queue.jobs.findByIdempotencyKey(key);
    if (existing) {
      return { accepted: true, job: this.queue.toDto(existing), created: false };
    }

    // Tra mapping 1:1. Khong co mapping active -> bao loi ro rang.
    const group = this.groups.findActive(customerId);
    if (!group) {
      throw notFound(
        'Khach hang chua duoc lien ket nhom',
        'CUSTOMER_GROUP_NOT_LINKED',
        { accepted: false }
      );
    }

    const providerName = this.settings.getProviderName();
    const { job, created } = this.queue.enqueue({
      idempotencyKey: key,
      paymentId,
      customerId,
      customerName: group.customerName,
      // SNAPSHOT group_id + noi dung tai thoi diem tao job.
      groupId: group.groupId,
      groupName: group.groupName,
      messageContent: message,
      provider: providerName,
      maxAttempts: this.settings.getMaxAttempts(),
    });

    return { accepted: true, job: this.queue.toDto(job), created };
  }

  /** Lich su gui tin. */
  history(opts = {}) {
    return this.queue.list(opts);
  }

  /** Chi tiet job + cac lan thu. */
  jobDetail(id) {
    const job = this.queue.getJob(id);
    const attempts = this.queue.listAttempts(id).map((m) => ({
      id: m.id,
      provider: m.provider,
      status: m.status,
      errorMessage: m.error_message,
      requestPayload: m.request_payload ? JSON.parse(m.request_payload) : null,
      responsePayload: m.response_payload ? JSON.parse(m.response_payload) : null,
      startedAt: m.started_at,
      completedAt: m.completed_at,
      createdAt: m.created_at,
    }));
    return { job: this.queue.toDto(job), attempts };
  }
}

module.exports = MessageService;
