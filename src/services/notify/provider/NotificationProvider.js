/**
 * NotificationProvider — Interface thống nhất cho mọi phương thức gửi tin
 * ─────────────────────────────────────────────────────────────────────────────
 * MỤC TIÊU:
 *  Tách "nghiệp vụ công nợ" khỏi "phương thức gửi tin". DebtNotifyService và
 *  NotificationWorker chỉ biết interface này → đổi nhà cung cấp (OmniCall →
 *  Zalo OA chính thức → nhà cung cấp khác) KHÔNG phải sửa nghiệp vụ công nợ.
 *
 * HỢP ĐỒNG (contract):
 *  - `sendMessage({ groupId, text, ... })` → Promise<ProviderResult>
 *  - `testConnection()`                     → Promise<ProviderStatus>
 *  - `getProviderStatus()`                 → ProviderStatus (đồng bộ)
 *
 * CHUẨN HOÁ KẾT QUẢ (ProviderResult):
 *  {
 *    success: boolean,
 *    providerMessageId: string|null,   // id do provider cấp (nếu có)
 *    errorCode: string|null,           // mã lỗi chuẩn hoá
 *    errorMessage: string|null,        // mô tả lỗi cho người dùng
 *    acceptedAt: string|null,          // thời điểm provider nhận yêu cầu
 *    deliveryStatus: string,           // 'accepted' | 'delivered' | 'failed' | 'unknown'
 *    retryable: boolean,               // lỗi TẠM THỜI (được retry) hay VĨNH VIỄN
 *    raw: any                          // payload gốc của provider (KHÔNG chứa secret)
 *  }
 *
 * ⚠️ NGUYÊN TẮC "KHÔNG KHẲNG ĐỊNH QUÁ MỨC":
 *  Provider chỉ xác nhận "đã tiếp nhận yêu cầu" (`accepted`) thì KHÔNG được
 *  ghi `deliveryStatus = 'delivered'`. Chỉ khi provider có API đối soát trạng
 *  thái mới được ghi 'delivered'.
 *
 * ⚠️ NGUYÊN TẮC AN TOÀN:
 *  - Adapter KHÔNG BAO GIỜ được log token/credential.
 *  - Adapter KHÔNG BAO GIỜ được ném exception ra ngoài (luôn trả về object kết
 *    quả) → đảm bảo lỗi provider không làm hỏng nghiệp vụ thanh toán.
 */

const logger = require('../../../utils/logger');

// ── Delivery status chuẩn hoá ────────────────────────────────────────────────
const DELIVERY_STATUS = {
  /** Provider đã nhận yêu cầu (chưa chắc đã tới nhóm). */
  ACCEPTED: 'accepted',
  /** Provider xác nhận đã gửi tới đích (chỉ khi provider hỗ trợ xác nhận). */
  DELIVERED: 'delivered',
  /** Gửi thất bại, đã biết chắc. */
  FAILED: 'failed',
  /** Không xác định được (VD timeout sau khi provider có thể đã nhận). */
  UNKNOWN: 'unknown',
};

// ── Error code chuẩn hoá ──────────────────────────────────────────────────────
const ERROR_CODES = {
  /** Thiếu cấu hình (API key, base URL...) → lỗi VĨNH VIỄN, không retry. */
  CONFIG_ERROR: 'CONFIG_ERROR',
  /** Không có group id hợp lệ → lỗi VĨNH VIỄN. */
  INVALID_GROUP: 'INVALID_GROUP',
  /** Provider từ chối do quyền (401/403) → lỗi VĨNH VIỄN. */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** Provider trả lỗi tạm thời (5xx, rate limit) → ĐƯỢC retry. */
  TEMPORARY_ERROR: 'TEMPORARY_ERROR',
  /** Timeout / mất mạng → không chắc provider đã nhận → 'unknown'. */
  TIMEOUT: 'TIMEOUT',
  /** Nội dung không hợp lệ → lỗi VĨNH VIỄN. */
  INVALID_CONTENT: 'INVALID_CONTENT',
  /** Lỗi không phân loại được → coi là tạm thời (an toàn: retry có kiểm soát). */
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
};

/**
 * Tạo ProviderResult chuẩn hoá.
 * @param {object} opts
 */
function makeResult(opts = {}) {
  const success = !!opts.success;
  return {
    success,
    providerMessageId: opts.providerMessageId || null,
    errorCode: success ? null : opts.errorCode || ERROR_CODES.UNKNOWN_ERROR,
    errorMessage: success ? null : opts.errorMessage || null,
    acceptedAt: opts.acceptedAt || null,
    deliveryStatus:
      opts.deliveryStatus || (success ? DELIVERY_STATUS.ACCEPTED : DELIVERY_STATUS.FAILED),
    retryable: success ? false : opts.retryable !== undefined ? !!opts.retryable : true,
    raw: opts.raw === undefined ? null : opts.raw,
  };
}

/**
 * ProviderResult cho trường hợp "không xác định được kết quả".
 * ⚠️ KHÔNG được retry mù trạng thái này (nguy cơ gửi trùng).
 */
function makeUnknownResult(opts = {}) {
  return makeResult({
    success: false,
    errorCode: opts.errorCode || ERROR_CODES.TIMEOUT,
    errorMessage: opts.errorMessage || 'Không xác định được kết quả gửi tin',
    deliveryStatus: DELIVERY_STATUS.UNKNOWN,
    retryable: false,
    raw: opts.raw === undefined ? null : opts.raw,
  });
}

/**
 * Base class cho adapter — cung cấp hành vi mặc định an toàn.
 * Adapter con override `sendMessage()`.
 */
class BaseNotificationProvider {
  /**
   * @param {object} opts
   * @param {string} opts.name        - tên provider (dùng làm `provider` trong DB)
   * @param {boolean} [opts.available] - provider có dùng được không
   */
  constructor(opts = {}) {
    this.name = opts.name || 'base';
    this.available = opts.available !== false;
    this.reason = opts.reason || '';
  }

  /**
   * Gửi tin nhắn tới 1 nhóm.
   * @param {object} _msg { groupId, text, groupName, ... }
   * @returns {Promise<import('./index').ProviderResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async sendMessage(_msg) {
    return makeResult({
      success: false,
      errorCode: ERROR_CODES.CONFIG_ERROR,
      errorMessage: 'Provider chưa cài đặt sendMessage()',
      retryable: false,
    });
  }

  /** Kiểm tra kết nối tới provider. */
  async testConnection() {
    return {
      success: false,
      provider: this.name,
      available: this.available,
      message: this.reason || 'Provider không hỗ trợ kiểm tra kết nối',
      checkedAt: new Date().toISOString(),
    };
  }

  /** Thông tin trạng thái (không chứa secret). */
  getProviderStatus() {
    return {
      provider: this.name,
      available: this.available,
      reason: this.reason,
      features: {
        sendMessage: true,
        testConnection: true,
        deliveryConfirmation: false,
      },
    };
  }
}

module.exports = {
  DELIVERY_STATUS,
  ERROR_CODES,
  BaseNotificationProvider,
  makeResult,
  makeUnknownResult,
};
