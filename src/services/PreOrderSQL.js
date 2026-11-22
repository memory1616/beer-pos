/**
 * PreOrderSQL — điều kiện SQL dùng chung cho đơn đặt trước
 * ─────────────────────────────────────────────────────────────────────────────
 * Đơn đặt trước (`preorder_status = 'SCHEDULED'`) CHƯA giao → CHƯA ghi nhận
 * doanh thu. Mọi query tính doanh thu / sản lượng / báo cáo PHẢI loại trừ
 * các đơn này, nếu không sẽ tính trước doanh thu (sai nghiệp vụ).
 *
 * CÁCH DÙNG:
 *   const PreOrderSQL = require('../../src/services/PreOrderSQL');
 *
 *   // Doanh thu đã ghi nhận (bỏ qua đơn chờ):
 *   WHERE s.type = 'sale' AND ${PreOrderSQL.COUNTED_FILTER}
 *
 *   // Chỉ đơn đang chờ đẩy:
 *   WHERE s.type = 'sale' AND ${PreOrderSQL.PENDING_FILTER}
 */

/**
 * Điều kiện loại trừ đơn đặt trước chưa release (dùng khi tính doanh thu).
 * Dùng trong mệnh đề WHERE với alias bảng `s` (bảng `sales`).
 */
const COUNTED_FILTER = "COALESCE(s.preorder_status, '') != 'SCHEDULED'";

/**
 * Điều kiện loại trừ đơn đặt trước chưa release — bản không cần alias
 * (dùng khi query không có JOIN, ví dụ `FROM sales WHERE ...`).
 */
const COUNTED_FILTER_NO_ALIAS = "COALESCE(preorder_status, '') != 'SCHEDULED'";

/**
 * Điều kiện chỉ lấy đơn đặt trước chưa release (dùng cho màn "chờ đẩy").
 */
const PENDING_FILTER = "s.preorder_status = 'SCHEDULED'";

/**
 * Điều kiện chỉ lấy đơn đặt trước chưa release — bản không cần alias.
 */
const PENDING_FILTER_NO_ALIAS = "preorder_status = 'SCHEDULED'";

module.exports = {
  COUNTED_FILTER,
  COUNTED_FILTER_NO_ALIAS,
  PENDING_FILTER,
  PENDING_FILTER_NO_ALIAS,
  // Alias cũ — giữ để không phá code đang gọi.
  REVENUE_FILTER: COUNTED_FILTER,
  REVENUE_FILTER_NO_ALIAS: COUNTED_FILTER_NO_ALIAS,
};
