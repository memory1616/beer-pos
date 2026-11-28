/**
 * DuplicateSaleCheck — chặn tạo đơn trùng khi khách đã có đơn trong ngày
 * ─────────────────────────────────────────────────────────────────────────────
 * VẤN ĐỀ (phát hiện 2026-11-28):
 *   Không có bất kỳ logic nào chặn tạo 2 đơn cho cùng 1 khách trong cùng
 *   1 ngày giao. Sự cố thật trên production:
 *     - Đơn ĐẶT TRƯỚC #1171 (Xiên Que Tam Hạp, 120 vàng), ngày giao 28/11.
 *     - Admin xoá đơn đặt trước lúc 13:48 (tạo nhầm) → tài xế tạo lại đơn
 *       thường #1179 cho CÙNG khách, CÙNG ngày giao, CÙNG số lượng.
 *     → Tài xế phải giao 2 lần cho 1 khách, số liệu vỏ/lít sai.
 *
 * NGUYÊN TẮC:
 *   "Mỗi khách chỉ có 1 đơn cho mỗi ngày giao."
 *   - Đơn THƯỜNG  → ngày giao = `created_on` (ngày lập đơn).
 *   - Đơn ĐẶT TRƯỚC → ngày giao = `preorder_date` (ngày giao mong muốn).
 *   → Hai đơn của cùng khách trùng nhau khi cùng NGÀY GIAO, kể cả khi
 *     một đơn là đặt trước và một đơn là thường.
 *
 * NGOẠI LỆ (KHÔNG chặn):
 *   - Khách lẻ (`customerId` rỗng / NULL) → không xác định được "khách".
 *   - Đơn TRẢ THƯỜNG (`promo_type` MONTHLY_BONUS / NEW_SHOP_BONUS): hệ
 *     thống tự sinh đơn 0đ để trả thưởng, KHÔNG phải đơn bán hàng.
 *   - Đơn đã bị xoá/archived (`archived = 1` hoặc `deleted = 1`).
 *   - Tham số `force = true` (Admin/tài xế chủ động vượt khoá) → vẫn ghi
 *     audit log để truy vết.
 */

const db = require('../../database');
const logger = require('../utils/logger');

/**
 * Ngày giao của 1 đơn (YYYY-MM-DD).
 *
 * - Đơn đặt trước (đã RELEASED) → `preorder_date` (ngày giao mong muốn).
 * - Đơn đặt trước (còn SCHEDULED) → `preorder_date` (ngày giao DỰ KIẾN —
 *   chặn trùng sớm, tránh tạo đơn thường cho khách đã có đơn đặt trước
 *   cùng ngày giao).
 * - Đơn thường → `created_on` (ngày lập đơn) → trùng `date` (ngày nghiệp vụ).
 *
 * @param {object} sale - row `sales`
 * @returns {string|null} YYYY-MM-DD
 */
function getSaleDeliveryDate(sale) {
  if (!sale) return null;

  const take = (v) => {
    if (!v) return null;
    const m = String(v).trim().match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  };

  // Đơn đặt trước → ngày giao mong muốn.
  if (sale.preorder_status) {
    const preorderDate = take(sale.preorder_date);
    if (preorderDate) return preorderDate;
  }

  return take(sale.created_on) || take(sale.date);
}

/**
 * Đơn này có phải "đơn trả thưởng" (phiếu xuất kho 0đ) không?
 *
 * ⚠️ Đơn trả thưởng KHÔNG phải đơn bán hàng:
 *   - `promo_type` = 'MONTHLY_BONUS' / 'NEW_SHOP_BONUS', hoặc
 *   - `reward_liters_used > 0` (đơn có gắn phần thưởng).
 *   → KHÔNG tính là "đơn của khách trong ngày" khi kiểm tra trùng.
 *
 *   Lý do: `claimMonthlyReward()` tạo đơn 0đ riêng khi Admin bấm "nhận
 *   thưởng" → nếu tính là đơn bán hàng thì tài xế tạo đơn thường cho cùng
 *   khách trong ngày đó sẽ bị chặn nhầm.
 *
 * @param {object} sale - row `sales`
 * @returns {boolean}
 */
function isRewardSale(sale) {
  if (!sale) return false;
  if (sale.promo_type === 'MONTHLY_BONUS' || sale.promo_type === 'NEW_SHOP_BONUS') return true;
  return (Number(sale.reward_liters_used) || 0) > 0;
}

/**
 * Tìm đơn trùng của khách trong ngày giao đã xác định.
 *
 * @param {number} customerId
 * @param {string} deliveryDate - YYYY-MM-DD (ngày giao của đơn MỚI)
 * @param {number} [excludeSaleId] - bỏ qua đơn này (dùng khi SỬA đơn)
 * @returns {object|null} thông tin đơn trùng, hoặc null nếu không trùng
 */
function findDuplicateSale(customerId, deliveryDate, excludeSaleId = null) {
  if (!customerId || !deliveryDate) return null;

  // Lấy các đơn đang "sống" của khách trong ngày giao này.
  const candidates = db
    .prepare(
      `SELECT id, date, created_on, preorder_status, preorder_date,
              promo_type, reward_liters_used, total, driver_username, type
         FROM sales
        WHERE customer_id = ?
          AND type = 'sale'
          AND archived = 0
          AND deleted = 0`
    )
    .all(customerId);

  for (const sale of candidates) {
    if (excludeSaleId && sale.id === excludeSaleId) continue;
    // Đơn trả thưởng (0đ) không tính là đơn bán hàng → bỏ qua.
    if (isRewardSale(sale)) continue;
    if (getSaleDeliveryDate(sale) !== deliveryDate) continue;
    return sale;
  }

  return null;
}

/**
 * Kiểm tra đơn trùng khi TẠO đơn mới.
 *
 * @param {object} opts
 * @param {number} opts.customerId - khách hàng (null/rỗng → bỏ qua)
 * @param {string} opts.deliveryDate - ngày giao của đơn mới (YYYY-MM-DD)
 * @param {boolean} [opts.force] - cho phép vượt khoá
 * @param {string} [opts.actor] - username người tạo (để ghi log)
 * @returns {{duplicate: boolean, sale?: object, error?: string, code?: string, force?: boolean}}
 */
function checkDuplicateSale(opts = {}) {
  const { customerId, deliveryDate, force = false, actor = null } = opts;

  if (!customerId || !deliveryDate) {
    return { duplicate: false };
  }

  const existing = findDuplicateSale(customerId, deliveryDate);
  if (!existing) {
    return { duplicate: false };
  }

  // Vượt khoá có chủ đích → vẫn ghi log để truy vết.
  if (force) {
    logger.warn('[DuplicateSaleCheck] duplicate overridden by force', {
      actor,
      customerId,
      deliveryDate,
      existingSaleId: existing.id,
      existingPreorderStatus: existing.preorder_status,
    });
    return { duplicate: false, force: true };
  }

  const isPreorder = !!existing.preorder_status;
  const existingLabel = isPreorder
    ? `đơn đặt trước #${existing.id} (giao ngày ${deliveryDate})`
    : `đơn #${existing.id} (tạo ngày ${deliveryDate})`;

  return {
    duplicate: true,
    sale: existing,
    code: 'DUPLICATE_SAME_DAY_SALE',
    error:
      `Khách này đã có ${existingLabel} trong ngày ${deliveryDate}. ` +
      `Vui lòng mở đơn đó để điều chỉnh thay vì tạo đơn mới.`,
  };
}

module.exports = {
  getSaleDeliveryDate,
  isRewardSale,
  findDuplicateSale,
  checkDuplicateSale,
};
