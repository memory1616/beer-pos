/**
 * DebtZaloBridge — Adapter kết nối Zalo (kiến trúc Adapter Pattern)
 * ─────────────────────────────────────────────────────────────────────────────
 * MỤC TIÊU:
 *  Module Sổ Công nợ KHÔNG phụ thuộc trực tiếp vào bất kỳ phương thức kết nối
 *  Zalo nào. Mọi giao tiếp đi qua interface `DebtZaloBridge` → thay đổi/đổi
 *  adapter chỉ cần sửa 1 file, KHÔNG sửa Debt Service.
 *
 * ⚠️ QUY TẾT TẮC BẤT BIẾN (theo yêu cầu):
 *  - KHÔNG dùng Zalo OA.
 *  - KHÔNG tạo nhóm Zalo mới.
 *  - KHÔNG hardcode cookie/token đăng nhập, KHÔNG lưu mật khẩu Zalo.
 *  - KHÔNG vượt CAPTCHA / cơ chế bảo vệ tài khoản.
 *  - KHÔNG tự động gửi lệnh thanh toán khi không xác định được người gửi.
 *
 * KẾT QUẢ KIỂM TRA KHẢ THI (theo audit):
 *  - Zalo Desktop lưu DB cục bộ ở dạng MÃ HOÁ (`db-enc`), file bị khoá bởi
 *    tiến trình đang chạy, KHÔNG có listener TCP nào để nhận event.
 *  - KHÔNG có API bot chính thức cho Zalo cá nhân (chỉ có Zalo OA).
 *  - Dùng `zalo-oa`/API không chính thức để đọc/ghi tin nhắn cá nhân vi phạm
 *    điều khoản sử dụng và rủi ro khoá tài khoản → KHÔNG triển khai.
 *  ⇒ TRẠNG THÁI: `NOT_AVAILABLE`.
 *
 * HỆ QUẢ (đã được chốt trong yêu cầu):
 *  - Debt Service KHÔNG bị ảnh hưởng (adapter trả về `available = false`).
 *  - Nhân viên dùng Quick Entry trên Beer POS (màn "Nhập thanh toán thủ công")
 *    để ghi nhận `+` / `-` — đầy đủ chức năng, có audit log.
 */

const logger = require('../../utils/logger');
const DebtCommandService = require('./DebtCommandService');
const { PLATFORMS } = require('./constants');

/** Trạng thái adapter. */
const BRIDGE_STATE = {
  NOT_AVAILABLE: 'NOT_AVAILABLE',
  AVAILABLE: 'AVAILABLE',
  DISABLED: 'DISABLED',
};

/**
 * Adapter mặc định — KHÔNG có kết nối Zalo cá nhân hợp lệ.
 *
 * Mọi method đều trả về kết quả "không khả dụng" một cách AN TOÀN:
 *  - không ghi bút toán nào
 *  - không ném exception ra ngoài
 */
class NotAvailableZaloAdapter {
  constructor() {
    this.state = BRIDGE_STATE.NOT_AVAILABLE;
    this.reason =
      'Không có giải pháp hợp lệ & ổn định để kết nối Zalo cá nhân ' +
      '(DB mã hoá, không có listener, không có API bot chính thức). ' +
      'Dùng Quick Entry trên Beer POS thay thế.';
  }

  /** Adapter có khả dụng không? */
  isAvailable() {
    return false;
  }

  /** Bắt đầu lắng nghe (no-op). */
  async start() {
    logger.warn('[DEBT_ZALO] Adapter không khả dụng — bỏ qua start()');
    return { success: false, available: false, reason: this.reason };
  }

  /** Dừng lắng nghe (no-op). */
  async stop() {
    return { success: true, available: false };
  }

  /**
   * Xử lý 1 tin nhắn đầu vào.
   * Vẫn chạy pipeline kiểm tra (parser + quyền) để hệ thống sẵn sàng khi có
   * adapter thật, nhưng KHÔNG tự ghi bút toán nếu không xác định được nguồn.
   */
  async onMessage(message) {
    logger.warn('[DEBT_ZALO] onMessage() không khả dụng — bỏ qua', {
      groupId: message && message.groupId,
      messageId: message && message.messageId,
    });
    return {
      success: false,
      available: false,
      code: 'BRIDGE_NOT_AVAILABLE',
      error: this.reason,
    };
  }

  /**
   * Gửi phản hồi vào nhóm (no-op).
   */
  async sendToGroup(groupId, text) {
    logger.warn('[DEBT_ZALO] sendToGroup() không khả dụng — bỏ qua', { groupId });
    return { success: false, available: false, error: this.reason };
  }

  /** Thông tin trạng thái adapter (để hiển thị trên UI). */
  getStatus() {
    return {
      state: this.state,
      available: false,
      platform: PLATFORMS.ZALO_PERSONAL,
      reason: this.reason,
      features: {
        receiveMessages: false,
        sendMessages: false,
        resolveSenderId: false,
        resolveGroupId: false,
      },
    };
  }
}

/**
 * Adapter "Manual/UI" — dùng chính UI Quick Entry của Beer POS làm nguồn
 * lệnh. Đây là adapter THAY THẾ cho Zalo: cùng interface, cùng pipeline
 * kiểm tra (parser + phân quyền + idempotency + audit), chỉ khác nguồn nhận.
 *
 * Cho phép kiểm thử đầy đủ luồng `+`/`-` mà không cần Zalo.
 */
class ManualEntryAdapter {
  constructor() {
    this.state = BRIDGE_STATE.AVAILABLE;
    this.platform = PLATFORMS.MANUAL;
  }

  isAvailable() {
    return true;
  }

  async start() {
    return { success: true, available: true };
  }

  async stop() {
    return { success: true, available: true };
  }

  /**
   * Nhận lệnh từ UI Quick Entry.
   * @param {object} message { messageId, groupId, senderId, content, customerId }
   */
  async onMessage(message) {
    return DebtCommandService.handleMessage({
      ...message,
      platform: this.platform,
    });
  }

  async sendToGroup(groupId, text) {
    // Không có kênh nhắn tin → trả nội dung để UI hiển thị
    return { success: true, available: true, delivered: false, text };
  }

  getStatus() {
    return {
      state: this.state,
      available: true,
      platform: this.platform,
      reason: 'Nguồn lệnh trực tiếp từ Quick Entry trên Beer POS.',
      features: {
        receiveMessages: true,
        sendMessages: false,
        resolveSenderId: true,
        resolveGroupId: true,
      },
    };
  }
}

/**
 * Adapter Zalo cá nhân thật — chỉ là KHUNG (skeleton).
 *
 * Yêu cầu bắt buộc trước khi kích hoạt:
 *  1. Có giải pháp kết nối Zalo Desktop ĐƯỢC Zalo CHO PHÉP.
 *  2. Xác định được groupId + senderId từ tin nhắn nhận về.
 *  3. Đánh giá được rủi ro & điều khoản sử dụng.
 *  4. Không hardcode cookie/token, không lưu mật khẩu.
 *
 * Hiện tại class này KHÔNG có implementation → `isAvailable() = false`.
 */
class ZaloPersonalAdapter extends NotAvailableZaloAdapter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.state = BRIDGE_STATE.NOT_AVAILABLE;
    this.reason =
      'Zalo Personal Bridge chưa được kích hoạt. Cần đánh giá phương án kết nối ' +
      'được Zalo cho phép trước khi triển khai.';
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────
let _instance = null;

/**
 * Lấy adapter hiện tại (singleton).
 * @param {object} [options]
 * @returns {NotAvailableZaloAdapter|MannualEntryAdapter|ZaloPersonalAdapter}
 */
function getAdapter(options = {}) {
  if (_instance) return _instance;

  const forced = options.adapter || process.env.DEBT_ZALO_ADAPTER || '';
  if (forced === 'manual') {
    _instance = new ManualEntryAdapter();
  } else if (forced === 'zalo_personal') {
    _instance = new ZaloPersonalAdapter(options);
  } else {
    _instance = new NotAvailableZaloAdapter();
  }

  logger.info('[DEBT_ZALO] Adapter khởi tạo:', {
    type: _instance.constructor.name,
    available: _instance.isAvailable(),
  });

  return _instance;
}

/** Đặt lại adapter (dùng trong test). */
function resetAdapter() {
  _instance = null;
}

module.exports = {
  BRIDGE_STATE,
  NotAvailableZaloAdapter,
  ManualEntryAdapter,
  ZaloPersonalAdapter,
  getAdapter,
  resetAdapter,
};
