/**
 * AuditRetentionService — DỌN LOG CŨ TỰ ĐỘNG
 * ─────────────────────────────────────────────────────────────────────────────
 * Vấn đề: 3 bảng nhật ký (`audit_logs`, `product_audit_log`,
 * `keg_transactions_log`) phình vô hạn vì không ai dọn → DB nặng dần,
 * truy vấn lịch sử chậm dần.
 *
 * Cơ chế:
 *  - Cron chạy mỗi đêm (03:30 giờ VN) → gọi `AuditService.purgeAll()`.
 *  - Số ngày giữ đọc từ settings (admin chỉnh được qua UI):
 *      audit_log_retention_days   (mặc định 180)
 *      stock_log_retention_days   (mặc định 365)
 *      keg_log_retention_days     (mặc định 365)
 *  - Đặt giá trị = 0 hoặc xoá setting → KHÔNG dọn bảng đó.
 *  - Mỗi lần dọn đều ghi 1 dòng `audit_logs` (action='audit_log_purged')
 *    để admin biết đã dọn bao nhiêu — nhưng dòng này KHÔNG bị dọn
 *    (vì mới ghi).
 */

const AuditService = require('./AuditService');
const logger = require('../utils/logger');

/**
 * Chạy 1 vòng dọn log.
 * @param {object} [opts] - truyền vào AuditService.purgeAll()
 * @returns {object} kết quả
 */
function runPurge(opts = {}) {
  try {
    const result = AuditService.purgeAll(opts);
    logger.info('[AUDIT_RETENTION] Purge completed', {
      total: result.total,
      ...result.deletedByTable,
    });
    return result;
  } catch (err) {
    logger.error('[AUDIT_RETENTION] Purge failed', { error: err.message });
    return {
      deleted: 0,
      deletedByTable: { audit_logs: 0, product_audit_log: 0, keg_transactions_log: 0 },
      total: 0,
      error: err.message,
    };
  }
}

/**
 * Đăng ký cron dọn log (gọi từ server.js).
 *
 * @param {object} [options]
 * @param {string} [options.cron] - biểu thức cron (mặc định 03:30 hằng ngày)
 * @param {string} [options.timezone]
 * @returns {object|null} task cron (null nếu không đăng ký được)
 */
function scheduleRetention(options = {}) {
  try {
    const cron = require('node-cron');
    const expr = options.cron || '30 3 * * *';

    const task = cron.schedule(
      expr,
      async () => {
        runPurge();
      },
      { timezone: options.timezone || 'Asia/Ho_Chi_Minh' }
    );

    logger.info('[AUDIT_RETENTION] Scheduled daily purge', { cron: expr });
    return task;
  } catch (e) {
    logger.error('[AUDIT_RETENTION] Failed to schedule purge', { error: e.message });
    return null;
  }
}

/**
 * Thống kê tình trạng bảng log (dùng cho UI Admin).
 * @returns {{tables: object[], totalRows:number, totalBytes:number, policy:object}}
 */
function stats() {
  const policy = AuditService.retentionPolicy();
  const tables = [];
  let totalRows = 0;

  const specs = [
    { name: 'audit_logs', label: 'Nhật ký hệ thống', col: 'created_at', days: policy.auditLogs },
    { name: 'product_audit_log', label: 'Lịch sử kho', col: 'created_at', days: policy.stockLogs },
    { name: 'keg_transactions_log', label: 'Lịch sử giao dịch vỏ', col: 'date', days: policy.kegLogs },
  ];

  for (const s of specs) {
    try {
      const row = countTable(s.name);
      totalRows += row.count;
      tables.push({
        table: s.name,
        label: s.label,
        rows: row.count,
        oldest: row.oldest,
        newest: row.newest,
        retentionDays: s.days,
        sizeBytes: row.bytes,
      });
    } catch (err) {
      logger.error('[AUDIT_RETENTION] stats failed', { table: s.name, error: err.message });
      tables.push({ table: s.name, label: s.label, rows: 0, error: err.message });
    }
  }

  return { tables, totalRows, policy };
}

/** Đếm số dòng + tìm khoảng thời gian + ước lượng dung lượng của 1 bảng. */
function countTable(table) {
  const db = require('../../database');
  const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c || 0;
  const range = db
    .prepare(`SELECT MIN(rowid) AS minId, MAX(rowid) AS maxId FROM ${table}`)
    .get();
  let oldest = null;
  let newest = null;
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const dateCol = cols.includes('created_at')
      ? 'created_at'
      : cols.includes('date')
        ? 'date'
        : null;
    if (dateCol) {
      const r = db
        .prepare(
          `SELECT MIN(${dateCol}) AS oldest, MAX(${dateCol}) AS newest FROM ${table}`
        )
        .get();
      oldest = r?.oldest || null;
      newest = r?.newest || null;
    }
  } catch (_) {
    /* ignore */
  }

  // Ước lượng dung lượng: trung bình ~150 byte/dòng cho bảng log
  const bytes = count * 150;

  return { count, oldest, newest, bytes, minId: range?.minId, maxId: range?.maxId };
}

module.exports = {
  runPurge,
  scheduleRetention,
  stats,
};
