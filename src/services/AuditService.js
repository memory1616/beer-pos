/**
 * AuditService — LÕI GHI NHẬT KÝ THỐNG NHẤT
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu: gom MỌI thao tác ghi log rải rác (26+ chỗ `INSERT INTO
 * product_audit_log` / `keg_transactions_log` chèn thẳng SQL) vào 1 chỗ.
 *
 * Vì sao cần:
 *  1. Code lặp: cùng 1 câu `INSERT INTO keg_transactions_log (...)` được copy
 *     ở 14 file khác nhau → sửa 1 chỗ là hỏng 13 chỗ còn lại.
 *  2. Thiếu thông tin: log kho / log vỏ KHÔNG có `actor_username` → không biết
 *     AI đã thay đổi kho. Đây là lỗ hổng lớn nhất của audit hiện tại.
 *  3. Lệch múi giờ: `keg_transactions_log.date` lưu `CURRENT_TIMESTAMP` (UTC)
 *     trong khi phần còn lại của hệ thống dùng ngày nghiệp vụ VN (UTC+7) →
 *     lệch 7 tiếng, báo cáo "hôm nay" sai.
 *
 * Nguyên tắc:
 *  - FAIL-OPEN: lỗi ghi log KHÔNG được làm hỏng thao tác chính.
 *  - `actor_username` được suy ra từ `req.user` nếu truyền `req`; nếu không có
 *    (cron / script nền) → 'system'.
 *  - Ngày ghi = NGÀY NGHIỆP VỤ (cutoff 19:00), khớp `sales.date`.
 *
 * API:
 *   AuditService.logStock({...})      → product_audit_log
 *   AuditService.logKeg({...})        → keg_transactions_log
 *   AuditService.log({...})           → audit_logs (nhật ký hệ thống)
 *   AuditService.purgeAll({...})      → dọn cả 3 bảng theo retention
 */

const db = require('../../database');
const logger = require('../utils/logger');

// ── Ngưỡng ──────────────────────────────────────────────────────────────────
const MAX_STRING = 500;
const MAX_NOTE = 1000;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Đọc setting (fallback nếu thiếu / lỗi). */
function getSetting(key, fallback = null) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row || row.value === null || row.value === undefined || row.value === '') {
      return fallback;
    }
    return String(row.value);
  } catch (_) {
    return fallback;
  }
}

/** Ngày nghiệp vụ hiện tại (YYYY-MM-DD, cutoff 19:00 giờ VN). */
function businessDate() {
  try {
    return db.getBusinessDateStr();
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Mốc thời gian đầy đủ theo giờ VN (YYYY-MM-DD HH:MM:SS). */
function businessTimestamp() {
  try {
    const now = new Date();
    const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const d =
      vn.getUTCFullYear() +
      '-' +
      String(vn.getUTCMonth() + 1).padStart(2, '0') +
      '-' +
      String(vn.getUTCDate()).padStart(2, '0');
    return (
      d +
      ' ' +
      String(vn.getUTCHours()).padStart(2, '0') +
      ':' +
      String(vn.getUTCMinutes()).padStart(2, '0') +
      ':' +
      String(vn.getUTCSeconds()).padStart(2, '0')
    );
  } catch (_) {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }
}

/** Cắt chuỗi cho an toàn. */
function cut(value, max = MAX_STRING) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Suy ra actor từ request (nếu có) hoặc từ tham số tường minh.
 * @returns {string} username (mặc định 'system')
 */
function resolveActor(req, explicit) {
  if (explicit) return String(explicit);
  if (req && req.user && req.user.username) return String(req.user.username);
  return 'system';
}

/** Lấy IP client (đã tính trust proxy). */
function resolveIp(req, explicit) {
  if (explicit) return String(explicit);
  try {
    return (req && (req.ip || req.socket?.remoteAddress)) || null;
  } catch (_) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LOG KHO — product_audit_log
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ghi 1 dòng lịch sử thay đổi tồn kho.
 *
 * @param {object} opts
 * @param {number} opts.productId
 * @param {'import'|'export'|'restore'|'adjust'} opts.type
 * @param {number} opts.quantity - dương = cộng, âm = trừ
 * @param {string} [opts.reason] - 'purchase' | 'sale' | 'sale_delete' | 'return' | 'adjust' | 'manual' | 'reward' | 'promo_new_shop'
 * @param {number} [opts.refId]
 * @param {string} [opts.refType]
 * @param {string} [opts.customerName]
 * @param {string} [opts.note]
 * @param {object} [opts.req] - Express request → suy ra actor + IP
 * @param {string} [opts.actor] - username tường minh (ghi đè req.user)
 * @returns {number|null} id dòng vừa ghi
 */
function logStock(opts = {}) {
  try {
    const productId = parseInt(opts.productId, 10);
    if (!productId || Number.isNaN(productId)) return null;

    const type = opts.type || 'adjust';
    const quantity = Number(opts.quantity) || 0;

    const info = db
      .prepare(
        `INSERT INTO product_audit_log
           (product_id, type, quantity, reason, ref_id, ref_type,
            customer_name, note, actor_username, ip_address, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        productId,
        type,
        quantity,
        opts.reason || null,
        opts.refId != null ? parseInt(opts.refId, 10) || null : null,
        opts.refType || null,
        cut(opts.customerName, 200),
        cut(opts.note, MAX_NOTE),
        resolveActor(opts.req, opts.actor),
        resolveIp(opts.req, opts.ipAddress),
        businessTimestamp()
      );

    return info.lastInsertRowid;
  } catch (err) {
    // FAIL-OPEN
    logger.error('[AUDIT] logStock failed', {
      productId: opts.productId,
      type: opts.type,
      error: err.message,
    });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LOG VỎ — keg_transactions_log
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Các `type` hợp lệ của keg_transactions_log (khớp CHECK constraint).
 * Nguồn: database/migration.js — bảng được recreate với đúng danh sách này.
 */
const KEG_TYPES = new Set([
  'deliver',
  'collect',
  'import',
  'adjust',
  'sell_empty',
  'gift',
  'lost',
  'replacement',
  'sale_delete',
  'return',
  'collect_return',
]);

/**
 * Ghi 1 dòng lịch sử giao dịch vỏ.
 *
 * @param {object} opts
 * @param {'deliver'|'collect'|'import'|'adjust'|'sell_empty'|'gift'|'lost'|'replacement'|'sale_delete'|'return'|'collect_return'} opts.type
 * @param {number} opts.quantity
 * @param {number} [opts.exchanged]
 * @param {number} [opts.purchased]
 * @param {number} [opts.customerId]
 * @param {string} [opts.customerName]
 * @param {number} [opts.inventoryAfter]
 * @param {number} [opts.emptyAfter]
 * @param {number} [opts.holdingAfter]
 * @param {number} [opts.lostAfter]
 * @param {string} [opts.note]
 * @param {object} [opts.req]
 * @param {string} [opts.actor]
 * @returns {number|null}
 */
function logKeg(opts = {}) {
  try {
    const type = opts.type;
    if (!KEG_TYPES.has(type)) {
      logger.warn('[AUDIT] logKeg: type không hợp lệ', { type });
      return null;
    }

    const quantity = Number(opts.quantity) || 0;
    const info = db
      .prepare(
        `INSERT INTO keg_transactions_log
           (type, quantity, exchanged, purchased, customer_id, customer_name,
            inventory_after, empty_after, holding_after, lost_after, note,
            actor_username, ip_address, date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        type,
        quantity,
        Number(opts.exchanged) || 0,
        Number(opts.purchased) || 0,
        opts.customerId != null ? parseInt(opts.customerId, 10) || null : null,
        cut(opts.customerName, 200),
        Number(opts.inventoryAfter) || 0,
        Number(opts.emptyAfter) || 0,
        Number(opts.holdingAfter) || 0,
        Number(opts.lostAfter) || 0,
        cut(opts.note, MAX_NOTE),
        resolveActor(opts.req, opts.actor),
        resolveIp(opts.req, opts.ipAddress),
        opts.date || businessTimestamp()
      );

    return info.lastInsertRowid;
  } catch (err) {
    logger.error('[AUDIT] logKeg failed', {
      type: opts.type,
      error: err.message,
    });
    return null;
  }
}

/**
 * Lấy trạng thái vỏ hiện tại (dùng làm giá trị `*_after`).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.raw] - true → tồn kho dùng SUM(stock) (có âm),
 *        false (mặc định) → chỉ tồn dương.
 * @returns {{inventory:number, emptyCollected:number, customerHolding:number, lost:number}}
 */
function kegState(opts = {}) {
  const state = { inventory: 0, emptyCollected: 0, customerHolding: 0, lost: 0 };
  try {
    const sql = opts.raw ? db.SQL_KEG_WAREHOUSE_RAW_STOCK : db.SQL_KEG_WAREHOUSE_POSITIVE_STOCK;
    const inv = db.prepare(sql).get();
    state.inventory = inv?.total || 0;
  } catch (_) {
    /* ignore */
  }
  try {
    const stats = db.prepare('SELECT empty_collected, lost FROM keg_stats WHERE id = 1').get();
    state.emptyCollected = stats?.empty_collected || 0;
    state.lost = stats?.lost || 0;
  } catch (_) {
    /* ignore */
  }
  try {
    const hold = db.prepare('SELECT COALESCE(SUM(keg_balance), 0) AS t FROM customers').get();
    state.customerHolding = hold?.t || 0;
  } catch (_) {
    /* ignore */
  }
  return state;
}

/**
 * Ghi log vỏ + tự lấy trạng thái `*_after` nếu không truyền.
 * Đây là hàm được dùng phổ biến nhất (giao/thu/nhập/điều chỉnh).
 *
 * @param {object} opts - như logKeg, nhưng có thể bỏ qua `*_after`
 * @returns {number|null}
 */
function logKegWithState(opts = {}) {
  const state = kegState();
  return logKeg({
    ...opts,
    inventoryAfter: opts.inventoryAfter ?? state.inventory,
    emptyAfter: opts.emptyAfter ?? state.emptyCollected,
    holdingAfter: opts.holdingAfter ?? state.customerHolding,
    lostAfter: opts.lostAfter ?? state.lost,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// RETENTION — dọn log cũ
// ═══════════════════════════════════════════════════════════════════════════

/** Số ngày giữ mặc định cho từng bảng (đọc từ settings, có fallback). */
function retentionPolicy() {
  return {
    auditLogs: Math.max(1, parseInt(getSetting('audit_log_retention_days', '180'), 10) || 180),
    stockLogs: Math.max(1, parseInt(getSetting('stock_log_retention_days', '365'), 10) || 365),
    kegLogs: Math.max(1, parseInt(getSetting('keg_log_retention_days', '365'), 10) || 365),
  };
}

/** Mốc thời gian (ISO) của N ngày trước. */
function cutoffIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

/**
 * Dọn log cũ ở CẢ 3 bảng.
 *
 * @param {object} [opts]
 * @param {number} [opts.days] - ghi đè số ngày cho TẤT CẢ bảng
 * @param {number} [opts.auditDays]
 * @param {number} [opts.stockDays]
 * @param {number} [opts.kegDays]
 * @param {boolean} [opts.dryRun] - chỉ đếm, không xoá
 * @returns {{deleted:number, deletedByTable:object, total:number, policy:object}}
 */
function purgeAll(opts = {}) {
  const policy = retentionPolicy();
  const auditDays = Math.max(1, parseInt(opts.auditDays ?? opts.days, 10) || policy.auditLogs);
  const stockDays = Math.max(1, parseInt(opts.stockDays ?? opts.days, 10) || policy.stockLogs);
  const kegDays = Math.max(1, parseInt(opts.kegDays ?? opts.days, 10) || policy.kegLogs);
  const dryRun = opts.dryRun === true;

  const result = { audit_logs: 0, product_audit_log: 0, keg_transactions_log: 0 };

  const targets = [
    { table: 'audit_logs', days: auditDays, col: 'created_at' },
    { table: 'product_audit_log', days: stockDays, col: 'created_at' },
    { table: 'keg_transactions_log', days: kegDays, col: 'date' },
  ];

  for (const t of targets) {
    try {
      const cutoff = cutoffIso(t.days);
      if (dryRun) {
        const row = db
          .prepare(`SELECT COUNT(*) AS c FROM ${t.table} WHERE ${t.col} < ?`)
          .get(cutoff);
        result[t.table] = row.c || 0;
      } else {
        const info = db.prepare(`DELETE FROM ${t.table} WHERE ${t.col} < ?`).run(cutoff);
        result[t.table] = info.changes || 0;
      }
    } catch (err) {
      logger.error('[AUDIT] purge failed', { table: t.table, error: err.message });
    }
  }

  const total = result.audit_logs + result.product_audit_log + result.keg_transactions_log;

  if (!dryRun && total > 0) {
    logger.info('[AUDIT] Purged old logs', {
      audit_logs: result.audit_logs,
      product_audit_log: result.product_audit_log,
      keg_transactions_log: result.keg_transactions_log,
      total,
    });
  }

  return {
    // `deleted` = TỔNG số dòng đã xoá (tương thích ngược với API cũ).
    deleted: total,
    // Chi tiết theo từng bảng.
    deletedByTable: result,
    total,
    policy: {
      auditLogs: auditDays,
      stockLogs: stockDays,
      kegLogs: kegDays,
    },
  };
}

module.exports = {
  MAX_STRING,
  MAX_NOTE,
  KEG_TYPES,
  getSetting,
  businessDate,
  businessTimestamp,
  cut,
  resolveActor,
  logStock,
  logKeg,
  logKegWithState,
  kegState,
  retentionPolicy,
  purgeAll,
};
