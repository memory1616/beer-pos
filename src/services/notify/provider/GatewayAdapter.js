/**
 * GatewayAdapter — Bọc BeerPOS Zalo Gateway thành Notification Provider
 * ─────────────────────────────────────────────────────────────────────────────
 * MỤC TIÊU:
 *  Cho phép chuyển kênh gửi thông báo từ OmniCall sang Gateway CHỈ BẰNG CẤU HÌNH
 *  (`settings.debt_notify_provider = 'gateway'`), không sửa logic nghiệp vụ.
 *
 * ⚠️ VÌ SAO ADAPTER NÀY "HẸP" HƠN CÁC ADAPTER KHÁC:
 *  Gateway là một dịch vụ HTTP RIÊNG BIỆT có hàng đợi, worker và provider riêng.
 *  Vì vậy adapter KHÔNG gọi "gửi tin" theo nghĩa đen — nó chỉ BÀN GIAO
 *  yêu cầu (enqueue) và trả về trạng thái "đã tiếp nhận". Gateway tự lo
 *  phần còn lại (worker, retry, lịch sử).
 *
 *  ⚠️ KHÔNG KHẲNG ĐỊNH QUÁ MỨC:
 *  Gateway trả `accepted` = "đã nhận yêu cầu, sẽ xử lý sau".
 *  KHÔNG được ghi `deliveryStatus = 'delivered'` cho tới khi Gateway có API
 *  đối soát xác nhận giao hàng thật.
 *
 * ⚠️ AN TOÀN DỮ LIỆU:
 *  - Khách chưa có group → Gateway trả 404 `CUSTOMER_GROUP_NOT_LINKED` →
 *    đây là lỗi VĨNH VIỄN (không retry mù).
 *  - Gateway offline / timeout → `retryable = true` → job trong BeerPOS vào
 *    trạng thái `retry` theo backoff sẵn có. Giao dịch thanh toán KHÔNG bị ảnh
 *    hưởng (vì lỗi xảy ra ngoài transaction).
 */

const GatewayClient = require('../GatewayClient');
const logger = require('../../../utils/logger');
const {
  BaseNotificationProvider,
  DELIVERY_STATUS,
  ERROR_CODES,
  makeResult,
  makeUnknownResult,
} = require('./NotificationProvider');

/**
 * Phân loại lỗi Gateway → errorCode + retryable.
 *
 * @param {object} res - kết quả từ GatewayClient
 * @returns {{errorCode:string, retryable:boolean, unknown?:boolean}}
 */
function classifyGatewayError(res = {}) {
  const status = res.status || 0;
  const code = res.code || '';

  // Không cấu hình → lỗi VĨNH VIỄN (admin phải cấu hình).
  if (code === 'GATEWAY_NOT_CONFIGURED') {
    return { errorCode: ERROR_CODES.CONFIG_ERROR, retryable: false };
  }

  // Lỗi mạng.
  //  - TIMEOUT → Gateway có thể đã nhận → KHÔNG xác định kết quả → KHÔNG retry mù.
  //  - Kết nối thất bại (refused / DNS / down) → Gateway CHƯA nhận → retry an toàn.
  if (res.networkError) {
    if (res.timeout) {
      return { errorCode: ERROR_CODES.TIMEOUT, retryable: false, unknown: true };
    }
    return { errorCode: ERROR_CODES.TEMPORARY_ERROR, retryable: true };
  }

  // Gateway chưa liên kết nhóm → VĨNH VIỄN.
  if (status === 404 || code === 'CUSTOMER_GROUP_NOT_LINKED') {
    return { errorCode: ERROR_CODES.INVALID_GROUP, retryable: false };
  }

  // Lỗi tham số / payload → VĨNH VIỄN.
  if (status === 400 || status === 422 || code === 'VALIDATION_ERROR') {
    return { errorCode: ERROR_CODES.INVALID_CONTENT, retryable: false };
  }

  // Xung đột (trùng idempotency, group đã thuộc khách khác...) → VĨNH VIỄN.
  if (status === 409) {
    return { errorCode: ERROR_CODES.INVALID_CONTENT, retryable: false };
  }

  // Quyền → VĨNH VIỄN.
  if (status === 401 || status === 403) {
    return { errorCode: ERROR_CODES.PERMISSION_DENIED, retryable: false };
  }

  // Rate limit → TẠM THỜI.
  if (status === 429) {
    return { errorCode: ERROR_CODES.TEMPORARY_ERROR, retryable: true };
  }

  // 5xx → TẠM THỜI (Gateway có thể lỗi nội bộ, job chưa chắc đã tạo).
  if (status >= 500) {
    return { errorCode: ERROR_CODES.TEMPORARY_ERROR, retryable: true };
  }

  return { errorCode: ERROR_CODES.UNKNOWN_ERROR, retryable: true };
}

/**
 * Adapter Gateway.
 */
class GatewayAdapter extends BaseNotificationProvider {
  constructor(opts = {}) {
    super({
      name: 'gateway',
      available: true,
      reason: 'BeerPOS Zalo Gateway (dịch vụ độc lập, hàng đợi bền vững).',
    });
    this.client = opts.client || GatewayClient;
  }

  /**
   * Bàn giao yêu cầu gửi tin cho Gateway.
   *
   * @param {object} msg { customerId, paymentId, text, idempotencyKey }
   * @returns {Promise<ProviderResult>}
   */
  async sendMessage(msg = {}) {
    const customerId = String(msg.customerId || '').trim();
    const text = String(msg.text || '').trim();

    if (!customerId) {
      return makeResult({
        success: false,
        errorCode: ERROR_CODES.INVALID_CONTENT,
        errorMessage: 'Thiếu customerId để tra cứu nhóm Zalo',
        retryable: false,
      });
    }
    if (!text) {
      return makeResult({
        success: false,
        errorCode: ERROR_CODES.INVALID_CONTENT,
        errorMessage: 'Thiếu nội dung tin nhắn',
        retryable: false,
      });
    }

    // Idempotency key bắt buộc — Gateway chặn trùng.
    const idempotencyKey = String(
      msg.idempotencyKey || `gateway-notification:${msg.paymentId || customerId}`
    ).trim();

    let res;
    try {
      res = await this.client.sendMessage(
        { paymentId: msg.paymentId || null, customerId, message: text },
        idempotencyKey
      );
    } catch (e) {
      // GatewayClient không bao giờ throw, nhưng bọc để adapter an toàn tuyệt đối.
      logger.error('[NOTIFY_GATEWAY] sendMessage exception', { error: e.message });
      return makeResult({
        success: false,
        errorCode: ERROR_CODES.UNKNOWN_ERROR,
        errorMessage: e.message,
        retryable: true,
      });
    }

    if (res && res.ok) {
      logger.info('[NOTIFY_GATEWAY] Gateway đã tiếp nhận yêu cầu gửi tin', {
        jobId: res.jobId,
        customerId,
        status: res.status,
        duplicate: !!res.duplicate,
      });
      return makeResult({
        success: true,
        providerMessageId: res.jobId ? `gw_job_${res.jobId}` : null,
        acceptedAt: new Date().toISOString(),
        // ⚠️ Gateway mới chỉ "tiếp nhận" — KHÔNG phải 'delivered'.
        deliveryStatus: DELIVERY_STATUS.ACCEPTED,
        raw: {
          gatewayJobId: res.jobId || null,
          gatewayStatus: res.status || null,
          duplicate: !!res.duplicate,
        },
      });
    }

    const cls = classifyGatewayError(res || {});
    const errorText = (res && res.error) || 'Gateway không nhận yêu cầu';

    if (cls.unknown) {
      // Không xác định được → KHÔNG retry mù (nguy cơ gửi trùng).
      return makeUnknownResult({
        errorCode: cls.errorCode,
        errorMessage: errorText,
        raw: { status: res && res.status, code: res && res.code },
      });
    }

    return makeResult({
      success: false,
      errorCode: cls.errorCode,
      errorMessage: errorText,
      retryable: cls.retryable,
      raw: { status: res && res.status, code: res && res.code },
    });
  }

  /** Kiểm tra Gateway còn sống không. */
  async testConnection() {
    const res = await this.client.health();
    return {
      success: !!res.success,
      provider: this.name,
      available: this.available,
      message: res.success
        ? `Gateway sẵn sàng (${res.baseUrl})`
        : `Không kết nối được Gateway (${res.baseUrl})`,
      checkedAt: new Date().toISOString(),
      baseUrl: res.baseUrl,
    };
  }

  getProviderStatus() {
    const cfg = this.client.getConfig();
    return {
      provider: this.name,
      available: this.available,
      reason: 'BeerPOS Zalo Gateway (dịch vụ độc lập, hàng đợi bền vững).',
      simulated: false,
      configured: cfg.configured,
      baseUrl: cfg.baseUrl,
      features: {
        sendMessage: true,
        testConnection: true,
        // Gateway hiện tại KHÔNG có API đối soát giao hàng.
        deliveryConfirmation: false,
      },
    };
  }
}

module.exports = { GatewayAdapter, classifyGatewayError };
