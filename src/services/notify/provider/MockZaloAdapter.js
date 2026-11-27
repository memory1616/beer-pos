/**
 * MockZaloAdapter — Provider MÔ PHỎNG cho LOCAL DEVELOPMENT
 * ─────────────────────────────────────────────────────────────────────────────
 * MỤC TIÊU:
 *  Cho phép kiểm thử TOÀN BỘ luồng thông báo công nợ (enqueue → worker →
 *  provider → lịch sử → retry) mà KHÔNG cần tài khoản OmniCall thật và KHÔNG
 *  gửi tin vào nhóm Zalo thật của khách.
 *
 * ⚠️ QUY TẮC TUYỆT ĐỐI:
 *  - Provider MÔ PHỎNG KHÔNG BAO GIỜ giả vờ rằng tin đã được gửi thật vào Zalo.
 *    - `providerMessageId` có tiền tố `mock_` → dễ nhận biết.
 *    - `deliveryStatus = 'accepted'` (KHÔNG phải 'delivered') vì provider thật
 *      chỉ xác nhận "đã tiếp nhận yêu cầu".
 *    - Mọi nội dung tin nhắn được ghi vào log local + bảng lịch sử để kiểm tra.
 *  - KHÔNG gọi bất kỳ API bên ngoài nào.
 *
 * KỊCH BẢN LỖI (mô phỏng được, dùng để test retry/failed/unknown):
 *  - Cấu hình qua `NOTIFICATION_MOCK_SCENARIO` (env) hoặc `settings`:
 *      • 'success'      (mặc định) — luôn thành công
 *      • 'temporary'    — lỗi tạm thời (được retry)
 *      • 'permanent'    — lỗi vĩnh viễn (không retry)
 *      • 'timeout'      — kết quả không xác định (unknown → KHÔNG retry mù)
 *      • 'invalid_group'— group id không hợp lệ (lỗi vĩnh viễn)
 *  - Có thể ép kịch bản cho 1 group cụ thể qua `mockScenarioByGroup`.
 */

const logger = require('../../../utils/logger');
const {
  BaseNotificationProvider,
  DELIVERY_STATUS,
  ERROR_CODES,
  makeResult,
  makeUnknownResult,
} = require('./NotificationProvider');

/** Các kịch bản lỗi được hỗ trợ. */
const SCENARIOS = {
  SUCCESS: 'success',
  TEMPORARY: 'temporary',
  PERMANENT: 'permanent',
  TIMEOUT: 'timeout',
  INVALID_GROUP: 'invalid_group',
};

const VALID_SCENARIOS = Object.values(SCENARIOS);

/**
 * Provider giả lập — dùng cho local dev & test.
 */
class MockZaloAdapter extends BaseNotificationProvider {
  constructor(opts = {}) {
    super({
      name: 'mock',
      available: true,
      reason: 'Provider mô phỏng (LOCAL) — tin nhắn KHÔNG được gửi vào Zalo thật.',
    });

    /** Kịch bản mặc định. */
    this.scenario = normalizeScenario(
      opts.scenario || process.env.NOTIFICATION_MOCK_SCENARIO || SCENARIOS.SUCCESS
    );
    /** Ghi đè kịch bản theo từng group id (dùng để test từng tình huống). */
    this.scenarioByGroup = new Map(Object.entries(opts.scenarioByGroup || {}));
    /** Số lần đã "gửi" (đếm để test idempotency). */
    this.sentCount = 0;
    /** Danh sách tin đã mô phỏng (giới hạn để không phình bộ nhớ). */
    this.outbox = [];
    this.maxOutbox = opts.maxOutbox || 200;
  }

  /** Đổi kịch bản mặc định (dùng trong test / UI). */
  setScenario(scenario) {
    const s = normalizeScenario(scenario);
    if (!s) return false;
    this.scenario = s;
    return true;
  }

  /** Ép kịch bản cho 1 group cụ thể. */
  setGroupScenario(groupId, scenario) {
    const s = normalizeScenario(scenario);
    if (!s || !groupId) return false;
    this.scenarioByGroup.set(String(groupId), s);
    return true;
  }

  /** Xoá ghi đè kịch bản theo group. */
  clearGroupScenario(groupId) {
    return this.scenarioByGroup.delete(String(groupId));
  }

  /** Bản ghi tin đã mô phỏng (để UI/local logs hiển thị). */
  getOutbox() {
    return this.outbox.slice();
  }

  /** Xoá outbox mô phỏng. */
  clearOutbox() {
    this.outbox = [];
  }

  /**
   * Mô phỏng gửi tin nhắn.
   * @param {object} msg { groupId, text, groupName, ... }
   * @returns {Promise<ProviderResult>}
   */
  async sendMessage(msg = {}) {
    const groupId = String(msg.groupId || '').trim();
    const text = String(msg.text || '').trim();

    if (!groupId) {
      return makeResult({
        success: false,
        errorCode: ERROR_CODES.INVALID_GROUP,
        errorMessage: 'Thiếu Group ID',
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

    const scenario = this.scenarioByGroup.get(groupId) || this.scenario;

    // ── Ghi log nội dung mô phỏng (LOCAL) ─────────────────────────────────
    const record = {
      at: new Date().toISOString(),
      groupId,
      groupName: msg.groupName || null,
      text,
      scenario,
    };
    this.outbox.push(record);
    if (this.outbox.length > this.maxOutbox) {
      this.outbox.shift();
    }
    logger.info('[NOTIFY_MOCK] Tin nhắn mô phỏng (KHÔNG gửi thật vào Zalo)', {
      groupId,
      groupName: record.groupName,
      scenario,
      preview: text.slice(0, 120),
    });

    // ── Xử lý theo kịch bản ──────────────────────────────────────────────
    switch (scenario) {
      case SCENARIOS.TEMPORARY:
        return makeResult({
          success: false,
          errorCode: ERROR_CODES.TEMPORARY_ERROR,
          errorMessage: '[MOCK] Lỗi tạm thời từ provider (sẽ được thử lại)',
          retryable: true,
          raw: record,
        });

      case SCENARIOS.PERMANENT:
        return makeResult({
          success: false,
          errorCode: ERROR_CODES.PERMISSION_DENIED,
          errorMessage: '[MOCK] Lỗi vĩnh viễn từ provider (không thử lại)',
          retryable: false,
          raw: record,
        });

      case SCENARIOS.TIMEOUT:
        // ⚠️ Timeout SAU khi provider có thể đã nhận → 'unknown', KHÔNG retry mù.
        return makeUnknownResult({
          errorCode: ERROR_CODES.TIMEOUT,
          errorMessage: '[MOCK] Timeout — không xác định được tin đã gửi hay chưa',
          raw: record,
        });

      case SCENARIOS.INVALID_GROUP:
        return makeResult({
          success: false,
          errorCode: ERROR_CODES.INVALID_GROUP,
          errorMessage: '[MOCK] Group ID không hợp lệ',
          retryable: false,
          raw: record,
        });

      case SCENARIOS.SUCCESS:
      default: {
        this.sentCount += 1;
        return makeResult({
          success: true,
          providerMessageId: `mock_${Date.now()}_${this.sentCount}`,
          acceptedAt: new Date().toISOString(),
          // ⚠️ Provider thật chỉ xác nhận "đã tiếp nhận" → KHÔNG ghi 'delivered'.
          deliveryStatus: DELIVERY_STATUS.ACCEPTED,
          raw: record,
        });
      }
    }
  }

  /** Kiểm tra kết nối — provider giả lập luôn "thành công". */
  async testConnection() {
    return {
      success: true,
      provider: this.name,
      available: true,
      message: 'Provider mô phỏng (LOCAL) — luôn sẵn sàng, không gọi mạng.',
      checkedAt: new Date().toISOString(),
      scenario: this.scenario,
    };
  }

  getProviderStatus() {
    return {
      provider: this.name,
      available: true,
      reason: 'Provider mô phỏng (LOCAL) — tin nhắn KHÔNG được gửi vào Zalo thật.',
      simulated: true,
      scenario: this.scenario,
      features: {
        sendMessage: true,
        testConnection: true,
        deliveryConfirmation: false,
      },
    };
  }
}

/** Chuẩn hoá tên kịch bản (trả về null nếu không hợp lệ). */
function normalizeScenario(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return null;
  if (VALID_SCENARIOS.includes(s)) return s;
  // Cho phép dùng 'error' làm bí danh của 'temporary'.
  if (s === 'error' || s === 'temp' || s === 'retryable') return SCENARIOS.TEMPORARY;
  if (s === 'fatal' || s === 'fail') return SCENARIOS.PERMANENT;
  return null;
}

module.exports = { MockZaloAdapter, SCENARIOS, normalizeScenario };
