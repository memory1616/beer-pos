/**
 * PreOrderService — Đặt hàng trước (Pre-order)
 * ─────────────────────────────────────────────────────────────────────────────
 * NGHIỆP VỤ:
 *  Admin tạo đơn hàng ĐẶT TRƯỚC cho một ngày giao mong muốn (ví dụ đặt
 *  trước cho ngày mai). Đơn này:
 *   - CHƯA ghi nhận doanh thu (chỉ ghi nhận khi THỰC SỰ giao).
 *   - CHƯA hiện trong danh sách giao hàng của tài xế.
 *   - CHƯA trừ kho ngay (vỏ/sản lượng chỉ trừ khi release) — xem ghi chú
 *     bên dưới.
 *  Hệ thống có cron chạy lúc 07:00 sáng mỗi ngày: các đơn có
 *  `preorder_date = hôm nay` được RELEASE → ghi nhận doanh thu, gán tài xế
 *  theo khu vực, tạo phiếu giao + báo tài xế (Socket.IO + Web Push).
 *
 * TRẠNG THÁI (`sales.preorder_status`):
 *  - NULL        : đơn thường (không phải đặt trước) → hành vi cũ, y hệt.
 *  - 'SCHEDULED' : đơn đặt trước, CHỜ ngày giao.
 *  - 'RELEASED'  : đã được đẩy vào giao hàng (ghi nhận doanh thu).
 *
 * ⚠️ VỀ VIỆC TRỪ KHO:
 *  Đơn đặt trước vẫn TRỪ KHO ngay khi tạo (giống đơn thường) — vì bia đã
 *  được chuẩn bị/giữ chỗ cho khách. `saleDelete` hoàn trả kho khi xoá đơn
 *  → không rò rỉ tồn kho.
 *
 * ⚠️ VỀ SẢN LƯỢNG KHUYẾN MÃI:
 *  Sản lượng mua của khách (`monthly_purchased_liters`) CHỈ cộng khi đơn
 *  được RELEASE (tức khi thực sự giao) → khớp với doanh thu.
 */

const db = require('../../database');
const logger = require('../../src/utils/logger');

// Giờ (giờ Việt Nam) đẩy đơn đặt trước vào giao hàng.
const DEFAULT_RELEASE_HOUR = 7;

const PREORDER_STATUS = {
  SCHEDULED: 'SCHEDULED',
  RELEASED: 'RELEASED',
};

/**
 * Chuẩn hoá ngày giao mong muốn (YYYY-MM-DD).
 * @param {string} raw
 * @returns {string|null} ngày hợp lệ hoặc null
 */
function normalizeScheduleDate(raw) {
  const s = String(raw || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  // Kiểm tra ngày có thực sự tồn tại (tránh 2026-02-30).
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return s;
}

/**
 * Lấy giờ release từ settings (mặc định 07:00).
 * @returns {number} giờ (0-23)
 */
function getReleaseHour() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'preorder_release_hour'").get();
    const h = parseInt(row && row.value, 10);
    if (Number.isInteger(h) && h >= 0 && h <= 23) return h;
  } catch (_) { /* ignore */ }
  return DEFAULT_RELEASE_HOUR;
}

/**
 * Cài đặt giờ release (Admin).
 * @param {number} hour
 * @returns {{success:boolean, error?:string, hour?:number}}
 */
function setReleaseHour(hour) {
  const h = parseInt(hour, 10);
  if (!Number.isInteger(h) || h < 0 || h > 23) {
    return { success: false, error: 'Giờ đẩy đơn phải là số nguyên từ 0 đến 23' };
  }
  try {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run('preorder_release_hour', String(h));
    return { success: true, hour: h };
  } catch (e) {
    logger.error('[PreOrder] setReleaseHour error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Kiểm tra ngày giao mong muốn có hợp lệ không (không trong quá khứ).
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {{valid:boolean, error?:string}}
 */
function validateScheduleDate(dateStr) {
  const d = normalizeScheduleDate(dateStr);
  if (!d) {
    return { valid: false, error: 'Ngày giao không hợp lệ (định dạng YYYY-MM-DD)' };
  }
  const today = db.getVietnamDateStr();
  if (d < today) {
    return { valid: false, error: 'Ngày giao không được nằm trong quá khứ' };
  }
  return { valid: true };
}

/**
 * Điều phố tài xế cho đơn đặt trước (dùng chung logic với đơn thường).
 * @param {number|null} customerId
 * @returns {{driverUsername:string|null, regionId:number|null, regionName:string|null, reason?:string}}
 */
function resolveDriver(customerId) {
  try {
    const RegionService = require('./RegionService');
    const dispatch = RegionService.autoDispatchForCustomer(customerId);
    return {
      driverUsername: dispatch.driverUsername || null,
      regionId: dispatch.regionId || null,
      regionName: dispatch.regionName || null,
      reason: dispatch.reason || null,
    };
  } catch (e) {
    logger.error('[PreOrder] resolveDriver error', { error: e.message });
    return { driverUsername: null, regionId: null, regionName: null, reason: e.message };
  }
}

/**
 * Danh sách đơn đặt trước chờ đẩy (SCHEDULED).
 * @param {object} opts - { date, limit }
 * @returns {Array<object>}
 */
function listScheduled(opts = {}) {
  const date = opts.date ? normalizeScheduleDate(opts.date) : db.getVietnamDateStr();
  const limit = Math.min(500, parseInt(opts.limit, 10) || 200);
  if (!date) return [];

  return db
    .prepare(
      `SELECT s.id, s.customer_id, s.date, s.created_on, s.sale_time,
              s.total, s.deliver_kegs, s.preorder_date, s.preorder_status,
              s.driver_username, s.region_id, s.region_name, s.dispatch_status,
              c.name AS customer_name, c.phone AS customer_phone,
              c.address AS customer_address
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.type = 'sale'
          AND s.archived = 0
          AND s.deleted = 0
          AND s.preorder_status = 'SCHEDULED'
          AND s.preorder_date = ?
        ORDER BY s.id ASC
        LIMIT ?`
    )
    .all(date, limit);
}

/**
 * Đẩy (release) các đơn đặt trước của một ngày vào giao hàng.
 *
 * Mỗi đơn được xử lý ĐỘC LẬP (transaction riêng) → 1 đơn lỗi không chặn
 * các đơn còn lại. Idempotent: chỉ xử lý đơn `SCHEDULED` (đã release rồi thì
 * bỏ qua qua câu UPDATE có điều kiện).
 *
 * @param {object} opts - { date, dryRun }
 * @returns {Promise<{date:string, total:number, released:number, failed:number, items:Array}>}
 */
async function releaseDuePreOrders(opts = {}) {
  const date = opts.date ? normalizeScheduleDate(opts.date) : db.getVietnamDateStr();
  const dryRun = !!opts.dryRun;
  const result = { date, total: 0, released: 0, failed: 0, items: [] };

  if (!date) {
    result.error = 'Ngày không hợp lệ';
    return result;
  }

  const due = listScheduled({ date, limit: 500 });
  result.total = due.length;
  if (!due.length) return result;

  if (dryRun) {
    result.items = due.map((s) => ({ id: s.id, action: 'DRY_RUN' }));
    return result;
  }

  const RegionService = require('./RegionService');
  const DeliveryService = require('./DeliveryService');
  const { PromotionService } = require('./index');

  for (const sale of due) {
    try {
      const outcome = releaseOne(sale, { RegionService, DeliveryService, PromotionService });
      if (outcome.ok) result.released++;
      else result.failed++;
      result.items.push({ id: sale.id, ...outcome });
    } catch (e) {
      result.failed++;
      result.items.push({ id: sale.id, ok: false, error: e.message });
      logger.error('[PreOrder] release failed', { saleId: sale.id, error: e.message });
    }
  }

  logger.info('[PreOrder] release done', {
    date,
    total: result.total,
    released: result.released,
    failed: result.failed,
  });

  return result;
}

/**
 * Release 1 đơn đặt trước.
 * @param {object} sale - row từ listScheduled
 * @param {object} ctx - { RegionService, DeliveryService, PromotionService }
 */
function releaseOne(sale, ctx) {
  const { RegionService, DeliveryService, PromotionService } = ctx;

  const doRelease = db.transaction(() => {
    // ── 1. Chốt trạng thái (điều kiện → idempotent) ──────────────────────
    // Chỉ chuyển được đơn còn SCHEDULED. Nếu đơn đã được release bởi tiến
    // trình khác → UPDATE không đổi dòng nào → abort (không ghi nhận 2 lần).
    const upd = db
      .prepare(
        `UPDATE sales
            SET preorder_status = 'RELEASED',
                preorder_released_at = datetime('now', '+7 hours'),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND preorder_status = 'SCHEDULED'`
      )
      .run(sale.id);
    if (upd.changes === 0) {
      return { skipped: true, reason: 'Đã được release trước đó' };
    }

    // ── 2. Ghi nhận doanh thu (đơn đặt trước chưa tính doanh thu) ─────────
    // `sales.date` của đơn đặt trước đã là ngày giao mong muốn → đơn này
    // BẮT ĐẦU được tính vào doanh thu từ đây.
    // Sản lượng khuyến mãi cũng được cộng tương ứng (xem ghi chú đầu file).

    // ── 3. Gán tài xế theo khu vực (nếu chưa có) ─────────────────────────
    let driverUsername = sale.driver_username || null;
    let regionId = sale.region_id || null;
    let regionName = sale.region_name || null;
    let dispatchStatus = sale.dispatch_status || null;

    if (!driverUsername) {
      const dispatch = RegionService.autoDispatchForCustomer(sale.customer_id);
      regionId = dispatch.regionId || regionId;
      regionName = dispatch.regionName || regionName;
      if (dispatch.driverUsername) {
        driverUsername = dispatch.driverUsername;
        dispatchStatus = 'AUTO';
      } else {
        dispatchStatus = 'UNASSIGNED';
      }
    }

    db.prepare(
      `UPDATE sales
          SET driver_username = ?,
              region_id = ?,
              region_name = ?,
              region_driver_username = COALESCE(region_driver_username, ?),
              dispatch_status = ?
        WHERE id = ?`
    ).run(driverUsername, regionId, regionName, driverUsername, dispatchStatus, sale.id);

    return { skipped: false, driverUsername, regionId, regionName, dispatchStatus };
  });

  const outcome = doRelease();
  if (outcome.skipped) return { ok: true, skipped: true, reason: outcome.reason };

  // ── 4. Cộng sản lượng mua của khách (khuyến mãi) ───────────────────────
  // Nằm NGOÀI transaction trên để lỗi cập nhật sản lượng không làm rollback
  // trạng thái release (đơn vẫn giao được; sản lượng có thể backfill sau).
  try {
    addMonthlyVolume(sale, PromotionService);
  } catch (e) {
    logger.error('[PreOrder] addMonthlyVolume error', { saleId: sale.id, error: e.message });
  }

  // ── 5. Tạo phiếu giao + báo tài xế ──────────────────────────────────────
  try {
    if (outcome.driverUsername) {
      DeliveryService.ensureRecord(sale.id, outcome.driverUsername);
      RegionService.syncDeliveryAndNotify([sale.id], outcome.driverUsername);
    }
  } catch (e) {
    logger.error('[PreOrder] notify driver error', { saleId: sale.id, error: e.message });
  }

  return { ok: true, skipped: false, ...outcome };
}

/**
 * Cộng sản lượng mua của khách cho tháng của ngày giao.
 * @param {object} sale
 * @param {object} PromotionService
 */
function addMonthlyVolume(sale, PromotionService) {
  const customerId = sale.customer_id;
  if (!customerId) return;

  const cust = db
    .prepare('SELECT promotion_enabled FROM customers WHERE id = ?')
    .get(customerId);
  if (!cust || cust.promotion_enabled === 0) return;

  const items = db
    .prepare(
      `SELECT si.quantity, p.name AS product_name
         FROM sale_items si
         JOIN products p ON p.id = si.product_id
        WHERE si.sale_id = ? AND si.price > 0`
    )
    .all(sale.id);

  let paidLiters = 0;
  let yellowLiters = 0;
  let blackLiters = 0;
  for (const item of items) {
    const q = Number(item.quantity) || 0;
    paidLiters += q;
    if (PromotionService.classifyBeer(item.product_name) === 'black') {
      blackLiters += q;
    } else {
      yellowLiters += q;
    }
  }
  if (paidLiters <= 0) return;

  // Tháng tính theo NGÀY GIAO (preorder_date), khớp với `sales.date` mà
  // saleDelete.js đọc khi hoàn trả sản lượng.
  const monthStr = String(sale.preorder_date || sale.date).slice(0, 7);
  const [bizYear, bizMonth] = monthStr.split('-').map(Number);

  db.prepare(
    'UPDATE customers SET monthly_purchased_liters = monthly_purchased_liters + ? WHERE id = ?'
  ).run(paidLiters, customerId);
  PromotionService.updateCustomerMonthlyStats(
    customerId,
    paidLiters,
    bizYear,
    bizMonth,
    yellowLiters,
    blackLiters
  );
}

/**
 * Huỷ đơn đặt trước (chưa release) → trả về trạng thái đơn thường.
 * @param {number} saleId
 * @returns {{success:boolean, error?:string}}
 */
function cancelPreOrder(saleId) {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { success: false, error: 'Không tìm thấy đơn hàng' };
  if (sale.preorder_status !== 'SCHEDULED') {
    return { success: false, error: 'Chỉ huỷ được đơn đặt trước chưa đẩy vào giao hàng' };
  }

  db.prepare(
    `UPDATE sales
        SET preorder_status = NULL,
            preorder_date = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND preorder_status = 'SCHEDULED'`
  ).run(saleId);

  return { success: true };
}

/**
 * Đẩy ngay một đơn đặt trước (Admin bấm tay) — không chờ 07:00.
 * @param {number} saleId
 */
async function releaseNow(saleId) {
  const sale = db
    .prepare(
      `SELECT s.*, c.name AS customer_name
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.id = ?`
    )
    .get(saleId);
  if (!sale) return { success: false, error: 'Không tìm thấy đơn hàng' };
  if (sale.preorder_status !== 'SCHEDULED') {
    return { success: false, error: 'Đơn này không phải đơn đặt trước chờ đẩy' };
  }

  const RegionService = require('./RegionService');
  const DeliveryService = require('./DeliveryService');
  const { PromotionService } = require('./index');

  try {
    const outcome = releaseOne(sale, { RegionService, DeliveryService, PromotionService });
    return { success: true, ...outcome };
  } catch (e) {
    logger.error('[PreOrder] releaseNow error', { saleId, error: e.message });
    return { success: false, error: e.message };
  }
}

module.exports = {
  PREORDER_STATUS,
  DEFAULT_RELEASE_HOUR,
  normalizeScheduleDate,
  validateScheduleDate,
  getReleaseHour,
  setReleaseHour,
  listScheduled,
  releaseDuePreOrders,
  releaseNow,
  cancelPreOrder,
  resolveDriver,
};
