/**
 * Migration: Đặt hàng trước (Pre-order) (063)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Nghiệp vụ mới: Admin có thể tạo đơn hàng ĐẶT TRƯỚC cho ngày giao mong
 *  muốn. Đơn này:
 *   - CHƯA ghi nhận doanh thu (doanh thu chỉ ghi nhận khi THỰC SỰ giao).
 *   - CHƯA hiện trong danh sách giao hàng của tài xế.
 *   - Được hệ thống "đẩy" (release) vào lúc 07:00 sáng của ngày giao → lúc đó
 *     mới ghi nhận doanh thu + gán tài xế + tạo phiếu giao + báo tài xế.
 *
 * Thiết kế:
 *  1. `sales.preorder_status` — TEXT NULL
 *       - NULL            : đơn thường (không phải đặt trước) → hành vi cũ.
 *       - 'SCHEDULED'     : đơn đặt trước, CHỜ ngày giao.
 *       - 'RELEASED'      : đã được đẩy vào giao hàng (ghi nhận doanh thu).
 *  2. `sales.preorder_date` — TEXT NULL — ngày giao mong muốn (YYYY-MM-DD).
 *  3. `sales.preorder_released_at` — TEXT NULL — thời điểm thực sự đẩy.
 *
 *  Ràng buộc CHECK của bảng `sales` chỉ cho phép type IN
 *  ('sale','replacement','gift') → đơn đặt trước vẫn dùng type = 'sale'
 *  (không thêm type mới) để không phá vỡ các query/báo cáo hiện có.
 *  Đơn đặt trước được PHÂN BIỆT bằng `preorder_status`.
 *
 *  Doanh thu: đơn đặt trước có `date` = ngày giao mong muốn, nhưng các query
 *  doanh thu phải LOẠI `preorder_status = 'SCHEDULED'` cho tới khi được
 *  release. Việc này được xử lý ở tầng service (PreOrderService) + các
 *  endpoint đọc doanh thu sẽ dùng helper chung.
 *
 * ADDITIVE — KHÔNG sửa/xoá dữ liệu đơn hàng cũ.
 * Idempotent: PRAGMA check trước khi ALTER.
 * Rollback an toàn: chỉ gỡ cột MỚI.
 */

const migration = {
  id: 66,
  name: 'sale_preorder',

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

    if (!hasColumn('sales', 'preorder_status')) {
      db.exec("ALTER TABLE sales ADD COLUMN preorder_status TEXT");
    }
    if (!hasColumn('sales', 'preorder_date')) {
      db.exec('ALTER TABLE sales ADD COLUMN preorder_date TEXT');
    }
    if (!hasColumn('sales', 'preorder_released_at')) {
      db.exec('ALTER TABLE sales ADD COLUMN preorder_released_at TEXT');
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sales_preorder
      ON sales(preorder_status, preorder_date)
    `);

    // Đồng bộ ngược an toàn: đơn cũ (không có preorder) → preorder_status = NULL
    // (đã là NULL mặc định). Không cần UPDATE.
  },

  down: (db) => {
    const tryExec = (sql) => {
      try { db.exec(sql); } catch (_) { /* ignore */ }
    };
    tryExec('DROP INDEX IF EXISTS idx_sales_preorder');
    tryExec('ALTER TABLE sales DROP COLUMN preorder_released_at');
    tryExec('ALTER TABLE sales DROP COLUMN preorder_date');
    tryExec('ALTER TABLE sales DROP COLUMN preorder_status');
  },
};

module.exports = migration;
