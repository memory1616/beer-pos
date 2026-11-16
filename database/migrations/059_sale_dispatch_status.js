/**
 * Migration: Trạng thái điều phố đơn hàng (059)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Trước migration này, danh sách "Đơn chờ điều phố" của Admin liệt kê MỌI
 *  đơn cũ chưa có `driver_username` (hàng trăm đơn từ trước khi có hệ thống
 *  phân tuyến). Những đơn đó thực tế ĐÃ được giao (có dấu hiệu thu vỏ, đã
 *  vào lịch giao), chỉ là dữ liệu driver không được ghi lại.
 *
 *  Yêu cầu: danh sách "Đơn chờ điều phố" CHỈ hiện đơn THỰC SỰ bị bỏ qua
 *  auto-dispatch — tức là đơn MỚI tạo mà không xác định được tài xế.
 *
 * Thiết kế (ADDITIVE — KHÔNG sửa/xoá dữ liệu đơn hàng cũ):
 *  1. `sales.dispatch_status` — TEXT NULL
 *       - NULL  : đơn không đi qua hệ thống điều phố (đơn cũ) → KHÔNG hiện.
 *       - 'UNASSIGNED' : đơn mới, auto-dispatch KHÔNG tìm được tài xế → hiện
 *                      trong danh sách chờ điều phố.
 *       - 'AUTO' : đơn mới đã được tự động gán tài xế (đã xử lý).
 *       - 'MANUAL': Admin gán tay (đã xử lý).
 *  2. Index phục vụ truy vấn danh sách chờ điều phố.
 *
 * Idempotent: PRAGMA check trước khi ALTER.
 * Rollback an toàn: chỉ gỡ cột MỚI.
 */

const migration = {
  id: 59,
  name: 'sale_dispatch_status',

  up: (db) => {
    const hasColumn = (table, col) => {
      try {
        return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
      } catch (_) {
        return false;
      }
    };
    const hasTable = (table) => {
      try {
        return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      } catch (_) {
        return false;
      }
    };

    if (!hasTable('sales')) return;

    if (!hasColumn('sales', 'dispatch_status')) {
      db.exec('ALTER TABLE sales ADD COLUMN dispatch_status TEXT');
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_dispatch_status ON sales(dispatch_status)`);

    // Đồng bộ ngược: đơn đã có driver_username → coi như đã xử lý (AUTO/MANUAL),
    // để danh sách "chờ điều phố" không bị lẫn đơn đã gán.
    try {
      db.exec(`
        UPDATE sales
           SET dispatch_status = 'AUTO'
         WHERE (driver_username IS NOT NULL AND driver_username != '')
           AND dispatch_status IS NULL
      `);
    } catch (_) { /* ignore */ }
  },

  down: (db) => {
    const tryExec = (sql) => {
      try { db.exec(sql); } catch (_) { /* ignore */ }
    };
    tryExec('DROP INDEX IF EXISTS idx_sales_dispatch_status');
    tryExec('ALTER TABLE sales DROP COLUMN dispatch_status');
  },
};

module.exports = migration;
