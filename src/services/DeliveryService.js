/**
 * DeliveryService — Nghiệp vụ giao hàng cho Driver Portal
 * ─────────────────────────────────────────────────────────────────────────────
 * Nguyên tắc:
 *  - KHÔNG nhân bản nghiệp vụ bán hàng. Mọi đơn giao đều gắn với `sales.id`
 *    (đơn đã tạo qua logic Sale chuẩn của hệ thống).
 *  - Mọi thay đổi trạng thái đều ghi vào `delivery_events` kèm tài khoản tài xế.
 *  - Cập nhật số vỏ keg dùng lại đúng logic của hệ thống (keg_stats + customer).
 *  - KHÔNG đụng vào cột `profit` / `cost_price`.
 */

// Trạng thái đơn giao hàng
const DELIVERY_STATUS = {
  PENDING: 'PENDING',           // Chờ giao
  IN_PROGRESS: 'IN_PROGRESS',   // Đang giao
  DELIVERED: 'DELIVERED',       // Đã giao
  FAILED: 'FAILED',             // Giao thất bại
  DISCREPANCY: 'DISCREPANCY',   // Chờ xử lý sai lệch
};

const STATUS_LABELS = {
  PENDING: 'Chờ giao',
  IN_PROGRESS: 'Đang giao',
  DELIVERED: 'Đã giao',
  FAILED: 'Giao thất bại',
  DISCREPANCY: 'Chờ xử lý sai lệch',
};

// Chuyển trạng thái hợp lệ
const ALLOWED_TRANSITIONS = {
  PENDING: ['IN_PROGRESS', 'DELIVERED', 'FAILED'],
  IN_PROGRESS: ['DELIVERED', 'FAILED', 'PENDING'],
  DELIVERED: ['DISCREPANCY'],
  FAILED: ['PENDING', 'IN_PROGRESS', 'DISCREPANCY'],
  DISCREPANCY: ['IN_PROGRESS', 'DELIVERED'],
};

const db = require('../../database');
const logger = require('../../src/utils/logger');
const DebtOrderIntegration = require('./debt/DebtOrderIntegration');
const AuditService = require('./AuditService');
const KegBalanceService = require('./KegBalanceService');
const RegionService = require('./RegionService');
const PreOrderSQL = require('./PreOrderSQL');

// ── Phân quyền sửa số liệu đã xác nhận ─────────────────────────────────────
//
// NGHIỆP VỤ (2026-11-23): "Mỗi hóa đơn giao hàng chỉ được đối soát một lần"
// + "Không cho sửa số liệu đã xác nhận nếu không có quyền quản lý".
//
// 2 nguyên tắc tách biệt:
//  1. `reconciled_at` — phiếu đã ĐỐI SOÁT → không đối soát/ghi lại lần 2.
//     Áp dụng cho MỌI vai trò (kể cả Admin) trừ khi có `force`.
//  2. Số liệu ĐÃ XÁC NHẬN (phiếu `DELIVERED` / `DISCREPANCY`) → chỉ vai
//     trò có quyền quản lý mới được sửa. Tài xế (DRIVER) bị chặn.

// Vai trò được phép sửa số liệu đã xác nhận.
const MANAGEMENT_ROLES = ['ADMIN', 'MANAGER'];

// Trạng thái phiếu mà số liệu THƯỜNG đã được xác nhận (dùng để hiển thị
// cảnh báo trong UI). ⚠️ Logic khoá thực tế KHÔNG dựa vào status mà dựa vào
// dấu vết `confirmed_by` / `reconciled_at` — xem `hasConfirmedFigures()`.
const CONFIRMED_STATUSES = [DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.DISCREPANCY];

/**
 * Kiểm tra người dùng có quyền quản lý (được sửa số liệu đã xác nhận) không.
 *
 * @param {object} user - req.user (session) hoặc { username, role }
 * @returns {boolean}
 */
function hasManagementRole(user) {
  if (!user) return false;
  const role = String(user.role || '').toUpperCase();
  if (MANAGEMENT_ROLES.includes(role)) return true;

  // Session không có role → tra cứu `app_users` (fallback an toàn).
  const username = user.username || user.app_user_name;
  if (!username) return false;
  try {
    const row = db
      .prepare('SELECT role FROM app_users WHERE username = ? AND active = 1')
      .get(username);
    return !!row && MANAGEMENT_ROLES.includes(String(row.role || '').toUpperCase());
  } catch (_) {
    return false;
  }
}

class DeliveryService {
  /**
   * Lấy danh sách đơn cần giao cho 1 tài xế trong ngày.
   * Nguồn: các `sales` đã tạo (type='sale') chưa có delivery_record
   * hoặc đã có nhưng chưa hoàn tất.
   *
   * PHẠM VI (Driver Portal):
   *  - Đơn do chính tài xế này tạo (`s.driver_username = ?`), HOẶC
   *  - Đơn Admin tạo mà CHƯA được gán cho tài xế nào (`driver_username IS NULL`).
   *    → Đơn đã gán cho tài xế KHÁC thì không hiện.
   */
  static listForDriver(driverUsername, opts = {}) {
    const date = opts.date || db.getVietnamDateStr();
    const limit = Math.min(500, parseInt(opts.limit) || 200);

  // ── BỌC LỌC: đơn gắn với tài xế KHÔNG còn tồn tại ──────────────────
  // Bug: `sales.driver_username` trỏ tới tài khoản đã bị xoá / khoá (vd: tài
  // khoản test) → đơn rơi vào "mồ": Admin thấy (không lọc driver) nhưng
  // Driver Portal KHÔNG thấy (lọc `driver_username = tôi`) → LỆCH 2 TRANG,
  // và tài xế thật không bao giờ nhận được đơn đó.
  //
  // Fix: coi đơn gắn cho tài khoản không tồn tại (hoặc đã bị khoá) như đơn
  // CHƯA GÁN → mọi tài xế đều có thể nhận & giao (đúng nguyên tắc "đơn chưa
  // có tài xế nào phụ trách"). Đơn của tài xế ĐANG HOẠT ĐỘNG vẫn giữ nguyên
  // (không lộ cho tài xế khác).
  const drvRows = db
    .prepare(
      `
        SELECT
          s.id AS sale_id,
          s.date,
          s.sale_time,
          s.total,
          s.deliver_kegs,
          s.return_kegs,
          s.customer_id,
          s.promo_free_liters,
          s.promo_type,
          s.payment_status,
          s.driver_username,
          s.region_id,
          s.region_name,
          c.name AS customer_name,
          c.phone AS customer_phone,
          c.address AS customer_address,
          c.lat,
          c.lng,
          c.keg_balance,
          dr.id AS delivery_id,
          dr.status AS delivery_status,
          dr.delivered_liters,
          dr.missing_liters,
          dr.excess_liters,
          dr.damaged_liters,
          dr.collected_kegs,
          dr.expected_kegs,
          dr.note AS delivery_note,
          dr.failure_reason
        FROM sales s
        LEFT JOIN customers c ON c.id = s.customer_id
        LEFT JOIN delivery_records dr
               ON dr.sale_id = s.id AND dr.driver_username = ?
        WHERE s.type = 'sale'
          AND s.archived = 0
          AND s.deleted = 0
          AND c.archived = 0
          AND ${PreOrderSQL.DELIVERY_DATE_EXPR} = ?
          AND (
                s.driver_username = ?
             OR s.driver_username IS NULL
             OR s.driver_username = ''
             OR s.driver_username NOT IN (SELECT username FROM app_users WHERE role = 'DRIVER')
          )
          AND (
                dr.id IS NULL
             OR dr.status NOT IN ('DELIVERED')
          )
        ORDER BY dr.status IS NOT NULL, dr.status = 'IN_PROGRESS' DESC,
                 COALESCE(c.name, 'Khách lẻ'), s.id DESC
        LIMIT ?
      `
    )
    .all(driverUsername, date, driverUsername, limit);

  // ── Lọc phạm vi (bảo mật) ────────────────────────────────────────────
  // SQL đã mở rộng để bao gồm "đơn mồ" (gắn cho tài khoản KHÔNG còn tồn
  // tại trong app_users). Ở đây ta loại đơn của tài xế KHÁC — đúng nguyên tắc
  // bảo mật scope.
  //
  //   owner rỗng / NULL                      → chưa gán ai          → AI CŨNG thấy
  //   owner === tài xế đang xem               → đơn của chính mình   → thấy
  //   owner không còn trong app_users        → coi như chưa gán     → AI CŨNG thấy
  //   owner là tài xế KHÁC (còn tồn tại)      → đã có người phụ trách → ẨN
  //
  // PHÂN QUYỀN THEO KHU VỰC (bổ sung):
  //   Đơn CHƯA gán ai → chỉ hiện nếu khu vực đơn thuộc quyền phụ trách
  //   của tài xế. Tài xế KHÔNG thấy đơn "mồ" của khu vực người khác.
  const knownDrivers = new Set(
    db
      .prepare("SELECT username FROM app_users WHERE role = 'DRIVER'")
      .all()
      .map((r) => r.username)
  );

  // Tập id khu vực tài xế đang phụ trách (có thể NHIỀU khu vực).
  const myRegionIds = new Set(RegionService.getDriverRegionIds(driverUsername));
  // ⚠️ Tài xế CHƯA được gán khu vực nào → giữ hành vi cũ (chưa áp dụng
  //    phân quyền khu vực) để không phá vỡ vận hành hiện tại.
  const regionRestrictionActive = myRegionIds.size > 0;

  return drvRows.filter((r) => {
    const owner = r.driver_username;
    if (owner === driverUsername) return true;     // đơn của chính mình → thấy

    if (owner) {
      // Tài xế khác còn tồn tại → ẩn
      if (knownDrivers.has(owner)) return false;
      // Tài khoản không còn tồn tại → coi như "chưa gán" → xem rule bên dưới
    }

    // Chưa áp dụng phân quyền khu vực → hành vi cũ (thấy đơn chưa gán ai)
    if (!regionRestrictionActive) {
      // Hệ thống đã bắt đầu phân công khu vực nhưng tài xế này chưa được gán
      // khu vực nào → KHÔNG thấy đơn nào (chờ Admin phân công).
      if (!RegionService.driverHasNoRegionRestriction(driverUsername)) return false;
      return true;
    }

    // Đơn chưa gán ai → chỉ thấy nếu khu vực thuộc quyền phụ trách
    if (!r.region_id) return false;                // không rõ khu vực → Admin điều phối
    return myRegionIds.has(r.region_id);
  });
}

  /**
   * Lấy danh sách đơn ĐÃ giao của tài xế (lịch sử).
   */
  static listHistory(driverUsername, opts = {}) {
    const limit = Math.min(500, parseInt(opts.limit) || 100);
    const date = opts.date || null;
    const status = opts.status || null;

    let sql = `
      SELECT dr.*, c.name AS customer_name, c.phone AS customer_phone,
             c.address AS customer_address, s.total AS sale_total
      FROM delivery_records dr
      LEFT JOIN customers c ON c.id = dr.customer_id
      LEFT JOIN sales s ON s.id = dr.sale_id
      WHERE dr.driver_username = ?`;
    const params = [driverUsername];

    if (date) {
      sql += ` AND DATE(dr.scheduled_date) = ?`;
      params.push(date);
    }
    if (status) {
      sql += ` AND dr.status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY dr.id DESC LIMIT ?`;
    params.push(limit);

    return db.prepare(sql).all(...params);
  }

  /**
   * Lấy chi tiết 1 đơn giao (kèm items chi tiết và lịch sử sự kiện).
   */
  static getById(deliveryId, driverUsername) {
    const record = db
      .prepare(
        `
        SELECT dr.*, c.name AS customer_name, c.phone AS customer_phone,
               c.address AS customer_address, c.lat, c.lng,
               c.keg_balance AS customer_keg_balance,
               s.total AS sale_total, s.date AS sale_date,
               s.deliver_kegs AS sale_deliver_kegs,
               s.return_kegs AS sale_return_kegs
        FROM delivery_records dr
        LEFT JOIN customers c ON c.id = dr.customer_id
        LEFT JOIN sales s ON s.id = dr.sale_id
        WHERE dr.id = ? AND dr.driver_username = ?
      `
      )
      .get(deliveryId, driverUsername);

    if (!record) return null;

    const items = db
      .prepare('SELECT * FROM delivery_record_items WHERE delivery_id = ? ORDER BY id')
      .all(deliveryId);

    const events = db
      .prepare('SELECT * FROM delivery_events WHERE delivery_id = ? ORDER BY id DESC')
      .all(deliveryId);

    return { ...record, items, events };
  }

  /**
   * Đồng bộ phiếu giao với `sale_items` mới nhất của đơn.
   *
   * BỐI CẢNH:
   *  - `delivery_record_items.expected_quantity` là bản SAO CHÉP số lượng cần
   *    giao tại thời điểm phiếu giao được tạo.
   *  - Trang Giao hàng của tài xế hiển thị "Cần giao: N" từ chính cột này.
   *  - Khi Admin SỬA ĐƠN (đổi số lượng / đổi sản phẩm) mà không đồng bộ
   *    lại → tài xế vẫn thấy số lượng CŨ → giao thiếu/thừa hàng.
   *
   * HÀNH VI:
   *  - Với mỗi item trong `delivery_record_items`:
   *    • Còn sản phẩm trong đơn → cập nhật `expected_quantity` = số lượng mới.
   *    • Không còn trong đơn → đánh dấu `expected_quantity = 0` (giữ dòng để
   *      không phá lịch sử, nhưng không còn yêu cầu giao).
   *  - Thêm dòng cho sản phẩm MỚI có trong đơn nhưng chưa có trong phiếu giao.
   *  - Cập nhật `delivery_records.expected_kegs` = tổng lít (không tính PET).
   *
   * KHÔNG đụng vào `delivered_quantity` (số đã giao thực tế) — lịch sử giao
   * của tài xế được giữ nguyên.
   *
   * ⚠️ Phiếu `DELIVERED` CŨNG được đồng bộ `expected_quantity`/`expected_kegs`
   *    (nhưng giữ nguyên `delivered_quantity`). Lý do: trang Giao hàng hiển thị
   *    "Cần giao: N" lấy từ `delivery_record_items.expected_quantity` — nếu Admin
   *    sửa đơn ĐÃ GIAO mà phiếu giữ số cũ → tài xế thấy sai số vỏ phải giao
   *    (lỗi "sửa đơn không cập nhật số vỏ kéng được giao").
   */
  static syncRecordWithSaleItems(saleId) {
    const saleIdNum = parseInt(saleId, 10);
    if (!Number.isFinite(saleIdNum)) return { success: false, error: 'saleId không hợp lệ' };

    // Lấy TẤT CẢ phiếu giao của đơn này (kể cả đã DELIVERED) → đồng bộ số
    // lượng "cần giao" cho khớp với đơn. KHÔNG đụng `delivered_quantity`.
    const records = db
      .prepare(
        `SELECT id FROM delivery_records
          WHERE sale_id = ?
            AND status IN ('PENDING', 'IN_PROGRESS', 'DISCREPANCY', 'DELIVERED')`
      )
      .all(saleIdNum);

    if (!records.length) return { success: true, updated: 0 };

    // Số lượng mới theo product_id (gộp cả hàng thưởng vào sản phẩm gốc)
    // ⚠️ `sale_items` KHÔNG có cột `product_name` — tên lấy từ `products.name`.
    const newItems = db
      .prepare(
        `SELECT si.product_id, si.product_slug,
                COALESCE(p.name, si.product_slug, '') AS product_name,
                COALESCE(si.quantity, 0) AS quantity,
                COALESCE(p.type, '') AS product_type
           FROM sale_items si
           LEFT JOIN products p ON p.id = si.product_id
          WHERE si.sale_id = ?`
      )
      .all(saleIdNum);

    const byProduct = new Map();
    for (const it of newItems) {
      const key = it.product_id != null ? `id:${it.product_id}` : `name:${it.product_name || ''}`;
      const prev = byProduct.get(key);
      if (prev) {
        prev.quantity += it.quantity || 0;
      } else {
        byProduct.set(key, {
          product_id: it.product_id,
          product_name: it.product_name || '',
          product_slug: it.product_slug || '',
          quantity: it.quantity || 0,
          product_type: it.product_type || '',
        });
      }
    }

    const expectedKegs = newItems
      .filter((i) => i.product_type !== 'pet')
      .reduce((sum, i) => sum + (i.quantity || 0), 0);

    let updatedRows = 0;

    for (const rec of records) {
      const existingItems = db
        .prepare('SELECT * FROM delivery_record_items WHERE delivery_id = ? ORDER BY id')
        .all(rec.id);

      const seenKeys = new Set();

      for (const ex of existingItems) {
        // Khớp theo product_id; nếu dòng cũ không có product_id (dữ liệu cũ)
        // → khớp theo tên sản phẩm.
        const key = ex.product_id != null
          ? `id:${ex.product_id}`
          : `name:${ex.product_name || ''}`;
        const match = byProduct.get(key);

        if (match) {
          seenKeys.add(key);
          if ((ex.expected_quantity || 0) !== match.quantity) {
            db.prepare(
              'UPDATE delivery_record_items SET expected_quantity = ? WHERE id = ?'
            ).run(match.quantity, ex.id);
            updatedRows++;
          }
        } else {
          // Sản phẩm đã bị gỡ khỏi đơn → không còn cần giao
          if ((ex.expected_quantity || 0) !== 0) {
            db.prepare(
              'UPDATE delivery_record_items SET expected_quantity = 0 WHERE id = ?'
            ).run(ex.id);
            updatedRows++;
          }
        }
      }

      // Thêm dòng cho sản phẩm mới có trong đơn
      for (const [key, match] of byProduct.entries()) {
        if (seenKeys.has(key)) continue;
        // Bỏ qua nếu đã có dòng cùng tên (dòng cũ không có product_id)
        const alreadyByName = existingItems.some(
          (ex) => ex.product_id == null && ex.product_name === match.product_name
        );
        if (alreadyByName) continue;

        db.prepare(
          `INSERT INTO delivery_record_items
             (delivery_id, product_id, product_name, expected_quantity,
              delivered_quantity, is_reward, note)
           VALUES (?, ?, ?, ?, 0, 0, NULL)`
        ).run(rec.id, match.product_id, match.product_name, match.quantity);
        updatedRows++;
      }

      db.prepare(
        `UPDATE delivery_records
            SET expected_kegs = ?, updated_at = datetime('now')
          WHERE id = ?`
      ).run(expectedKegs, rec.id);
    }

    if (updatedRows > 0) {
      logger.info('[DeliveryService] syncRecordWithSaleItems updated', {
        saleId: saleIdNum,
        records: records.length,
        rows: updatedRows,
      });
    }

    return { success: true, updated: updatedRows, records: records.length };
  }

  /**
   * Lấy phiếu giao theo id (không giới hạn tài xế — dùng cho admin).
   */
  static getRecordById(deliveryId) {
    const id = parseInt(deliveryId, 10);
    if (!id || Number.isNaN(id)) return null;
    return db.prepare('SELECT * FROM delivery_records WHERE id = ?').get(id) || null;
  }

  /**
   * PHIẾU ĐÃ ĐỐI SOÁT CHƯA?
   *
   * Nguyên tắc: "Mỗi hóa đơn giao hàng chỉ được đối soát một lần."
   * → `reconciled_at` non-NULL ⇒ phiếu đã đối soát ⇒ không ghi lại lần 2.
   *
   * @param {number} deliveryId
   * @returns {{reconciled:boolean, reconciledAt:string|null, reconciledBy:string|null}}
   */
  static getReconciliationState(deliveryId) {
    const record = DeliveryService.getRecordById(deliveryId);
    if (!record) {
      return { reconciled: false, reconciledAt: null, reconciledBy: null };
    }
    return {
      reconciled: !!(record.reconciled_at && String(record.reconciled_at).trim() !== ''),
      reconciledAt: record.reconciled_at || null,
      reconciledBy: record.reconciled_by || null,
    };
  }

  /**
   * Đánh dấu phiếu giao đã ĐỐI SOÁT (chỉ 1 lần).
   * Dùng idempotent: nếu đã đối soát → không ghi đè (giữ dấu vết lần đầu).
   *
   * @param {number} deliveryId
   * @param {string} actorUsername
   * @returns {{success:boolean, alreadyReconciled:boolean, reconciledAt?:string}}
   */
  static markReconciled(deliveryId, actorUsername) {
    const state = DeliveryService.getReconciliationState(deliveryId);
    if (state.reconciled) {
      return {
        success: true,
        alreadyReconciled: true,
        reconciledAt: state.reconciledAt,
        reconciledBy: state.reconciledBy,
      };
    }

    const now = db.getVietnamDateStr() + ' ' + db.getVietnamTimeStr();
    db.prepare(
      `UPDATE delivery_records
          SET reconciled_at = ?, reconciled_by = ?, updated_at = datetime('now')
        WHERE id = ? AND (reconciled_at IS NULL OR reconciled_at = '')`
    ).run(now, actorUsername || null, deliveryId);

    DeliveryService.logEvent(deliveryId, 'RECONCILED', null, null, actorUsername, {
      reconciledAt: now,
    });

    return { success: true, alreadyReconciled: false, reconciledAt: now };
  }

  /**
   * PHIẾU ĐÃ CÓ SỐ LIỆU XÁC NHẬN CHƯA?
   *
   * Dấu hiệu số liệu đã được XÁC NHẬN (có số lít giao / số vỏ thu thực tế):
   *   - `confirmed_by` non-NULL  → đã bấm "Xác nhận giao" (ghi số liệu).
   *   - `reconciled_at` non-NULL → đã đối soát phiếu.
   *
   * ⚠️ KHÔNG dựa vào `status`:
   *   - `DELIVERED` có thể chỉ là tài xế bấm nhanh "Xong" (updateStatus)
   *     mà CHƯA nhập số liệu giao → vẫn phải cho phép ghi sai lệch / số vỏ.
   *   - Ngược lại, phiếu đã nhập số liệu thì khoá lại, không cho tài xế
   *     sửa vô lý (đúng yêu cầu "không cho sửa số liệu đã xác nhận").
   *
   * @param {object} record - row `delivery_records`
   * @returns {boolean}
   */
  static hasConfirmedFigures(record) {
    if (!record) return false;
    const confirmedBy = record.confirmed_by && String(record.confirmed_by).trim() !== '';
    const reconciled = record.reconciled_at && String(record.reconciled_at).trim() !== '';
    return !!(confirmedBy || reconciled);
  }

  /**
   * KIỂM TRA QUYỀN SỬA SỐ LIỆU ĐÃ XÁC NHẬN.
   *
   * Nguyên tắc: "Không cho sửa số liệu đã xác nhận nếu không có quyền quản lý."
   * - Phiếu CHƯA nhập số liệu xác nhận → ai cũng sửa được.
   * - Phiếu ĐÃ nhập số liệu xác nhận / đã đối soát → CHỈ quản lý.
   *
   * @param {object} record - row `delivery_records`
   * @param {object} user - req.user
   * @returns {{allowed:boolean, code?:string, error?:string, reason?:string}}
   */
  static canEditConfirmed(record, user) {
    if (!record) return { allowed: true };

    if (!DeliveryService.hasConfirmedFigures(record)) {
      // Chưa xác nhận số liệu → mọi vai trò được phép sửa.
      return { allowed: true };
    }

    if (hasManagementRole(user)) {
      return { allowed: true, reason: 'Quản lý được phép sửa số liệu đã xác nhận' };
    }

    return {
      allowed: false,
      code: 'MANAGEMENT_REQUIRED',
      error:
        `Phiếu giao #${record.id} đã xác nhận số liệu — ` +
        'chỉ quản lý mới được sửa số liệu đã xác nhận',
    };
  }

  /**
   * Tạo (hoặc lấy) delivery record cho 1 đơn bán.
   * Nếu record đã tồn tại → trả về record cũ (idempotent, tránh nhân đôi).
   */
  static ensureRecord(saleId, driverUsername) {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) return { success: false, error: 'Không tìm thấy đơn hàng' };

    // ── PHÂN QUYỀN THEO KHU VỰC ───────────────────────────────────────────
    // Tài xế KHÔNG được tạo/chiếm đơn giao thuộc khu vực không được phân công.
    // Admin tạo đơn cho khu vực chưa có tài xế → đơn nằm "chờ điều phối",
    // tài xế không tự nhận.
    const access = RegionService.canDriverAccessSale(sale, driverUsername, 'DRIVER');
    // Chỉ bypass khi lý do từ chối là "ngoài phạm vi khu vực" VÀ tài xế chưa
    // được phân công khu vực nào (chế độ chưa áp dụng phân quyền).
    // ⚠️ TUYỆT ĐỐI KHÔNG bypass trường hợp đơn đã gán cho tài xế KHÁC.
    const bypassRegion = RegionService.canBypassRegionCheck(access.code, driverUsername);
    if (!access.allowed && !bypassRegion) {
      logger.warn('[DeliveryService] ensureRecord blocked — outside region', {
        driver: driverUsername,
        saleId,
        regionId: sale.region_id,
        reason: access.reason,
      });
      return {
        success: false,
        error: access.reason || 'Đơn hàng không thuộc khu vực bạn phụ trách',
        code: access.code || 'DRIVER_REGION_FORBIDDEN',
      };
    }

    const existing = db
      .prepare('SELECT * FROM delivery_records WHERE sale_id = ? AND driver_username = ?')
      .get(saleId, driverUsername);
    if (existing) return { success: true, delivery: existing, created: false };

    // Lấy danh sách sản phẩm cần giao từ sale_items
    const items = db
      .prepare(
        `SELECT si.product_id, si.quantity, si.price, si.reward_quantity, si.reward_source,
                p.name AS product_name, p.type AS product_type
         FROM sale_items si
         LEFT JOIN products p ON p.id = si.product_id
         WHERE si.sale_id = ?`
      )
      .all(saleId);

    const expectedKegs = items
      .filter((i) => i.product_type !== 'pet')
      .reduce((sum, i) => sum + (i.quantity || 0), 0);

    try {
      const result = db
        .prepare(
          `INSERT INTO delivery_records
             (sale_id, customer_id, driver_username, status, scheduled_date,
              expected_kegs, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
        )
        .run(
          saleId,
          sale.customer_id || null,
          driverUsername,
          DELIVERY_STATUS.PENDING,
          // `scheduled_date` = ngày LỊCH THỰC giao (dùng `created_on`).
          // Đơn tạo sau 19:00 vẫn thuộc lịch giao HÔM NAY (quyết định
          // "keep-visible" cho Driver Portal), dù `sales.date` đã lùi sang
          // ngày nghiệp vụ ngày mai.
          sale.created_on || sale.date || db.getVietnamDateStr(),
          expectedKegs
        );

      const deliveryId = result.lastInsertRowid;

      // Ghi chi tiết sản phẩm
      const insertItem = db.prepare(
        `INSERT INTO delivery_record_items
           (delivery_id, product_id, product_name, expected_quantity,
            delivered_quantity, is_reward, note)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      );
      for (const item of items) {
        const isReward = (item.reward_quantity || 0) > 0 || item.reward_source === 'MONTHLY_BONUS';
        insertItem.run(
          deliveryId,
          item.product_id,
          item.product_name || '',
          item.quantity || 0,
          isReward ? 1 : 0,
          isReward ? 'Hàng thưởng' : null
        );
      }

      DeliveryService.logEvent(deliveryId, 'CREATED', null, DELIVERY_STATUS.PENDING, driverUsername, {
        saleId,
      });

      const record = db.prepare('SELECT * FROM delivery_records WHERE id = ?').get(deliveryId);
      return { success: true, delivery: record, created: true };
    } catch (e) {
      logger.error('[DeliveryService] ensureRecord error', { error: e.message, saleId });
      return { success: false, error: e.message };
    }
  }

  /**
   * Cập nhật trạng thái đơn giao.
   *
   * @param {number} deliveryId
   * @param {string} toStatus
   * @param {string} driverUsername
   * @param {object} [opts] - { note, failureReason, user, force }
   */
  static updateStatus(deliveryId, toStatus, driverUsername, opts = {}) {
    const record = db
      .prepare('SELECT * FROM delivery_records WHERE id = ? AND driver_username = ?')
      .get(deliveryId, driverUsername);
    if (!record) return { success: false, error: 'Không tìm thấy đơn giao' };

    if (!Object.values(DELIVERY_STATUS).includes(toStatus)) {
      return { success: false, error: 'Trạng thái không hợp lệ' };
    }

    // ── KHOÁ SỐ LIỆU ĐÃ XÁC NHẬN ─────────────────────────────────────────
    // Phiếu đã DELIVERED / DISCREPANCY → chỉ quản lý mới đổi được trạng thái
    // (tránh tài xế tự hạ trạng thái để ghi lại số liệu đã xác nhận).
    const editCheck = DeliveryService.canEditConfirmed(record, opts.user);
    if (!editCheck.allowed && record.status !== toStatus) {
      logger.warn('[DeliveryService] updateStatus blocked — confirmed data', {
        deliveryId,
        driver: driverUsername,
        from: record.status,
        to: toStatus,
        code: editCheck.code,
      });
      return { success: false, error: editCheck.error, code: editCheck.code };
    }

    const allowed = ALLOWED_TRANSITIONS[record.status] || [];
    if (record.status !== toStatus && !allowed.includes(toStatus)) {
      return {
        success: false,
        error: `Không thể chuyển từ "${STATUS_LABELS[record.status]}" sang "${STATUS_LABELS[toStatus]}"`,
      };
    }

    const now = db.getVietnamDateStr() + ' ' + db.getVietnamTimeStr();
    const startedAt = toStatus === DELIVERY_STATUS.IN_PROGRESS ? now : record.started_at;
    const completedAt =
      toStatus === DELIVERY_STATUS.DELIVERED || toStatus === DELIVERY_STATUS.FAILED
        ? now
        : record.completed_at;

    try {
      db.prepare(
        `UPDATE delivery_records
         SET status = ?, started_at = ?, completed_at = ?,
             note = COALESCE(?, note), failure_reason = COALESCE(?, failure_reason),
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        toStatus,
        startedAt,
        completedAt,
        opts.note ?? null,
        toStatus === DELIVERY_STATUS.FAILED ? opts.failureReason || null : null,
        deliveryId
      );

      // Đồng bộ trạng thái giao hàng trên bảng sales (để admin theo dõi)
      try {
        db.prepare('UPDATE sales SET delivery_status = ? WHERE id = ?').run(toStatus, record.sale_id);
      } catch (_) {}

      DeliveryService.logEvent(deliveryId, 'STATUS_CHANGED', record.status, toStatus, driverUsername, {
        note: opts.note || null,
        failureReason: opts.failureReason || null,
      });

      const updated = db.prepare('SELECT * FROM delivery_records WHERE id = ?').get(deliveryId);

      // ── SỔ CÔNG NỢ: ghi công nợ khi đơn chuyển sang DELIVERED ──────────
      // (lỗi sổ công nợ KHÔNG được làm hỏng luồng giao hàng)
      if (toStatus === DELIVERY_STATUS.DELIVERED) {
        try {
          const debtResult = DebtOrderIntegration.onDeliveryStatusChanged({
            saleId: record.sale_id,
            fromStatus: record.status,
            toStatus,
            actor: driverUsername,
          });
          if (debtResult && debtResult.success && !debtResult.skipped) {
            updated.debtTransactionId = debtResult.transactionId;
            updated.debtAmount = debtResult.amountOwed;
            updated.debtBalanceAfter = debtResult.balanceAfter;
          }
        } catch (debtErr) {
          logger.error('[DeliveryService] debt integration error', { error: debtErr.message });
        }
      }

      return { success: true, delivery: updated };
    } catch (e) {
      logger.error('[DeliveryService] updateStatus error', { error: e.message });
      return { success: false, error: e.message };
    }
  }

  /**
   * Xác nhận số lượng giao thực tế (từng sản phẩm) + số vỏ thu hồi.
   * Tính missing/excess/damaged tự động so với expected.
   *
   * @param {number} deliveryId
   * @param {string} driverUsername - username tài xế (hoặc admin sửa hộ)
   * @param {object} payload
   * @param {object} [opts]
   * @param {object} [opts.user] - req.user (dùng để kiểm tra quyền quản lý)
   * @param {boolean} [opts.force] - admin có quyền ghi đè (bỏ qua khoá đối soát)
   */
  static confirmDelivery(deliveryId, driverUsername, payload = {}, opts = {}) {
    const record = db
      .prepare('SELECT * FROM delivery_records WHERE id = ? AND driver_username = ?')
      .get(deliveryId, driverUsername);
    if (!record) return { success: false, error: 'Không tìm thấy đơn giao' };

    // ── ĐỐI SOÁT 1 LẦN (kiểm tra TRƯỚC) ────────────────────────────────
    // Phiếu đã đối soát → không ghi lại số liệu lần 2 (trừ khi admin force).
    // ⚠️ Thứ tự quan trọng: kiểm tra "đã đối soát" TRƯỚC "đã xác nhận" để
    //    thông báo cho người dùng chính xác nguyên nhân bị chặn. Nếu đảo
    //    thứ tự, phiếu đã DELIVERED luôn trả về MANAGEMENT_REQUIRED và che
    //    mất thông báo "đã đối soát".
    const reconState = DeliveryService.getReconciliationState(deliveryId);
    if (reconState.reconciled && !opts.force) {
      logger.warn('[DeliveryService] confirmDelivery blocked — already reconciled', {
        deliveryId,
        driver: driverUsername,
        reconciledAt: reconState.reconciledAt,
        reconciledBy: reconState.reconciledBy,
      });
      return {
        success: false,
        code: 'ALREADY_RECONCILED',
        error:
          `Phiếu giao #${deliveryId} đã được đối soát` +
          (reconState.reconciledAt ? ` (${reconState.reconciledAt})` : '') +
          ' — mỗi hóa đơn giao hàng chỉ được đối soát một lần',
      };
    }

    // ── KHOÁ SỐ LIỆU ĐÃ XÁC NHẬN ─────────────────────────────────────────
    // Phiếu đã DELIVERED / DISCREPANCY → chỉ quản lý mới sửa được.
    const editCheck = DeliveryService.canEditConfirmed(record, opts.user);
    if (!editCheck.allowed) {
      logger.warn('[DeliveryService] confirmDelivery blocked — confirmed data', {
        deliveryId,
        driver: driverUsername,
        status: record.status,
        code: editCheck.code,
      });
      return { success: false, error: editCheck.error, code: editCheck.code };
    }

    const items = payload.items || [];
    const collectedKegs = payload.collectedKegs !== undefined ? parseInt(payload.collectedKegs) : 0;
    const note = payload.note || null;

    try {
      const tx = db.transaction(() => {
        let totalDelivered = 0;
        let totalMissing = 0;
        let totalExcess = 0;
        let totalDamaged = 0;

        for (const input of items) {
          const item = db
            .prepare('SELECT * FROM delivery_record_items WHERE id = ? AND delivery_id = ?')
            .get(input.itemId, deliveryId);
          if (!item) continue;

          const expected = item.expected_quantity || 0;
          const delivered = Number(input.deliveredQuantity ?? expected) || 0;
          const damaged = Number(input.damagedQuantity || 0) || 0;
          // `let` (không phải const): bên dưới có `excess += -missing` khi giao
          // nhiều hơn số lượng cần giao → const sẽ ném "Assignment to constant variable".
          let excess = Number(input.excessQuantity || 0) || 0;

          // Missing = expected - delivered (không âm). Nếu delivered > expected → tính excess.
          let missing = expected - delivered;
          if (missing < 0) {
            excess += -missing;
            missing = 0;
          }

          db.prepare(
            `UPDATE delivery_record_items
             SET delivered_quantity = ?, missing_quantity = ?, excess_quantity = ?,
                 damaged_quantity = ?, note = COALESCE(?, note)
             WHERE id = ?`
          ).run(delivered, missing, excess, damaged, input.note || null, item.id);

          totalDelivered += delivered;
          totalMissing += missing;
          totalExcess += excess;
          totalDamaged += damaged;
        }

        // Thiếu/thừa/hư hỏng → trạng thái DISCREPANCY nếu có sai lệch
        let nextStatus = record.status;
        if (totalMissing > 0 || totalExcess > 0 || totalDamaged > 0) {
          nextStatus = DELIVERY_STATUS.DISCREPANCY;
        } else if (record.status === DELIVERY_STATUS.IN_PROGRESS || record.status === DELIVERY_STATUS.PENDING) {
          nextStatus = DELIVERY_STATUS.DELIVERED;
        }

        db.prepare(
          `UPDATE delivery_records
           SET delivered_liters = ?, missing_liters = ?, excess_liters = ?, damaged_liters = ?,
               collected_kegs = ?, status = ?, completed_at = ?,
               note = COALESCE(?, note), confirmed_by = ?,
               updated_at = datetime('now')
           WHERE id = ?`
        ).run(
          totalDelivered,
          totalMissing,
          totalExcess,
          totalDamaged,
          collectedKegs,
          nextStatus,
          nextStatus === DELIVERY_STATUS.DELIVERED ? db.getVietnamDateStr() + ' ' + db.getVietnamTimeStr() : null,
          note,
          driverUsername,
          deliveryId
        );

        try {
          db.prepare('UPDATE sales SET delivery_status = ? WHERE id = ?').run(nextStatus, record.sale_id);
        } catch (_) {}

        // Đồng bộ vỏ thu về: phiếu giao → sales.return_kegs + tồn vỏ khách + keg_stats
        // (đồng bộ với modal giao/thu vỏ ở màn Bán hàng)
        if (record.sale_id && record.customer_id) {
          DeliveryService.syncCollectedKegs(
            record.sale_id,
            record.customer_id,
            collectedKegs,
            record.collected_kegs || 0,
            `Thu vỏ qua phiếu giao #${deliveryId}`,
            driverUsername
          );
        }

        DeliveryService.logEvent(
          deliveryId,
          'CONFIRMED',
          record.status,
          nextStatus,
          driverUsername,
          {
            delivered: totalDelivered,
            missing: totalMissing,
            excess: totalExcess,
            damaged: totalDamaged,
            collectedKegs,
          }
        );

        return {
          totalDelivered,
          totalMissing,
          totalExcess,
          totalDamaged,
          collectedKegs,
          nextStatus,
        };
      });

      const summary = tx();
      const updated = db.prepare('SELECT * FROM delivery_records WHERE id = ?').get(deliveryId);

      // ── ĐÁNH DẤU ĐÃ ĐỐI SOÁT (chỉ 1 lần) ──────────────────────────────
      // Xác nhận số liệu giao = hoàn tất đối soát phiếu. Ghi `reconciled_at`
      // để các lần ghi sau bị chặn ("Mỗi hóa đơn giao hàng chỉ được đối soát
      // một lần"). `markReconciled` idempotent → không ghi đè dấu vết lần đầu.
      try {
        const recon = DeliveryService.markReconciled(deliveryId, driverUsername);
        if (recon && !recon.alreadyReconciled) {
          updated.reconciled_at = recon.reconciledAt;
          updated.reconciled_by = recon.reconciledBy || driverUsername;
        }
      } catch (reconErr) {
        logger.error('[DeliveryService] markReconciled error', {
          error: reconErr.message,
          deliveryId,
        });
      }

      // ── SỔ CÔNG NỢ: ghi công nợ khi đơn được giao thành công sạch ─────
      // Chỉ ghi khi trạng thái MỚI là DELIVERED (sạch). DISCREPANCY → KHÔNG ghi.
      if (summary.nextStatus === DELIVERY_STATUS.DELIVERED) {
        try {
          const debtResult = DebtOrderIntegration.onDeliveryStatusChanged({
            saleId: record.sale_id,
            fromStatus: record.status,
            toStatus: summary.nextStatus,
            actor: driverUsername,
          });
          if (debtResult && debtResult.success && !debtResult.skipped) {
            updated.debtTransactionId = debtResult.transactionId;
            updated.debtAmount = debtResult.amountOwed;
            updated.debtBalanceAfter = debtResult.balanceAfter;
          }
        } catch (debtErr) {
          logger.error('[DeliveryService] debt integration error', { error: debtErr.message });
        }
      }

      return { success: true, delivery: updated, summary };
    } catch (e) {
      logger.error('[DeliveryService] confirmDelivery error', { error: e.message });
      return { success: false, error: e.message };
    }
  }

  /**
   * Đồng bộ số vỏ thu của phiếu giao về đơn bán + tồn vỏ khách + keg_stats.
   *
   * Bối cảnh: số vỏ "giao đi" nằm ở `sales.deliver_kegs` (do màn Bán hàng
   * nhập), còn số vỏ "thu về" có 2 nguồn:
   *   - `sales.return_kegs`  (màn Bán hàng — modal giao/thu vỏ)
   *   - `delivery_records.collected_kegs` (màn Giao hàng — phiếu giao)
   * Trước đây 2 nguồn này KHÔNG đồng bộ với nhau → tồn vỏ khách bị sai.
   * Hàm này đặt `sales.return_kegs = collectedKegs` (giá trị chuẩn của phiếu
   * giao) rồi cập nhật tồn khách + keg_stats theo đúng delta.
   *
   * @param {number} saleId       id đơn bán
   * @param {number} customerId   id khách
   * @param {number} collected    số vỏ thu về (mới)
   * @param {number} prevCollected số vỏ thu về trước đó trên phiếu giao
   * @param {string} note         ghi chú log
   * @param {string} [driverUsername] tài xế thực hiện (ghi vào log vỏ)
   */
  static syncCollectedKegs(saleId, customerId, collected, prevCollected, note, driverUsername) {
    if (!saleId || !customerId) return;

    const sale = db
      .prepare('SELECT deliver_kegs, return_kegs FROM sales WHERE id = ?')
      .get(saleId);
    if (!sale) return;

    const prevReturned = sale.return_kegs || 0;
    const target = Math.max(0, parseInt(collected) || 0);

    // Delta so với GIÁ TRỊ ĐANG LƯU trên sales (đơn bán là nguồn chuẩn)
    const delta = target - prevReturned;
    if (delta === 0 && target === prevCollected) {
      // Không có thay đổi → vẫn đảm bảo sales khớp phiếu giao
      if (prevReturned !== target) {
        db.prepare('UPDATE sales SET return_kegs = ? WHERE id = ?').run(target, saleId);
      }
      return;
    }

    db.prepare('UPDATE sales SET return_kegs = ? WHERE id = ?').run(target, saleId);

    if (delta === 0) return;

    // Tồn vỏ khách: giao thêm (deliver) đã được cộng lúc tạo đơn,
    // thu về (return) sẽ trừ khỏi tồn khách.
    const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(customerId);
    if (customer) {
      const newBalance = Math.max(0, (customer.keg_balance || 0) - delta);
      db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(newBalance, customerId);
    }

    // keg_stats: thu thêm → empty_collected tăng; giảm thu → trả vỏ cho khách
    // ⚠️ CHO PHÉP ÂM: thu vỏ rỗng từ khách bù được vào số âm (vỏ tạm ứng
    //    trước nhà máy). Xem src/services/KegBalanceService.js.
    const stats = db.prepare('SELECT inventory, empty_collected FROM keg_stats WHERE id = 1').get();
    const newlyCollected = Math.max(0, delta);
    const newlyReturnedToCustomer = Math.max(0, -delta);
    const newEmpty = KegBalanceService.peekEmptyCollected(
      newlyCollected - newlyReturnedToCustomer
    );
    db.prepare(
      "UPDATE keg_stats SET empty_collected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1"
    ).run(newEmpty);

    const totalHolding = db
      .prepare('SELECT COALESCE(SUM(keg_balance), 0) as total FROM customers')
      .get();
    db.prepare(
      "UPDATE keg_stats SET customer_holding = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1"
    ).run(totalHolding.total);

    // Chỉ ghi log khi thu thêm (giảm thu không phải vỏ mới về kho)
    if (newlyCollected > 0) {
      const customer2 = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId);
      AuditService.logKeg({
        type: 'collect',
        quantity: newlyCollected,
        customerId,
        customerName: customer2?.name || '',
        inventoryAfter: stats?.inventory || 0,
        emptyAfter: newEmpty,
        holdingAfter: totalHolding.total,
        note: note || `Thu vỏ qua đơn giao #${saleId}`,
        actor: driverUsername || undefined,
      });
    }
  }

  /**
   * Ghi nhận sai lệch (thiếu / thừa / hư hỏng) — dùng khi giao xong nhưng có vấn đề.
   *
   * @param {number} deliveryId
   * @param {string} driverUsername
   * @param {object} payload
   * @param {object} [opts] - { user, force }
   */
  static recordDiscrepancy(deliveryId, driverUsername, payload = {}, opts = {}) {
    const record = db
      .prepare('SELECT * FROM delivery_records WHERE id = ? AND driver_username = ?')
        .get(deliveryId, driverUsername);
    if (!record) return { success: false, error: 'Không tìm thấy đơn giao' };

    // ── ĐỐI SOÁT 1 LẦN (kiểm tra TRƯỚC) ────────────────────────────────
    const reconState = DeliveryService.getReconciliationState(deliveryId);
    if (reconState.reconciled && !opts.force) {
      logger.warn('[DeliveryService] recordDiscrepancy blocked — already reconciled', {
        deliveryId,
        driver: driverUsername,
        reconciledAt: reconState.reconciledAt,
      });
      return {
        success: false,
        code: 'ALREADY_RECONCILED',
        error:
          `Phiếu giao #${deliveryId} đã được đối soát` +
          (reconState.reconciledAt ? ` (${reconState.reconciledAt})` : '') +
          ' — mỗi hóa đơn giao hàng chỉ được đối soát một lần',
      };
    }

    // ── KHOÁ SỐ LIỆU ĐÃ XÁC NHẬN ─────────────────────────────────────────
    const editCheck = DeliveryService.canEditConfirmed(record, opts.user);
    if (!editCheck.allowed) {
      logger.warn('[DeliveryService] recordDiscrepancy blocked — confirmed data', {
        deliveryId,
        driver: driverUsername,
        status: record.status,
        code: editCheck.code,
      });
      return { success: false, error: editCheck.error, code: editCheck.code };
    }

    const missing = Number(payload.missingLiters || 0) || 0;
    const excess = Number(payload.excessLiters || 0) || 0;
    const damaged = Number(payload.damagedLiters || 0) || 0;

    try {
      db.prepare(
        `UPDATE delivery_records
         SET missing_liters = ?, excess_liters = ?, damaged_liters = ?,
             status = ?, note = COALESCE(?, note), updated_at = datetime('now')
         WHERE id = ?`
      ).run(missing, excess, damaged, DELIVERY_STATUS.DISCREPANCY, payload.note || null, deliveryId);

      try {
        db.prepare('UPDATE sales SET delivery_status = ? WHERE id = ?').run(
          DELIVERY_STATUS.DISCREPANCY,
          record.sale_id
        );
      } catch (_) {}

      DeliveryService.logEvent(
        deliveryId,
        'DISCREPANCY',
        record.status,
        DELIVERY_STATUS.DISCREPANCY,
        driverUsername,
        { missing, excess, damaged }
      );

      const updated = db.prepare('SELECT * FROM delivery_records WHERE id = ?').get(deliveryId);
      return { success: true, delivery: updated };
    } catch (e) {
      logger.error('[DeliveryService] recordDiscrepancy error', { error: e.message });
      return { success: false, error: e.message };
    }
  }

  /**
   * Cập nhật số vỏ keg đã thu hồi trên đơn.
   * Dùng lại cơ chế cập nhật vỏ của hệ thống (keg_stats + customer balance).
   *
   * @param {number} deliveryId
   * @param {string} driverUsername
   * @param {number} collectedKegs
   * @param {object} [opts] - { user, force }
   */
  static updateCollectedKegs(deliveryId, driverUsername, collectedKegs, opts = {}) {
    const record = db
      .prepare('SELECT * FROM delivery_records WHERE id = ? AND driver_username = ?')
      .get(deliveryId, driverUsername);
    if (!record) return { success: false, error: 'Không tìm thấy đơn giao' };

    // ── KHOÁ SỐ LIỆU ĐÃ XÁC NHẬN ─────────────────────────────────────────
    // Số vỏ thu là một phần của số liệu đã xác nhận → cùng quy tắc khoá.
    const editCheck = DeliveryService.canEditConfirmed(record, opts.user);
    if (!editCheck.allowed) {
      logger.warn('[DeliveryService] updateCollectedKegs blocked — confirmed data', {
        deliveryId,
        driver: driverUsername,
        status: record.status,
        code: editCheck.code,
      });
      return { success: false, error: editCheck.error, code: editCheck.code };
    }

    const collected = parseInt(collectedKegs) || 0;
    if (collected < 0) return { success: false, error: 'Số vỏ thu không hợp lệ' };

    try {
      const tx = db.transaction(() => {
        const prev = record.collected_kegs || 0;
        const delta = collected - prev;

        db.prepare(
          `UPDATE delivery_records SET collected_kegs = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(collected, deliveryId);

        // Đồng bộ vỏ thu: đơn bán (sales.return_kegs) + tồn vỏ khách + keg_stats
        // Dùng chung helper với confirmDelivery để 2 nguồn không lệch nhau.
        if (record.sale_id && record.customer_id) {
          DeliveryService.syncCollectedKegs(
            record.sale_id,
            record.customer_id,
            collected,
            prev,
            `Thu vỏ qua đơn giao #${deliveryId}`,
            driverUsername
          );
        }

        DeliveryService.logEvent(deliveryId, 'KEGS_UPDATED', record.status, record.status, driverUsername, {
          collectedKegs: collected,
          delta,
        });
      });

      tx();
      const updated = db.prepare('SELECT * FROM delivery_records WHERE id = ?').get(deliveryId);
      return { success: true, delivery: updated };
    } catch (e) {
      logger.error('[DeliveryService] updateCollectedKegs error', { error: e.message });
      return { success: false, error: e.message };
    }
  }

  /**
   * Dashboard tài xế — chỉ số vận hành, KHÔNG có doanh thu/lợi nhuận.
   */
  static getDashboard(driverUsername, opts = {}) {
    const date = opts.date || db.getVietnamDateStr();

    const counts = db
      .prepare(
        `
        SELECT
          COUNT(*) AS total_orders,
          SUM(CASE WHEN dr.status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered,
          SUM(CASE WHEN dr.status IN ('PENDING', 'IN_PROGRESS') THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN dr.status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN dr.status = 'DISCREPANCY' THEN 1 ELSE 0 END) AS discrepancy,
          COALESCE(SUM(dr.delivered_liters), 0) AS delivered_liters,
          COALESCE(SUM(dr.missing_liters), 0) AS missing_liters,
          COALESCE(SUM(dr.collected_kegs), 0) AS collected_kegs
        FROM delivery_records dr
        WHERE dr.driver_username = ? AND DATE(dr.scheduled_date) = ?
      `
      )
      .get(driverUsername, date);

    // Đơn bán trực tiếp (không qua giao hàng) của tài xế hôm nay
    // (dùng `created_on` = ngày LỊCH THỰC → đơn tạo sau 19:00 vẫn hiện)
    const walkin = db
      .prepare(
        `
        SELECT COUNT(*) AS cnt, COALESCE(SUM(s.total), 0) AS total_amount
        FROM sales s
        WHERE s.driver_username = ?
          AND ${PreOrderSQL.DELIVERY_DATE_EXPR} = ?
          AND s.type = 'sale'
          AND s.archived = 0
          AND (s.customer_id IS NULL OR s.customer_id = 0)
      `
      )
      .get(driverUsername, date);

    // Tổng lít cần giao (từ sale_items của các đơn chưa giao)
    const expected = db
      .prepare(
        `
        SELECT COALESCE(SUM(si.quantity), 0) AS liters
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        LEFT JOIN products p ON p.id = si.product_id
        LEFT JOIN delivery_records dr
               ON dr.sale_id = s.id AND dr.driver_username = ?
        WHERE ${PreOrderSQL.DELIVERY_DATE_EXPR} = ?
          AND s.type = 'sale'
          AND s.archived = 0
          AND (dr.id IS NULL OR dr.status != 'DELIVERED')
          AND (p.type IS NULL OR p.type != 'pet')
      `
      )
      .get(driverUsername, date);

    // Danh sách khách cần ghé
    const stops = db
      .prepare(
        `
        SELECT c.id, c.name, c.phone, c.address,
               COUNT(DISTINCT s.id) AS order_count
        FROM sales s
        JOIN customers c ON c.id = s.customer_id
        LEFT JOIN delivery_records dr
               ON dr.sale_id = s.id AND dr.driver_username = ?
        WHERE ${PreOrderSQL.DELIVERY_DATE_EXPR} = ?
          AND s.type = 'sale' AND s.archived = 0
          AND c.archived = 0
          AND (dr.id IS NULL OR dr.status != 'DELIVERED')
        GROUP BY c.id
        ORDER BY order_count DESC, c.name
      `
      )
      .all(driverUsername, date);

    return {
      date,
      orders: {
        total: counts.total_orders || 0,
        delivered: counts.delivered || 0,
        pending: counts.pending || 0,
        failed: counts.failed || 0,
        discrepancy: counts.discrepancy || 0,
      },
      liters: {
        toDeliver: expected.liters || 0,
        delivered: counts.delivered_liters || 0,
        missing: counts.missing_liters || 0,
      },
      kegs: {
        collected: counts.collected_kegs || 0,
      },
      // KHÔNG có doanh thu / lợi nhuận ở đây — chỉ số vận hành
      walkinOrders: walkin.cnt || 0,
      stops: stops.length,
      stopList: stops,
    };
  }

  /**
   * Ghi log sự kiện giao hàng (audit trail).
   */
  static logEvent(deliveryId, eventType, fromStatus, toStatus, actorUsername, payload = null) {
    try {
      db.prepare(
        `INSERT INTO delivery_events
           (delivery_id, event_type, from_status, to_status, actor_username, payload, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(
        deliveryId,
        eventType,
        fromStatus || null,
        toStatus || null,
        actorUsername || null,
        payload ? JSON.stringify(payload) : null,
        payload && payload.note ? payload.note : null
      );
    } catch (e) {
      logger.error('[DeliveryService] logEvent error', { error: e.message });
    }
  }
}

module.exports = DeliveryService;
module.exports.DELIVERY_STATUS = DELIVERY_STATUS;
module.exports.STATUS_LABELS = STATUS_LABELS;
module.exports.ALLOWED_TRANSITIONS = ALLOWED_TRANSITIONS;
// Khoá đối soát 1 lần + phân quyền sửa số liệu đã xác nhận.
module.exports.MANAGEMENT_ROLES = MANAGEMENT_ROLES;
module.exports.CONFIRMED_STATUSES = CONFIRMED_STATUSES;
module.exports.hasManagementRole = hasManagementRole;
