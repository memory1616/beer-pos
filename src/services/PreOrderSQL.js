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

/**
 * Biểu thức "ngày giao" cho Driver Portal / danh sách giao hàng.
 *
 * ⚠️ QUAN TRỌNG (2026-11-23):
 *   Driver Portal lọc đơn theo `COALESCE(DATE(s.created_on), DATE(s.date))`
 *   — ngày LỊCH THỰC tạo đơn (giữ đơn tạo sau 19:00 trong ngày đó).
 *   Nhưng đơn ĐẶT TRƯỚC có ngày giao là `preorder_date` ≠ `created_on`
 *   (đặt hôm nay, giao ngày mai) → đơn đã release KHÔNG xuất hiện trong
 *   danh sách giao hàng của ngày giao.
 *
 *   → Với đơn đặt trước đã RELEASED: dùng `preorder_date` làm ngày giao.
 *   → Với đơn thường: giữ nguyên `COALESCE(DATE(s.created_on), DATE(s.date))`.
 *
 * Dùng trong mệnh đề WHERE với alias bảng `s` (bảng `sales`).
 */
const DELIVERY_DATE_EXPR = `CASE
    WHEN s.preorder_status = 'RELEASED' AND s.preorder_date IS NOT NULL
      THEN DATE(s.preorder_date)
    ELSE COALESCE(DATE(s.created_on), DATE(s.date))
  END`;

/**
 * Biểu thức "ngày giao" — bản không cần alias (dùng khi query không có JOIN).
 */
const DELIVERY_DATE_EXPR_NO_ALIAS = `CASE
    WHEN preorder_status = 'RELEASED' AND preorder_date IS NOT NULL
      THEN DATE(preorder_date)
    ELSE COALESCE(DATE(created_on), DATE(date))
  END`;

module.exports = {
  COUNTED_FILTER,
  COUNTED_FILTER_NO_ALIAS,
  PENDING_FILTER,
  PENDING_FILTER_NO_ALIAS,
  DELIVERY_DATE_EXPR,
  DELIVERY_DATE_EXPR_NO_ALIAS,
  // Alias cũ — giữ để không phá code đang gọi.
  REVENUE_FILTER: COUNTED_FILTER,
  REVENUE_FILTER_NO_ALIAS: COUNTED_FILTER_NO_ALIAS,
};
