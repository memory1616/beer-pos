/**
 * Debt Constants — Sổ công nợ Gia Huy
 * ─────────────────────────────────────────────────────────────────────────────
 * Nguồn sự thật duy nhất cho các hằng số nghiệp vụ công nợ.
 * Mọi service trong `src/services/debt/` đều import từ đây.
 */

// ── Loại bút toán ──────────────────────────────────────────────────────────────
const TRANSACTION_TYPES = {
  OPENING_BALANCE: 'OPENING_BALANCE', // Công nợ đầu kỳ (migrate dữ liệu cũ)
  ORDER_DEBT: 'ORDER_DEBT', // Nợ tự động từ đơn hàng khi DELIVERED
  MANUAL_DEBT: 'MANUAL_DEBT', // Nợ phát sinh do nhân viên nhập lệnh `-`
  PAYMENT: 'PAYMENT', // Khách thanh toán (lệnh `+` hoặc nhập tay)
  ADJUSTMENT: 'ADJUSTMENT', // Điều chỉnh có audit log
  REVERSAL: 'REVERSAL', // Đảo giao dịch (bút toán gốc KHÔNG bị xoá)
};

// Dấu quyết định theo loại bút toán.
// PAYMENT giảm công nợ; các loại khác tăng công nợ.
const SIGN_BY_TYPE = {
  [TRANSACTION_TYPES.OPENING_BALANCE]: +1,
  [TRANSACTION_TYPES.ORDER_DEBT]: +1,
  [TRANSACTION_TYPES.MANUAL_DEBT]: +1,
  [TRANSACTION_TYPES.PAYMENT]: -1,
  [TRANSACTION_TYPES.ADJUSTMENT]: +1,
  [TRANSACTION_TYPES.REVERSAL]: +1,
};

/** Loại bút toán làm TĂNG công nợ hay GIẢM công nợ. */
function signOf(transactionType) {
  const sign = SIGN_BY_TYPE[transactionType];
  if (sign === undefined) {
    throw new Error(`Loại bút toán không hợp lệ: ${transactionType}`);
  }
  return sign;
}

// ── Nguồn ghi bút toán ─────────────────────────────────────────────────────────
const SOURCES = {
  POS: 'POS', // Ghi tự động từ POS (đơn hàng DELIVERED)
  ZALO: 'ZALO', // Ghi qua adapter Zalo
  MANUAL_UI: 'MANUAL_UI', // Nhân viên nhập tay trên trang Sổ công nợ
  RECONCILIATION: 'RECONCILIATION', // Xử lý kết quả đối soát
  MIGRATION: 'MIGRATION', // Migrate dữ liệu cũ
  SYSTEM: 'SYSTEM', // Hệ thống (cron, tự động)
};

// ── Loại tham chiếu ────────────────────────────────────────────────────────────
const REFERENCE_TYPES = {
  ORDER: 'ORDER', // Gắn với `sales.id`
  MANUAL: 'MANUAL', // Gắn với mã tham chiếu do người dùng nhập
  NONE: 'NONE', // Không có tham chiếu
};

// ── Event type (debt_processed_events) ────────────────────────────────────────
const EVENT_TYPES = {
  ORDER_DELIVERED: 'ORDER_DELIVERED', // Đơn hàng chuyển sang DELIVERED
  COMMAND_PAYMENT: 'COMMAND_PAYMENT', // Lệnh `+` (thanh toán)
  COMMAND_MANUAL_DEBT: 'COMMAND_MANUAL_DEBT', // Lệnh `-` (nợ tay)
  OPENING_BALANCE_MIGRATION: 'OPENING_BALANCE_MIGRATION', // Migrate số dư đầu kỳ
};

// ── Platform (debt_customer_groups / debt_bridge_events) ──────────────────────
const PLATFORMS = {
  ZALO_PERSONAL: 'zalo_personal', // Nhóm Zalo cá nhân (adapter hiện NOT_AVAILABLE)
  ZALO_OA: 'zalo_oa', // Zalo OA (KHÔNG dùng cho module này theo yêu cầu)
  MANUAL: 'manual', // Nhóm "ảo" cho nhập tay — không dùng để nhận tin nhắn
};

// ── Trạng thái ─────────────────────────────────────────────────────────────────
const ACCOUNT_STATUS = {
  ACTIVE: 'active',
  CLOSED: 'closed',
};

const PERMISSION_STATUS = {
  ACTIVE: 'active',
  REVOKED: 'revoked',
};

const GROUP_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
};

const BRIDGE_STATUS = {
  RECEIVED: 'received',
  PROCESSED: 'processed',
  REJECTED: 'rejected',
  FAILED: 'failed',
};

// ── Action của debt_audit_logs ────────────────────────────────────────────────
const AUDIT_ACTIONS = {
  CREATE: 'CREATE',
  REVERSE: 'REVERSE',
  ADJUST: 'ADJUST',
  RECONCILE_FIX: 'RECONCILE_FIX',
  PERMISSION_CHANGE: 'PERMISSION_CHANGE',
  GROUP_LINK: 'GROUP_LINK',
  GROUP_UNLINK: 'GROUP_UNLINK',
  OPENING_BALANCE_MIGRATE: 'OPENING_BALANCE_MIGRATE',
};

// ── Hạn mức mặc định ───────────────────────────────────────────────────────────
const DEFAULT_MAX_COMMAND_AMOUNT = 100000; // 100.000 nghìn = 100.000.000đ
const DEFAULT_COMMAND_UNIT = 1000; // 1 nghìn đồng = 1.000đ
const DEFAULT_PARTIAL_DELIVERY_POLICY = 'NONE'; // NONE | PROPORTIONAL

module.exports = {
  TRANSACTION_TYPES,
  SIGN_BY_TYPE,
  signOf,
  SOURCES,
  REFERENCE_TYPES,
  EVENT_TYPES,
  PLATFORMS,
  ACCOUNT_STATUS,
  PERMISSION_STATUS,
  GROUP_STATUS,
  BRIDGE_STATUS,
  AUDIT_ACTIONS,
  DEFAULT_MAX_COMMAND_AMOUNT,
  DEFAULT_COMMAND_UNIT,
  DEFAULT_PARTIAL_DELIVERY_POLICY,
};
