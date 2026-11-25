/**
 * RegionService — Danh mục khu vực kinh doanh & phân công tài xế
 * ─────────────────────────────────────────────────────────────────────────────
 * SINGLE SOURCE OF TRUTH cho toàn bộ logic khu vực:
 *  - Danh mục 9 khu vực (đọc từ bảng `business_regions` — seeded bởi migration 058).
 *  - Gán / thay đổi / ngừng phân công tài xế cho khu vực.
 *  - Lịch sử phân công.
 *  - Thống kê khách hàng & sản lượng theo khu vực.
 *  - Tra cứu tài xế phụ trách hiện hành của một khu vực.
 *
 * Nguyên tắc:
 *  - 1 khu vực → 1 tài xế chính ĐANG HOẠT ĐỘNG (partial unique index ở DB).
 *  - 1 tài xế → N khu vực.
 *  - Khu vực chưa có tài xế → trả về null, KHÔNG chặn đơn hàng.
 *  - Mọi thay đổi phân công đều ghi log (audit_logs + region_assignment_history).
 */

const db = require('../../database');
const logger = require('../utils/logger');
const AuditLogService = require('./AuditLogService');
const PreOrderSQL = require('./PreOrderSQL');

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Chuẩn hoá tên khu vực: bỏ khoảng trắng thừa, so khớp không phân biệt hoa thường. */
function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

/** Chuẩn hoá username tài xế: trim + lowercase. */
function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

/**
 * Tìm khu vực theo id.
 * @returns {object|null}
 */
function getRegionById(id) {
  const rid = parseInt(id, 10);
  if (!rid) return null;
  return db
    .prepare(
      `SELECT id, name, code, active, sort_order, note, created_at, updated_at
       FROM business_regions WHERE id = ?`
    )
    .get(rid) || null;
}

/**
 * Tìm khu vực theo tên (không phân biệt hoa thường).
 * @returns {object|null}
 */
function getRegionByName(name) {
  const n = normalizeName(name);
  if (!n) return null;
  return (
    db
      .prepare(
        `SELECT id, name, code, active, sort_order, note, created_at, updated_at
         FROM business_regions WHERE name = ? COLLATE NOCASE`
      )
      .get(n) || null
  );
}

/**
 * Danh sách khu vực (mặc định chỉ khu vực đang active).
 * @param {{includeInactive?: boolean}} opts
 */
function listRegions(opts = {}) {
  const includeInactive = opts.includeInactive === true;
  const sql = includeInactive
    ? `SELECT id, name, code, active, sort_order, note, created_at, updated_at
       FROM business_regions ORDER BY sort_order, name`
    : `SELECT id, name, code, active, sort_order, note, created_at, updated_at
       FROM business_regions WHERE active = 1 ORDER BY sort_order, name`;
  return db.prepare(sql).all();
}

/**
 * Tài xế phụ trách HIỆN HÀNH của một khu vực.
 * @returns {{username:string, driver_id:number|null, assigned_at:string, assigned_by:string|null}|null}
 */
function getActiveDriver(regionId) {
  const rid = parseInt(regionId, 10);
  if (!rid) return null;
  const row = db
    .prepare(
      `SELECT driver_username, driver_id, assigned_at, assigned_by
       FROM region_driver_assignments
       WHERE region_id = ? AND active = 1
       LIMIT 1`
    )
    .get(rid);
  if (!row) return null;
  return {
    username: row.driver_username,
    driver_id: row.driver_id,
    assigned_at: row.assigned_at,
    assigned_by: row.assigned_by,
  };
}

/**
 * Ngày bắt đầu "kỷ nguyên điều phố theo khu vực" (YYYY-MM-DD giờ VN).
 * ─────────────────────────────────────────────────────────────────────────────
 * Hệ thống khu vực được bật khi bảng `business_regions` được tạo. Các đơn
 * tạo TRƯỚC mốc đó không có snapshot khu vực (và không thuộc hệ thống phân
 * tuyến) → tuyệt đối không được coi là "chờ điều phố" (tránh tràn hàng đợi).
 *
 * @returns {string|null} - null nếu chưa xác định được (→ bỏ qua bộ lọc).
 */
function getDispatchEraStart() {
  try {
    const row = db
      .prepare(
        `SELECT date(MIN(created_at), '+7 hours') AS d FROM business_regions`
      )
      .get();
    return row && row.d ? row.d : null;
  } catch (_) {
    return null;
  }
}

/**
 * Danh sách khu vực đang được gán cho một tài xế (active).
 * @param {string} username
 * @returns {number[]}
 */
function getDriverAssignedRegionIds(username) {
  const u = normalizeUsername(username);
  if (!u) return [];
  try {
    return db
      .prepare(
        `SELECT region_id FROM region_driver_assignments
         WHERE active = 1 AND driver_username = ?`
      )
      .all(u)
      .map((r) => r.region_id);
  } catch (_) {
    return [];
  }
}

/**
 * Danh sách khu vực + tài xế phụ trách + số khách hàng.
 * Dùng cho trang Admin "Quản lý khu vực giao hàng".
 */
function listAssignments() {
  const regions = listRegions({ includeInactive: true });
  return regions.map((r) => {
    const driver = getActiveDriver(r.id);
    const counts = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active
         FROM customers WHERE region_id = ?`
      )
      .get(r.id) || { total: 0, active: 0 };
    return {
      regionId: r.id,
      regionName: r.name,
      regionCode: r.code,
      active: !!r.active,
      driverUsername: driver ? driver.username : null,
      driverId: driver ? driver.driver_id : null,
      assignedAt: driver ? driver.assigned_at : null,
      assignedBy: driver ? driver.assigned_by : null,
      customerCount: counts.total || 0,
      activeCustomerCount: counts.active || 0,
      hasDriver: !!driver,
    };
  });
}

/**
 * Danh sách tài xế (DRIVER) + các khu vực đang phụ trách.
 * Dùng cho UI "gán khu vực" để tránh chồng chéo:
 * mỗi khu vực chỉ được gán cho 1 tài xế tại một thời điểm.
 */
function listDriversWithRegions() {
  const rows = db
    .prepare(
      `SELECT username, full_name, phone, active
       FROM app_users WHERE role = 'DRIVER'
       ORDER BY full_name, username`
    )
    .all();

  const assignments = db
    .prepare(
      `SELECT driver_username, region_id
       FROM region_driver_assignments WHERE active = 1`
    )
    .all();

  // regionId → username
  const ownerByRegion = {};
  const regionsByDriver = {};
  for (const a of assignments) {
    ownerByRegion[a.region_id] = a.driver_username;
    if (!regionsByDriver[a.driver_username]) regionsByDriver[a.driver_username] = [];
    regionsByDriver[a.driver_username].push(a.region_id);
  }

  return rows.map((u) => ({
    username: u.username,
    fullName: u.full_name || u.username,
    phone: u.phone || null,
    active: !!u.active,
    regionIds: regionsByDriver[u.username] || [],
    // Danh sách khu vực đang do TÀI XẾ KHÁC phụ trách (để UI khoá lựa chọn).
    takenRegionIds: Object.keys(ownerByRegion)
      .filter((rid) => ownerByRegion[rid] !== u.username)
      .map(Number),
  }));
}

/**
 * Gán / thay đổi tài xế phụ trách cho khu vực.
 * - Tài xế mới → tự động deactivate tài xế cũ (nếu có) + ghi lịch sử.
 * - Không tự động gỡ các khu vực KHÁC của tài xế cũ (1 tài xế → N khu vực).
 *
 * ⚠️ RÀNG BUỘC CHỐNG CHỒNG CHÉO: mỗi khu vực chỉ có 1 tài xế chính.
 *    Gán tài xế mới cho khu vực đã có tài xế → tài xế cũ bị thay thế
 *    (không phải 2 tài xế cùng giao 1 khu vực).
 *
 * @param {number} regionId
 * @param {string|null} driverUsername - null → ngừng phân công
 * @param {object} opts - { note, actor, req }
 */
function assignDriver(regionId, driverUsername, opts = {}) {
  const rid = parseInt(regionId, 10);
  if (!rid) return { success: false, error: 'Khu vực không hợp lệ' };

  const region = getRegionById(rid);
  if (!region) return { success: false, error: 'Không tìm thấy khu vực' };

  const username = driverUsername ? normalizeUsername(driverUsername) : null;
  let driver = null;

  // Chặn gán cho khu vực đang do tài xế KHÁC phụ trách khi Admin chưa xác nhận.
  if (username && opts.confirmTakeover !== true) {
    const current = getActiveDriver(rid);
    if (current && current.username !== username) {
      const owner = db
        .prepare(
          `SELECT full_name, username FROM app_users WHERE username = ?`
        )
        .get(current.username);
      return {
        success: false,
        requiresConfirm: true,
        code: 'REGION_ALREADY_ASSIGNED',
        currentDriver: current.username,
        currentDriverName: owner?.full_name || current.username,
        error:
          `Khu vực "${region.name}" đang do tài xế ` +
          `"${owner?.full_name || current.username}" phụ trách. ` +
          `Chuyển sang "${username}" sẽ thu hồi khu vực của tài xế cũ.`,
      };
    }
  }

  if (username) {
    driver = db
      .prepare(
        `SELECT id, username, full_name, active FROM driver_staff WHERE username = ?`
      )
      .get(username);
    if (!driver) {
      // Cho phép gán theo tài khoản DRIVER chưa có hồ sơ (driver_staff).
      const account = db
        .prepare(
          `SELECT id, username, full_name, active FROM app_users
           WHERE username = ? AND role = 'DRIVER'`
        )
        .get(username);
      if (!account) {
        return { success: false, error: `Tài xế "${username}" không tồn tại` };
      }
      driver = {
        id: null,
        username: account.username,
        full_name: account.full_name,
        active: account.active,
      };
    }
  }

  const tx = db.transaction(() => {
    const current = getActiveDriver(rid);
    const previousUsername = current ? current.username : null;

    if (previousUsername === username) {
      // Không đổi → chỉ cập nhật ghi chú nếu có
      if (opts.note) {
        db.prepare(
          `UPDATE region_driver_assignments SET note = ?, updated_at = CURRENT_TIMESTAMP
           WHERE region_id = ? AND active = 1`
        ).run(opts.note, rid);
      }
      return { changed: false, previousUsername, newUsername: username };
    }

    // Ngừng phân công tài xế cũ (giữ lịch sử → chuyển active = 0)
    if (previousUsername) {
      db.prepare(
        `UPDATE region_driver_assignments
         SET active = 0, unassigned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE region_id = ? AND active = 1`
      ).run(rid);
    }

    if (username) {
      db.prepare(
        `INSERT INTO region_driver_assignments
           (region_id, driver_username, driver_id, active, assigned_at, assigned_by, note)
         VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?)`
      ).run(rid, username, driver.id, opts.actor || null, opts.note || null);
    }

    return { changed: true, previousUsername, newUsername: username };
  });

  let result;
  try {
    result = tx();
  } catch (err) {
    logger.error('[RegionService] assignDriver error', { error: err.message });
    return { success: false, error: err.message };
  }

  // Số đơn được tái phân công / giữ nguyên (để UI thông báo)
  let reassignedSales = 0;
  let preservedSales = 0;

  // Ghi lịch sử phân công
  if (result.changed) {
    const action = !result.newUsername
      ? 'unassign'
      : (!result.previousUsername ? 'assign' : 'reassign');
    try {
      db.prepare(
        `INSERT INTO region_assignment_history
           (region_id, region_name, action, previous_driver_username, new_driver_username, note, actor_username)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        rid,
        region.name,
        action,
        result.previousUsername,
        result.newUsername,
        opts.note || null,
        opts.actor || null
      );
    } catch (err) {
      logger.error('[RegionService] history insert error', { error: err.message });
    }

    // Ghi vào nhật ký hệ thống (audit_logs)
    try {
      AuditLogService.recordFromRequest(opts.req, 'region_assignment_changed', {
        entity: 'business_region',
        entityId: String(rid),
        description:
          `Phân công tài xế cho khu vực ${region.name}: ` +
          `${result.previousUsername || '(chưa có)'} → ${result.newUsername || '(ngừng)'}`,
        changes: {
          region: { from: region.name, to: region.name },
          driver: { from: result.previousUsername, to: result.newUsername },
        },
      });
    } catch (_) { /* fail-open */ }
  } // ← đóng if (result.changed) — phần đồng bộ đơn chạy cho cả 2 trường hợp

  // ═══════════════════════════════════════════════════════════════════════
  // TÁI PHÂN CÔNG ĐƠN CHƯA KHOÁ của khu vực
  // ═══════════════════════════════════════════════════════════════════════
  // Quy tắc: "Khi Admin thay đổi phân công, quyền mới được áp dụng cho các
  // đơn chưa được khoá hoặc hoàn tất."
  //  - Đơn CHƯA gán tài xế → gán tài xế mới (nếu có).
  //  - Đơn đã gán tài xế CŨ → chuyển sang tài xế mới.
  //  - Đơn đã KHOÁ (DELIVERED/FAILED/DISCREPANCY) → GIỮ NGUYÊN lịch sử.
  //
  // ⚠️ Khối này chạy KỂ CẢ khi `changed = false` (Admin bấm "Lưu" lại cùng
  //    tài xế đang được gán) → đồng bộ lại các đơn CHỜ ĐIỀU PHỐ của khu vực
  //    về tài xế (nếu không, đơn kẹt vĩnh viễn trong hàng đợi).
  let reassigned = 0;
  let preserved = 0;
  const notified = [];
  const released = [];
  try {
      // ── Tìm đơn "chưa hoàn tất" thuộc khu vực ────────────────────────────
      // Ngoài snapshot `s.region_id`, dùng THÊM fallback về `customers.region_id`
      // cho các đơn tạo trước khi khách hàng được gán khu vực (snapshot NULL).
      // Đồng thời chỉ xét đơn thuộc "kỷ nguyên điều phố" (tạo từ ngày hệ
      // thống khu vực bật) → đơn cũ đã giao xong KHÔNG bị đụng tới.
      const eraStart = getDispatchEraStart();
      const eraClause = eraStart
        ? ' AND COALESCE(s.created_on, DATE(s.date)) >= ?'
        : '';
      const eraParams = eraStart ? [eraStart] : [];

      const openSales = db
        .prepare(
          `SELECT s.id FROM sales s
           LEFT JOIN customers c ON c.id = s.customer_id
           WHERE (s.region_id = ? OR (s.region_id IS NULL AND c.region_id = ?))
             AND s.type = 'sale' AND s.archived = 0 AND s.deleted = 0
             ${eraClause}
             AND NOT EXISTS (
               SELECT 1 FROM delivery_records dr
               WHERE dr.sale_id = s.id
                 AND dr.status IN ('DELIVERED','FAILED','DISCREPANCY')
             )`
        )
        .all(rid, rid, ...eraParams);

      for (const s of openSales) {
        const r = assignSaleDriver(s.id, result.newUsername, {
          actor: opts.actor || null,
          note: 'Tự động theo phân công khu vực',
          autoAssign: true,
          // Giữ/ghi snapshot khu vực của đơn (kể cả đơn vốn chưa có snapshot).
          regionId: rid,
          regionName: region.name,
        });
        if (r.success) {
          reassigned++;
          if (result.newUsername) notified.push(s.id);
          else released.push(s.id);
        } else {
          preserved++;
        }
      }
    } catch (err) {
      logger.error('[RegionService] reassign open sales error', { error: err.message });
    }

    // Đồng bộ phiếu giao + thông báo tài xế mới
    if (notified.length) {
      syncDeliveryAndNotify(notified, result.newUsername);
    }

    // Ngừng phân công → giải phóng phiếu giao (đơn về hàng đợi chờ điều phố)
    if (released.length) {
      try {
        for (const sid of released) {
          db.prepare(
            `DELETE FROM delivery_records
             WHERE sale_id = ? AND status IN ('PENDING','IN_PROGRESS')`
          ).run(sid);
        }
      } catch (err) {
        logger.error('[RegionService] release delivery records error', { error: err.message });
      }
    }

    if (reassigned || preserved) {
      logger.info('[RegionService] open sales reassigned', {
        regionId: rid,
        reassigned,
        preserved,
      });
    }
    reassignedSales = reassigned;
    preservedSales = preserved;

  logger.info('[RegionService] assignment changed', {
    regionId: rid,
    from: result.previousUsername,
    to: result.newUsername,
  });

  return {
    success: true,
    changed: result.changed,
    previousDriver: result.previousUsername,
    driver: result.newUsername,
    reassignedSales: reassignedSales,
    preservedSales: preservedSales,
  };
}

/**
 * Ngừng phân công tài xế cho khu vực.
 */
function unassignDriver(regionId, opts = {}) {
  return assignDriver(regionId, null, opts);
}

/**
 * Lịch sử phân công của một khu vực (mới nhất trước).
 */
function getHistory(regionId, limit = 50) {
  const rid = parseInt(regionId, 10);
  if (!rid) return [];
  return db
    .prepare(
      `SELECT id, region_id, region_name, action, previous_driver_username,
              new_driver_username, note, actor_username, created_at
       FROM region_assignment_history
       WHERE region_id = ?
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`
    )
    .all(rid, Math.min(200, Math.max(1, parseInt(limit, 10) || 50)));
}

/**
 * Lịch sử phân công TOÀN BỘ (dùng cho trang Admin xem gần đây).
 */
function listHistory(limit = 100) {
  return db
    .prepare(
      `SELECT id, region_id, region_name, action, previous_driver_username,
              new_driver_username, note, actor_username, created_at
       FROM region_assignment_history
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`
    )
    .all(Math.min(500, Math.max(1, parseInt(limit, 10) || 100)));
}

/**
 * Thống kê theo khu vực: số khách hàng + sản lượng (lít) + doanh thu.
 * @param {{year?:number, month?:number}} opts - bỏ trống → tất cả thời gian
 */
function getStats(opts = {}) {
  const year = opts.year ? parseInt(opts.year, 10) : null;
  const month = opts.month ? parseInt(opts.month, 10) : null;

  let periodClause = '';
  const periodParams = [];
  if (year && month) {
    periodClause = ` AND strftime('%Y', s.date) = ? AND strftime('%m', s.date) = ?`;
    periodParams.push(String(year), String(month).padStart(2, '0'));
  }

  const regions = listRegions({ includeInactive: true });
  return regions.map((r) => {
    const cust = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active
         FROM customers WHERE region_id = ?`
      )
      .get(r.id) || { total: 0, active: 0 };

    const sales = db
      .prepare(
        `SELECT COUNT(DISTINCT s.id) AS orders,
                COALESCE(SUM(s.total), 0) AS revenue
         FROM sales s
         WHERE s.archived = 0 AND s.type = 'sale' AND s.region_id = ?${periodClause}`
      )
      .get(r.id, ...periodParams) || { orders: 0, revenue: 0 };

    const liters = db
      .prepare(
        `SELECT COALESCE(SUM(si.quantity), 0) AS liters
         FROM sales s
         JOIN sale_items si ON si.sale_id = s.id
         WHERE s.archived = 0 AND s.type = 'sale' AND s.region_id = ?${periodClause}`
      )
      .get(r.id, ...periodParams) || { liters: 0 };

    const driver = getActiveDriver(r.id);

    return {
      regionId: r.id,
      regionName: r.name,
      regionCode: r.code,
      active: !!r.active,
      driverUsername: driver ? driver.username : null,
      customerCount: cust.total || 0,
      activeCustomerCount: cust.active || 0,
      orderCount: sales.orders || 0,
      revenue: Math.round((sales.revenue || 0) * 100) / 100,
      liters: Math.round((liters.liters || 0) * 100) / 100,
    };
  });
}

/**
 * Gợi ý khu vực theo tọa độ / địa chỉ (KHÔNG tự động ghi đè lựa chọn của user).
 *
 * - Ưu tiên tọa độ: dùng bảng `business_regions` có tọa độ trung tâm? Chưa có →
 *   dùng tên khu vực trong địa chỉ (khớp không phân biệt hoa thường).
 * - Luôn trả về kèm `confidence` để UI chỉ hiển thị gợi ý.
 *
 * @param {{lat?:number, lng?:number, address?:string}} input
 * @returns {{regionId:number, regionName:string, confidence:'address'|'none'}|null}
 */
function suggestRegion(input = {}) {
  const address = normalizeName(input.address);
  if (!address) return null;
  const lower = address.toLowerCase();
  for (const r of listRegions()) {
    const name = r.name.toLowerCase();
    // Bỏ dấu để so khớp "Hòa Thành" với "Hoa Thanh"
    const plain = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const plainAddress = lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (plainAddress.includes(plain) || lower.includes(name)) {
      return { regionId: r.id, regionName: r.name, confidence: 'address' };
    }
  }
  return null;
}

/**
 * Snapshot khu vực + tài xế cho một đơn hàng (dùng khi tạo đơn).
 * @param {number|null} customerId
 * @returns {{regionId:number|null, regionName:string|null, driverUsername:string|null}}
 */
function resolveForCustomer(customerId) {
  if (!customerId) return { regionId: null, regionName: null, driverUsername: null };
  const cust = db
    .prepare('SELECT id, region_id FROM customers WHERE id = ?')
    .get(customerId);
  if (!cust || !cust.region_id) {
    return { regionId: null, regionName: null, driverUsername: null };
  }
  const region = getRegionById(cust.region_id);
  if (!region) {
    return { regionId: null, regionName: null, driverUsername: null };
  }
  const driver = getActiveDriver(region.id);
  return {
    regionId: region.id,
    regionName: region.name,
    driverUsername: driver ? driver.username : null,
  };
}

/**
 * TỰ ĐỘNG ĐIỀU PHỐ — gán tài xế cho đơn theo khu vực của khách hàng.
 * ─────────────────────────────────────────────────────────────────────────────
 * Luồng nghiệp vụ:
 *   Khách hàng → khu vực (customers.region_id) → tài xế phụ trách
 *   (region_driver_assignments.active = 1)
 *
 * Quy tắc:
 *  - Nếu đơn ĐÃ có tài xế → giữ nguyên (không ghi đè lựa chọn của Admin/tài xế).
 *  - Nếu khách CHƯA có khu vực → không gán (Admin cần phân công khu vực).
 *  - Nếu khu vực CHƯA có tài xế → đơn nằm "chờ điều phố" của Admin.
 *  - Chỉ gán tài xế đang HOẠT ĐỘNG (app_users.active = 1, role = DRIVER).
 *
 * @param {number|null} customerId
 * @returns {{regionId:number|null, regionName:string|null, driverUsername:string|null,
 *            autoAssigned:boolean, reason?:string}}
 */
function autoDispatchForCustomer(customerId) {
  const snapshot = resolveForCustomer(customerId);

  // Khách chưa có khu vực → Admin cần phân công khu vực cho khách.
  if (!snapshot.regionId) {
    return {
      ...snapshot,
      autoAssigned: false,
      reason: 'Khách hàng chưa được gán khu vực — cần Admin phân công',
    };
  }

  // Khu vực chưa có tài xế phụ trách → đơn chờ điều phố.
  if (!snapshot.driverUsername) {
    return {
      ...snapshot,
      autoAssigned: false,
      reason: `Khu vực ${snapshot.regionName} chưa có tài xế phụ trách`,
    };
  }

  // Tài xế phụ trách đã bị khoá/gỡ → không gán (đơn chờ điều phố).
  const active = db
    .prepare(
      `SELECT 1 AS ok FROM app_users
       WHERE username = ? AND role = 'DRIVER' AND active = 1`
    )
    .get(snapshot.driverUsername);
  if (!active) {
    return {
      ...snapshot,
      driverUsername: null,
      autoAssigned: false,
      reason: `Tài xế phụ trách khu vực ${snapshot.regionName} đã bị khoá`,
    };
  }

  return {
    ...snapshot,
    autoAssigned: true,
    reason: `Tự động gán tài xế phụ trách khu vực ${snapshot.regionName}`,
  };
}

/**
 * Validate region id đầu vào (từ API).
 * @returns {{ok:boolean, regionId:number|null, error?:string}}
 */
function validateRegionId(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, regionId: null };
  }
  const rid = parseInt(value, 10);
  if (!rid) return { ok: false, regionId: null, error: 'Khu vực không hợp lệ' };
  const region = getRegionById(rid);
  if (!region) return { ok: false, regionId: null, error: 'Không tìm thấy khu vực' };
  return { ok: true, regionId: rid };
}

// ═══════════════════════════════════════════════════════════════════════════
// PHÂN QUYỀN GIAO HÀNG THEO KHU VỰC
// ═══════════════════════════════════════════════════════════════════════════
//
// Luật bắt buộc:
//  1. MỘT khu vực chỉ có MỘT tài xế chính đang hoạt động.
//  2. MỘT tài xế có thể quản lý NHIỀU khu vực.
//  3. Tài xế chỉ xem/xử lý được đơn thuộc khu vực được phân công.
//  4. Đơn CHƯA CÓ tài xế → "chờ điều phối" (Admin điều phối, tài xế KHÔNG
//     tự nhận nếu khu vực không thuộc quyền).
//  5. Đơn đã KHOÁ / HOÀN TẤT → giữ nguyên snapshot khu vực + tài xế.
//  6. Đổi phân công → quyền mới CHỈ áp dụng cho đơn CHƯA khoá/hoàn tất.
//
// Quyền được kiểm tra ở TẦNG BACKEND (SQL scope + guard), không phải ẩn UI.

/**
 * Trạng thái đơn coi là "đã khoá" (không đổi quyền khi đổi phân công).
 * Đơn đã hoàn tất → giữ nguyên lịch sử tài xế & khu vực.
 */
const LOCKED_DELIVERY_STATUSES = ['DELIVERED', 'FAILED', 'DISCREPANCY'];

/**
 * Trạng thái điều phố của một đơn.
 * ─────────────────────────────────────────────────────────────────────────────
 * - 'AUTO'       : đơn mới được hệ thống TỰ ĐỘNG gán tài xế theo khu vực.
 * - 'MANUAL'     : Admin chỉ định tài xế tay (ghi đè tự động).
 * - 'UNASSIGNED' : đơn mới KHÔNG tìm được tài xế → chờ Admin điều phố.
 * - null         : đơn CŨ (trước khi có hệ thống phân tuyến) → không hiện
 *                  trong danh sách "Đơn chờ điều phố" (đã giao xong rồi).
 */
const DISPATCH_STATUS = {
  AUTO: 'AUTO',
  MANUAL: 'MANUAL',
  UNASSIGNED: 'UNASSIGNED',
};

/**
 * Tính trạng thái điều phố khi tạo đơn.
 * @param {object} opts - { driverUsername, autoDispatch, explicitDriver }
 *   - driverUsername  : tài xế cuối cùng được gán (null = chưa gán)
 *   - autoDispatch    : kết quả RegionService.autoDispatchForCustomer()
 *   - explicitDriver  : true nếu Admin chỉ định tài xế tay
 * @returns {'AUTO'|'MANUAL'|'UNASSIGNED'}
 */
function computeDispatchStatus(opts = {}) {
  const { driverUsername, autoDispatch, explicitDriver } = opts;

  if (driverUsername) {
    // Admin chỉ định tay → MANUAL; hệ thống tự gán → AUTO.
    return explicitDriver ? DISPATCH_STATUS.MANUAL : DISPATCH_STATUS.AUTO;
  }
  // Không có tài xế.
  if (autoDispatch && autoDispatch.reason) {
    return DISPATCH_STATUS.UNASSIGNED;
  }
  // Không chạy auto-dispatch (ví dụ đơn không có khách) → coi như unassigned.
  return DISPATCH_STATUS.UNASSIGNED;
}

/**
 * Ghi trạng thái điều phố cho một đơn.
 * @param {number} saleId
 * @param {'AUTO'|'MANUAL'|'UNASSIGNED'} status
 */
function setSaleDispatchStatus(saleId, status) {
  if (!status) return;
  try {
    db.prepare('UPDATE sales SET dispatch_status = ? WHERE id = ?').run(status, saleId);
  } catch (err) {
    logger.error('[RegionService] setSaleDispatchStatus error', { error: err.message });
  }
}

/**
 * Lấy danh sách id khu vực mà tài xế đang phụ trách.
 * @param {string} username
 * @returns {number[]}
 */
function getDriverRegionIds(username) {
  const u = normalizeUsername(username);
  if (!u) return [];
  try {
    return db
      .prepare(
        `SELECT region_id FROM region_driver_assignments
         WHERE active = 1 AND driver_username = ?`
      )
      .all(u)
      .map((r) => r.region_id);
  } catch (_) {
    return [];
  }
}

/**
 * Tài xế có phụ trách khu vực này không?
 * @param {string} username
 * @param {number|null} regionId
 */
function driverOwnsRegion(username, regionId) {
  if (!regionId) return false;
  const u = normalizeUsername(username);
  if (!u) return false;
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM region_driver_assignments
         WHERE active = 1 AND driver_username = ? AND region_id = ?`
      )
      .get(u, parseInt(regionId, 10));
    return !!row;
  } catch (_) {
    return false;
  }
}

/**
 * Tài xế có quyền xử lý đơn này không?
 *
 * Quy tắc:
 *  - ADMIN → luôn có quyền.
 *  - DRIVER:
 *      + Đơn CHƯA gán tài xế (driver_username rỗng/NULL) → CHỈ được xem nếu
 *        khu vực của đơn nằm trong quyền quản lý. Nếu khu vực KHÔNG thuộc
 *        quyền → từ chối (đúng quy tắc "không được xem đơn ngoài quyền").
 *      + Đơn đã gán cho CHÍNH tài xế → được phép (kể cả khu vực đã đổi).
 *      + Đơn gán cho tài xế KHÁC → từ chối.
 *
 * @param {object} sale - row từ bảng `sales` (cần driver_username, region_id)
 * @param {string} username
 * @param {string} role
 * @returns {{allowed:boolean, reason?:string}}
 */
function canDriverAccessSale(sale, username, role) {
  if (role === 'ADMIN') return { allowed: true };

  const u = normalizeUsername(username);
  if (!u) return { allowed: false, reason: 'Không xác định được tài xế', code: 'DRIVER_SCOPE' };

  const owner = sale?.driver_username ? normalizeUsername(sale.driver_username) : null;

  // Đơn đã gán cho chính tài xế → OK (giữ lịch sử kể cả khi khu vực đổi)
  if (owner && owner === u) return { allowed: true };

  // Đơn gán cho tài xế khác → chặn (KHÔNG BAO GIỜ bypass)
  if (owner) {
    const known = db
      .prepare("SELECT 1 AS ok FROM app_users WHERE role = 'DRIVER' AND username = ?")
      .get(owner);
    if (known) {
      return {
        allowed: false,
        reason: 'Đơn này đã được gán cho tài xế khác',
        code: 'DRIVER_SCOPE',
      };
    }
    // Tài khoản không còn tồn tại → coi như "chưa gán ai" → kiểm tra khu vực
  }

  // Đơn chưa gán ai (hoặc gán tài khoản đã xoá) → kiểm tra khu vực trong quyền
  const regionId = sale?.region_id || null;
  if (!regionId) {
    // Chưa xác định khu vực (dữ liệu legacy) → có thể bypass nếu tài xế chưa
    // được phân công khu vực nào (chế độ chưa áp dụng phân quyền).
    return {
      allowed: false,
      reason: 'Đơn chưa xác định khu vực — cần Admin điều phối',
      code: 'DRIVER_REGION_UNKNOWN',
    };
  }

  // Đơn CÓ khu vực → tài xế phải phụ trách đúng khu vực đó (nghiêm ngặt).
  if (driverOwnsRegion(u, regionId)) return { allowed: true };
  return {
    allowed: false,
    reason: 'Khu vực của đơn không thuộc phạm vi phụ trách của tài xế',
    code: 'DRIVER_REGION_FORBIDDEN',
  };
}

/**
 * Tài xế có quyền xem/xử lý KHÁCH HÀNG này không?
 *
 * Quy tắc:
 *  - ADMIN → luôn có quyền.
 *  - DRIVER:
 *      + Khách chưa gán khu vực → chỉ được xem nếu tài xế CHƯA được phân công
 *        khu vực nào (chế độ chưa áp dụng phân quyền) — tránh vỡ vận hành.
 *      + Khách có khu vực thuộc phạm vi phụ trách → OK.
 *      + Khách có khu vực ngoài phạm vi → từ chối.
 *
 * @param {object} customer - row từ bảng `customers` (cần region_id)
 * @param {string} username
 * @param {string} role
 * @returns {{allowed:boolean, reason?:string}}
 */
function canDriverAccessCustomer(customer, username, role) {
  if (role === 'ADMIN') return { allowed: true };
  const u = normalizeUsername(username);
  if (!u) return { allowed: false, reason: 'Không xác định được tài xế', code: 'DRIVER_SCOPE' };

  const regionId = customer?.region_id || null;

  // Khách chưa có khu vực → chỉ mở khi chưa áp dụng phân quyền khu vực
  // (khách legacy chưa được Admin gán khu vực).
  if (!regionId) {
    if (driverHasNoRegionRestriction(u)) return { allowed: true };
    return {
      allowed: false,
      reason: 'Khách hàng chưa được gán khu vực — cần Admin phân công',
      code: 'DRIVER_REGION_UNKNOWN',
    };
  }

  if (driverOwnsRegion(u, regionId)) return { allowed: true };
  return {
    allowed: false,
    reason: 'Khu vực khách hàng không thuộc phạm vi phụ trách của tài xế',
    code: 'DRIVER_REGION_FORBIDDEN',
  };
}

/**
 * Tài xế CHƯA được gán khu vực nào → đang ở chế độ "chưa áp dụng phân quyền
 * khu vực" (giữ nguyên hành vi cũ) cho tới khi Admin phân công.
 *
 * Bắt buộc để không phá vỡ vận hành hiện tại: hiện có 1 tài xế, chưa gán khu vực.
 *
 * ⚠️ CHỈ áp dụng khi hệ thống CHƯA bắt đầu phân công khu vực. Ngay khi có
 *    bất kỳ phân công active nào trong hệ thống, mọi tài xế chưa được gán
 *    khu vực đều bị giới hạn (không thấy khách/đơn nào) → tránh lộ dữ liệu.
 */
function driverHasNoRegionRestriction(username) {
  const u = normalizeUsername(username);
  if (!u) return true;
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM region_driver_assignments
         WHERE active = 1 AND driver_username = ? LIMIT 1`
      )
      .get(u);
    if (row) return false;

    // Hệ thống đã bắt đầu phân công khu vực → tài xế này KHÔNG có quyền
    // truy cập rộng nữa (Admin cần gán khu vực cho tài xế).
    const any = db
      .prepare(`SELECT 1 AS ok FROM region_driver_assignments WHERE active = 1 LIMIT 1`)
      .get();
    return !any;
  } catch (_) {
    return true;
  }
}

/**
 * Tài xế có được bypass kiểm tra khu vực không?
 *
 * - `DRIVER_SCOPE` (đơn đã gán cho tài xế KHÁC) → KHÔNG BAO GIỜ bypass.
 * - Lỗi khu vực / chưa xác định khu vực → bypass CHỈ khi hệ thống chưa bắt
 *   đầu phân công khu vực (tài xế chưa được gán khu vực nào).
 *
 * @param {string} code - mã lỗi từ canDriverAccessSale / canDriverAccessCustomer
 * @param {string} username
 * @returns {boolean}
 */
function canBypassRegionCheck(code, username) {
  if (code === 'DRIVER_SCOPE') return false;
  if (code !== 'DRIVER_REGION_FORBIDDEN' && code !== 'DRIVER_REGION_UNKNOWN') return false;
  return driverHasNoRegionRestriction(username);
}

/**
 * Điều kiện SQL giới hạn đơn theo khu vực phụ trách của tài xế.
 * Dùng trong query để KHÔNG thể lấy đơn ngoài quyền (bảo mật backend).
 *
 * @param {string} username - username tài xế
 * @param {string} alias - alias bảng sales (mặc định 's')
 * @returns {{sql:string, params:any[]}}
 */
function driverRegionScopeClause(username, alias = 's') {
  const u = normalizeUsername(username);
  if (!u) return { sql: ' AND 1 = 0', params: [] };
  const regionIds = getDriverRegionIds(u);
  if (!regionIds.length) {
    // Tài xế chưa có khu vực nào → chỉ được thấy đơn của chính mình
    return { sql: ` AND ${alias}.driver_username = ?`, params: [u] };
  }
  const placeholders = regionIds.map(() => '?').join(',');
  return {
    sql: ` AND (${alias}.driver_username = ? OR ${alias}.region_id IN (${placeholders}))`,
    params: [u, ...regionIds],
  };
}

/**
 * Đơn đã khoá (hoàn tất / thất bại / sai lệch) — không đổi quyền khi đổi phân công.
 * @param {number} saleId
 */
function isSaleLocked(saleId) {
  const row = db
    .prepare(
      `SELECT dr.status FROM delivery_records dr WHERE dr.sale_id = ? LIMIT 1`
    )
    .get(saleId);
  if (!row) return false;
  return LOCKED_DELIVERY_STATUSES.includes(row.status);
}

/**
 * Gán tài xế cho một đơn (Admin điều phối / chuyển đơn giữa các tài xế).
 * - Không đụng vào đơn đã khoá (DELIVERED/FAILED/DISCREPANCY).
 * - Ghi lại snapshot khu vực nếu đơn chưa có.
 *
 * @param {number} saleId
 * @param {string|null} driverUsername
 * @param {object} opts - { actor, req, note, regionId, regionName }
 *   regionId/regionName: ghi đè snapshot khu vực (dùng cho tái điều phố khi
 *   khách hàng đổi khu vực). Truyền `null` để XOÁ khu vực của đơn.
 */
function assignSaleDriver(saleId, driverUsername, opts = {}) {
  const id = parseInt(saleId, 10);
  if (!id) return { success: false, error: 'Đơn hàng không hợp lệ' };

  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  if (!sale) return { success: false, error: 'Không tìm thấy đơn hàng' };

  if (isSaleLocked(id)) {
    return { success: false, error: 'Đơn đã hoàn tất — không thể đổi tài xế', locked: true };
  }

  const username = driverUsername ? normalizeUsername(driverUsername) : null;
  if (username) {
    const driver = db
      .prepare(
        `SELECT username FROM app_users WHERE username = ? AND role = 'DRIVER' AND active = 1`
      )
      .get(username);
    if (!driver) {
      return { success: false, error: `Tài xế "${username}" không tồn tại hoặc đã bị khoá` };
    }
  }

  // Snapshot khu vực (nếu đơn chưa có) — lấy từ khách hàng
  let regionId = sale.region_id || null;
  let regionName = sale.region_name || null;
  if (!regionId && sale.customer_id) {
    const resolved = resolveForCustomer(sale.customer_id);
    regionId = resolved.regionId;
    regionName = resolved.regionName;
  }

  // Ghi đè khu vực (tái điều phố khi khách đổi khu vực)
  if (Object.prototype.hasOwnProperty.call(opts, 'regionId')) {
    regionId = opts.regionId ?? null;
    regionName = Object.prototype.hasOwnProperty.call(opts, 'regionName')
      ? (opts.regionName ?? null)
      : (regionId ? regionName : null);
  }

  try {
    // Trạng thái điều phố:
    //  - có tài xế → 'MANUAL' (Admin/điều phố gán tay) hoặc 'AUTO' nếu hệ
    //    thống tự gán theo khu vực (opts.autoAssign = true).
    //  - bỏ gán     → 'UNASSIGNED' (đơn quay lại hàng đợi chờ điều phố).
    const dispatchStatus = username
      ? (opts.autoAssign ? DISPATCH_STATUS.AUTO : DISPATCH_STATUS.MANUAL)
      : DISPATCH_STATUS.UNASSIGNED;

    db.prepare(
      `UPDATE sales
       SET driver_username = ?, region_id = ?, region_name = ?,
           region_driver_username = ?, dispatch_status = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(username, regionId, regionName, username, dispatchStatus, id);

    logger.info('[RegionService] sale driver assigned', {
      saleId: id,
      from: sale.driver_username,
      to: username,
      actor: opts.actor || null,
    });
    return { success: true, saleId: id, driverUsername: username, regionId, regionName };
  } catch (err) {
    logger.error('[RegionService] assignSaleDriver error', { error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Đồng bộ phiếu giao + thông báo tài xế sau khi đổi tài xế của một đơn.
 * ─────────────────────────────────────────────────────────────────────────────
 * - Đơn đang có phiếu giao của tài xế KHÁC → chuyển phiếu sang tài xế mới.
 * - Đơn chưa có phiếu giao → tạo phiếu mới (PENDING).
 * - Gửi Socket.IO `order:assigned` + Web Push cho tài xế mới.
 *
 * @param {number[]} saleIds
 * @param {string} driverUsername
 */
function syncDeliveryAndNotify(saleIds, driverUsername) {
  if (!driverUsername || !Array.isArray(saleIds) || !saleIds.length) return;

  try {
    const DeliveryService = require('./DeliveryService');
    for (const sid of saleIds) {
      const dr = db
        .prepare(
          `SELECT id FROM delivery_records
           WHERE sale_id = ? AND driver_username IS NOT NULL AND driver_username != ?`
        )
        .get(sid, driverUsername);
      if (dr) {
        db.prepare(
          `UPDATE delivery_records
           SET driver_username = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).run(driverUsername, dr.id);
      }
      DeliveryService.ensureRecord(sid, driverUsername);
    }
  } catch (err) {
    logger.error('[RegionService] syncDeliveryAndNotify error', { error: err.message });
  }

  try {
    const socketServer = require('../socket/socketServer');
    const PushService = require('./PushService');
    for (const sid of saleIds) {
      const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(sid);
      const customer = sale?.customer_id
        ? db.prepare('SELECT name, phone, address FROM customers WHERE id = ?').get(sale.customer_id)
        : null;
      const payload = {
        saleId: sid,
        customerName: customer?.name || null,
        customerAddress: customer?.address || null,
        customerPhone: customer?.phone || null,
        kegs: sale?.deliver_kegs || 0,
        date: sale?.date,
        saleTime: sale?.sale_time || null,
      };
      socketServer.emitOrderAssigned(driverUsername, payload);
      if (PushService.isEnabled()) {
        PushService.notifyNewOrder({ driverUsername, ...payload }).catch(() => {});
      }
    }
  } catch (err) {
    logger.error('[RegionService] notify driver error', { error: err.message });
  }
}

/**
 * TÁI ĐIỀU PHỔ ĐƠN khi khách hàng đổi khu vực.
 * ─────────────────────────────────────────────────────────────────────────────
 * Khi Admin chuyển khách hàng sang khu vực khác, các đơn CHƯA hoàn tất
 * của khách đó phải được chuyển sang tài xế phụ trách khu vực MỚI
 * (hoặc bỏ gán nếu khu vực mới chưa có tài xế → đơn về hàng đợi chờ điều phố).
 *
 * Quy tắc bất biến lịch sử:
 *  - Đơn đã KHOÁ (DELIVERED/FAILED/DISCREPANCY) → giữ nguyên tài xế + khu vực.
 *  - Đơn CHƯA khoá → cập nhật driver_username + snapshot khu vực.
 *
 * @param {number} customerId
 * @param {number|null} newRegionId - khu vực MỚI của khách (null = bỏ khu vực)
 * @param {object} opts - { actor, req, note }
 * @returns {{success:boolean, reassigned:number, unassigned:number, preserved:number,
 *            driverUsername:string|null, error?:string}}
 */
function redispatchCustomerSales(customerId, newRegionId, opts = {}) {
  const cid = parseInt(customerId, 10);
  if (!cid) return { success: false, error: 'Khách hàng không hợp lệ', reassigned: 0, unassigned: 0, preserved: 0 };

  const regionId = newRegionId ? parseInt(newRegionId, 10) : null;
  let regionName = null;
  let driverUsername = null;

  if (regionId) {
    const region = getRegionById(regionId);
    if (!region) {
      return { success: false, error: 'Không tìm thấy khu vực', reassigned: 0, unassigned: 0, preserved: 0 };
    }
    regionName = region.name;
    const driver = getActiveDriver(regionId);
    driverUsername = driver ? driver.username : null;
  }

  // Đơn của khách còn "mở" (chưa khoá, chưa xoá, chưa archive).
  let openSales = [];
  let lockedSales = [];
  try {
    openSales = db
      .prepare(
        `SELECT s.id FROM sales s
         WHERE s.customer_id = ?
           AND s.type = 'sale' AND s.archived = 0 AND s.deleted = 0
           AND NOT EXISTS (
             SELECT 1 FROM delivery_records dr
             WHERE dr.sale_id = s.id
               AND dr.status IN ('DELIVERED','FAILED','DISCREPANCY')
           )`
      )
      .all(cid);

    // Đơn đã hoàn tất → giữ nguyên lịch sử (không tái điều phố)
    lockedSales = db
      .prepare(
        `SELECT s.id FROM sales s
         WHERE s.customer_id = ?
           AND s.type = 'sale' AND s.archived = 0 AND s.deleted = 0
           AND EXISTS (
             SELECT 1 FROM delivery_records dr
             WHERE dr.sale_id = s.id
               AND dr.status IN ('DELIVERED','FAILED','DISCREPANCY')
           )`
      )
      .all(cid);
  } catch (err) {
    logger.error('[RegionService] redispatchCustomerSales query error', { error: err.message });
    return { success: false, error: err.message, reassigned: 0, unassigned: 0, preserved: 0 };
  }

  let reassigned = 0;
  let unassigned = 0;
  let preserved = lockedSales.length;
  const notified = [];
  const released = [];

  for (const s of openSales) {
    const r = assignSaleDriver(s.id, driverUsername, {
      actor: opts.actor || null,
      req: opts.req || null,
      note: opts.note || 'Tái điều phố: khách hàng đổi khu vực',
      regionId: regionId,
      regionName: regionName,
      autoAssign: true,
    });
    if (!r.success) {
      preserved++;
      continue;
    }
    if (driverUsername) {
      reassigned++;
      notified.push(s.id);
    } else {
      unassigned++;
      released.push(s.id);
    }
  }

  // ── Đồng bộ phiếu giao + báo tài xế MỚI ────────────────────────────────
  // Đơn đã có phiếu giao của tài xế cũ → chuyển phiếu sang tài xế mới
  // (đơn chưa bị khoá) để tài xế mới thấy ngay trong màn "Giao hàng".
  if (notified.length) {
    syncDeliveryAndNotify(notified, driverUsername);
  }

  // ── Giải phóng phiếu giao của tài xế cũ (đơn về hàng đợi chờ điều phố) ──
  if (released.length) {
    try {
      for (const sid of released) {
        db.prepare(
          `DELETE FROM delivery_records
           WHERE sale_id = ? AND status IN ('PENDING','IN_PROGRESS')`
        ).run(sid);
      }
    } catch (err) {
      logger.error('[RegionService] release delivery records error', { error: err.message });
    }
  }

  if (reassigned || unassigned || preserved) {
    logger.info('[RegionService] customer sales redispatched', {
      customerId: cid,
      regionId,
      regionName,
      driverUsername,
      reassigned,
      unassigned,
      preserved,
    });
  }

  return {
    success: true,
    reassigned,
    unassigned,
    preserved,
    driverUsername,
  };
}

/**
 * TÀI XẾ ĐẢM NHẬN ĐƠN — chuyển đơn chờ điều phố sang tài xế đó.
 * ─────────────────────────────────────────────────────────────────────────────
 * Yêu cầu nghiệp vụ:
 *   "Khi tài xế đảm nhận, nếu đơn chưa giao thì sẽ chuyển cho tài xế đó."
 *
 * Cơ chế:
 *  1. Đơn được đảm nhận → `driver_username = tài xế`, `dispatch_status = 'MANUAL'`.
 *  2. Các đơn CHỜ ĐIỀU PHỔ còn lại CÙNG KHU VỰC (và chưa giao) →
 *     chuyển luôn cho tài xế đó (tài xế phụ trách khu vực đó).
 *
 * @param {number} saleId - đơn được đảm nhận
 * @param {string} driverUsername - tài xế đảm nhận
 * @param {object} opts - { actor, req, note, skipRegionCheck, transferRegion }
 *   skipRegionCheck: Admin gán đơn → bỏ qua kiểm tra quyền khu vực.
 *   transferRegion : có kéo các đơn chờ điều phố cùng khu vực sang không.
 * @returns {{success:boolean, claimed:boolean, transferred:number, regionId:number|null,
 *            driverUsername:string, error?:string}}
 */
function claimUnassignedSale(saleId, driverUsername, opts = {}) {
  const id = parseInt(saleId, 10);
  if (!id) return { success: false, error: 'Đơn hàng không hợp lệ', claimed: false, transferred: 0 };

  const username = normalizeUsername(driverUsername);
  if (!username) {
    return { success: false, error: 'Tài xế không hợp lệ', claimed: false, transferred: 0 };
  }

  const skipRegionCheck = opts.skipRegionCheck === true;
  const transferRegion = opts.transferRegion !== false;

  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  if (!sale) return { success: false, error: 'Không tìm thấy đơn hàng', claimed: false, transferred: 0 };

  if (isSaleLocked(id)) {
    return { success: false, error: 'Đơn đã hoàn tất — không thể đảm nhận', claimed: false, transferred: 0 };
  }

  // Xác định khu vực của đơn (snapshot → fallback về khách hàng).
  let regionId = sale.region_id || null;
  let regionName = sale.region_name || null;
  if (!regionId && sale.customer_id) {
    const snapshot = resolveForCustomer(sale.customer_id);
    regionId = snapshot.regionId;
    regionName = snapshot.regionName;
  }

  // Đơn đã có tài xế khác → không cho đảm nhận (giữ nguyên lịch sử).
  const currentDriver = sale.driver_username ? normalizeUsername(sale.driver_username) : null;
  if (currentDriver && currentDriver !== username) {
    return {
      success: false,
      error: 'Đơn này đã được gán cho tài xế khác',
      claimed: false,
      transferred: 0,
    };
  }

  // Tài xế chỉ được đảm nhận đơn thuộc khu vực mình phụ trách
  // (trừ khi chưa áp dụng phân quyền khu vực).
  if (
    regionId &&
    !skipRegionCheck &&
    !driverHasNoRegionRestriction(username) &&
    !driverOwnsRegion(username, regionId)
  ) {
    return {
      success: false,
      error: 'Khu vực của đơn không thuộc phạm vi phụ trách của tài xế',
      code: 'DRIVER_REGION_FORBIDDEN',
      claimed: false,
      transferred: 0,
    };
  }

  // ── 1. Đảm nhận đơn này ────────────────────────────────────────────────
  const claimResult = assignSaleDriver(id, username, {
    actor: opts.actor || null,
    req: opts.req || null,
    note: opts.note || 'Tài xế đảm nhận đơn chờ điều phố',
    regionId: regionId,
    regionName: regionName,
    autoAssign: false,
  });
  if (!claimResult.success) {
    return { success: false, error: claimResult.error, claimed: false, transferred: 0 };
  }

  let transferred = 0;
  const notified = [id];

  // ── 2. Chuyển các đơn chờ điều phố CÙNG KHU VỰC cho tài xế ──────────
  // (chỉ đơn chưa giao + thuộc kỷ nguyên điều phố)
  if (regionId && transferRegion) {
    try {
      const eraStart = getDispatchEraStart();
      const eraClause = eraStart ? ' AND COALESCE(s.created_on, DATE(s.date)) >= ?' : '';
      const eraParams = eraStart ? [eraStart] : [];

      const pending = db
        .prepare(
          `SELECT s.id FROM sales s
           LEFT JOIN customers c ON c.id = s.customer_id
           WHERE s.dispatch_status = 'UNASSIGNED'
             AND (s.driver_username IS NULL OR s.driver_username = '')
             AND COALESCE(s.region_id, c.region_id) = ?
             AND s.type = 'sale' AND s.archived = 0 AND s.deleted = 0
             ${eraClause}
             AND NOT EXISTS (
               SELECT 1 FROM delivery_records dr
               WHERE dr.sale_id = s.id
                 AND dr.status IN ('DELIVERED','FAILED','DISCREPANCY')
             )`
        )
        .all(regionId, ...eraParams);

      for (const p of pending) {
        if (p.id === id) continue;
        const r = assignSaleDriver(p.id, username, {
          actor: opts.actor || null,
          req: opts.req || null,
          note: 'Chuyển cho tài xế đảm nhận khu vực',
          regionId: regionId,
          regionName: regionName,
          autoAssign: false,
        });
        if (r.success) {
          transferred++;
          notified.push(p.id);
        }
      }
    } catch (err) {
      logger.error('[RegionService] claim transfer error', { error: err.message });
    }
  }

  // Đồng bộ phiếu giao + báo tài xế.
  try {
    syncDeliveryAndNotify(notified, username);
  } catch (err) {
    logger.error('[RegionService] claim notify error', { error: err.message });
  }

  logger.info('[RegionService] sale claimed', {
    saleId: id,
    driverUsername: username,
    regionId,
    transferred,
  });

  return {
    success: true,
    claimed: true,
    transferred,
    regionId,
    driverUsername: username,
  };
}

/**
 * Đơn chờ điều phối — cho Admin.
 * ─────────────────────────────────────────────────────────────────────────────
 * CHỈ trả về đơn THỰC SỰ bị bỏ qua auto-dispatch, tức là:
 *   `dispatch_status = 'UNASSIGNED'` — đơn MỚI tạo mà không xác định được
 *   tài xế phụ trách khu vực (khách chưa có khu vực, hoặc khu vực chưa có
 *   tài xế).
 *
 * Đơn CŨ (`dispatch_status IS NULL`) — tức đơn từ trước khi có hệ thống
 * phân tuyến — ĐÃ được giao xong nên KHÔNG hiện trong danh sách này.
 */
function listUnassignedSales(opts = {}) {
  const date = opts.date || null;
  const limit = Math.min(500, parseInt(opts.limit, 10) || 200);
  const params = [];
  let dateClause = '';
  if (date) {
    dateClause = ` AND ${PreOrderSQL.DELIVERY_DATE_EXPR} = ?`;
    params.push(date);
  }
  const rows = db
    .prepare(
      `SELECT s.id, s.date, s.sale_time, s.total, s.customer_id, s.driver_username,
              COALESCE(s.region_id, c.region_id) AS region_id,
              COALESCE(s.region_name, br.name) AS region_name,
              s.delivery_status, s.dispatch_status,
              c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN business_regions br ON br.id = COALESCE(s.region_id, c.region_id)
       WHERE s.type = 'sale' AND s.archived = 0 AND s.deleted = 0
         AND s.dispatch_status = 'UNASSIGNED'
         AND (s.driver_username IS NULL OR s.driver_username = '')
         AND NOT EXISTS (
           SELECT 1 FROM delivery_records dr
           WHERE dr.sale_id = s.id
             AND dr.status IN ('DELIVERED','FAILED','DISCREPANCY')
         )
         ${dateClause}
       ORDER BY s.id DESC
       LIMIT ?`
    )
    .all(...params, limit);

  // Bổ sung lý do chờ điều phố để Admin hiểu ngay cần xử lý gì.
  return rows.map((r) => {
    let reason = null;
    if (!r.region_id) {
      reason = 'Khách hàng chưa có khu vực';
    } else {
      const driver = getActiveDriver(r.region_id);
      if (!driver) {
        reason = `Khu vực ${r.region_name} chưa có tài xế phụ trách`;
      }
    }
    return { ...r, dispatch_reason: reason };
  });
}

module.exports = {
  normalizeName,
  normalizeUsername,
  getRegionById,
  getRegionByName,
  listRegions,
  getActiveDriver,
  listAssignments,
  listDriversWithRegions,
  getDriverAssignedRegionIds,
  getDispatchEraStart,
  assignDriver,
  unassignDriver,
  getHistory,
  listHistory,
  getStats,
  suggestRegion,
  resolveForCustomer,
  autoDispatchForCustomer,
  validateRegionId,
  // Trạng thái điều phố
  DISPATCH_STATUS,
  computeDispatchStatus,
  setSaleDispatchStatus,
  // Phân quyền theo khu vực
  LOCKED_DELIVERY_STATUSES,
  getDriverRegionIds,
  driverOwnsRegion,
  driverHasNoRegionRestriction,
  canBypassRegionCheck,
  canDriverAccessSale,
  canDriverAccessCustomer,
  driverRegionScopeClause,
  isSaleLocked,
  assignSaleDriver,
  claimUnassignedSale,
  redispatchCustomerSales,
  syncDeliveryAndNotify,
  listUnassignedSales,
};


