/**
 * OmniCallAdapter — Bọc dịch vụ OmniCall hiện tại thành Notification Provider
 * ─────────────────────────────────────────────────────────────────────────────
 * MỤC TIÊU:
 *  Giữ nguyên toàn bộ hành vi của `OmiCallService` (đã được kiểm chứng thực tế
 *  với server OmniCall production) nhưng đưa nó về đúng interface
 *  `NotificationProvider` để có thể hoán đổi nhà cung cấp.
 *
 * ⚠️ KHÔNG sửa logic gửi tin của OmiCallService — chỉ chuẩn hoá kết quả trả về
 *    sang ProviderResult. `OmiCallService.js` giữ nguyên vị trí & API.
 *
 * ⚠️ VỀ KHẢ NĂNG XÁC NHẬN:
 *  OmniCall trả `status_code: 9999` khi ĐÃ TIẾP NHẬN yêu cầu gửi tin.
 *  Không có API đối soát trạng thái giao hàng → `deliveryStatus` CHỈ có thể là
 *  'accepted' (KHÔNG BAO GIỜ 'delivered').
 */

const OmiCallService = require('../../OmiCallService');
const logger = require('../../../utils/logger');
const {
  BaseNotificationProvider,
  DELIVERY_STATUS,
  ERROR_CODES,
  makeResult,
  makeUnknownResult,
} = require('./NotificationProvider');

/**
 * Phân loại lỗi OmniCall → errorCode chuẩn hoá + retryable.
 */
function classifyOmicallError(errorText) {
  const msg = String(errorText || '').toLowerCase();

  // Lỗi quyền / cấu hình → VĨNH VIỄN, không retry.
  if (
    /api key|api_key|chưa cấu hình|unauthorized|forbidden|not permision|permission|tenant/.test(msg)
  ) {
    return { errorCode: ERROR_CODES.PERMISSION_DENIED, retryable: false };
  }
  // Lỗi tham số / nội dung → VĨNH VIỄN.
  if (/invalid_param|thiếu|không tìm được endpoint|conv not found/.test(msg)) {
    return { errorCode: ERROR_CODES.INVALID_CONTENT, retryable: false };
  }
  // Timeout / mất mạng → KHÔNG xác định được → 'unknown', không retry mù.
  if (/timeout|aborted|không gọi được|econnrefused|enotfound|fetch failed/.test(msg)) {
    return { errorCode: ERROR_CODES.TIMEOUT, retryable: false, unknown: true };
  }
  // Lỗi tạm thời từ phía provider (error_occurred, 5xx) → ĐƯỢC retry.
  if (/error_occurred|server error|http 5\d\d|temporar|busy|rate limit|429/.test(msg)) {
    return { errorCode: ERROR_CODES.TEMPORARY_ERROR, retryable: true };
  }

  return { errorCode: ERROR_CODES.UNKNOWN_ERROR, retryable: true };
}

/**
 * Adapter OmniCall.
 */
class OmniCallAdapter extends BaseNotificationProvider {
  constructor(opts = {}) {
    super({
      name: 'omicall',
      available: true,
      reason: 'Kênh Zalo Personal multi-channel qua OmniCall.',
    });
    this.service = opts.service || OmiCallService;
  }

  /**
   * Gửi tin nhắn vào nhóm Zalo qua OmniCall.
   * @param {object} msg { groupId, text, groupName }
   * @returns {Promise<ProviderResult>}
   */
  async sendMessage(msg = {}) {
    const groupId = String(msg.groupId || '').trim();
    const text = String(msg.text || '').trim();

    if (!groupId) {
      return makeResult({
        success: false,
        errorCode: ERROR_CODES.INVALID_GROUP,
        errorMessage: 'Thiếu Group ID (convId của nhóm Zalo)',
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

    let res;
    try {
      res = await this.service.sendZaloPersonalMessage({
        convId: groupId,
        text,
        groupName: msg.groupName || null,
      });
    } catch (e) {
      // OmiCallService nên tự bắt lỗi, nhưng bọc thêm để adapter KHÔNG BAO GIỜ throw.
      logger.error('[NOTIFY_OMICALL] sendMessage exception', { error: e.message });
      return makeResult({
        success: false,
        errorCode: ERROR_CODES.UNKNOWN_ERROR,
        errorMessage: e.message,
        retryable: true,
      });
    }

    if (res && res.success) {
      return makeResult({
        success: true,
        providerMessageId: res.messageId || null,
        acceptedAt: new Date().toISOString(),
        // ⚠️ OmniCall không có API đối soát giao hàng → chỉ 'accepted'.
        deliveryStatus: DELIVERY_STATUS.ACCEPTED,
        raw: { healedFrom: res.healedFrom || null, healedTo: res.healedTo || null },
      });
    }

    const errorText = (res && res.error) || 'Gửi tin OmniCall thất bại';
    const cls = classifyOmicallError(errorText);

    if (cls.unknown) {
      return makeUnknownResult({
        errorCode: cls.errorCode,
        errorMessage: errorText,
        raw: { hint: (res && res.hint) || null },
      });
    }

    return makeResult({
      success: false,
      errorCode: cls.errorCode,
      errorMessage: errorText,
      retryable: cls.retryable,
      raw: { hint: (res && res.hint) || null },
    });
  }

  /** Kiểm tra kết nối tới OmniCall (lấy access token). */
  async testConnection(opts = {}) {
    try {
      const res = await this.service.testConnection(opts.config || opts);
      return {
        success: !!res.success,
        provider: this.name,
        available: this.available,
        message: res.success
          ? 'Kết nối OmniCall thành công'
          : res.error || 'Không kết nối được OmniCall',
        checkedAt: new Date().toISOString(),
      };
    } catch (e) {
      return {
        success: false,
        provider: this.name,
        available: this.available,
        message: e.message,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  getProviderStatus() {
    const cfg = this.service.getPublicConfig();
    return {
      provider: this.name,
      available: this.available,
      reason: 'Kênh Zalo Personal multi-channel qua OmniCall.',
      simulated: false,
      configured: !!cfg.hasApiKey,
      baseUrl: cfg.baseUrl,
      features: {
        sendMessage: true,
        testConnection: true,
        // OmniCall KHÔNG có API đối soát trạng thái giao hàng.
        deliveryConfirmation: false,
      },
    };
  }
}

module.exports = { OmniCallAdapter, classifyOmicallError };
