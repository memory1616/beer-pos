/**
 * Migration: Debt Management — cờ "bán chịu" trên đơn hàng (054)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Module Sổ Công nợ ghi công nợ khi đơn chuyển sang DELIVERED (đúng yêu cầu
 *  nghiệp vụ). Nhưng Beer POS hiện chỉ có cờ `debt` trong payload TẠO ĐƠN
 *  (`routes/api/sales.js`) — cờ này KHÔNG được lưu xuống DB, nên sau khi đơn
 *  được tạo không còn cách nào biết đơn đó là "bán chịu" hay "giao thu tiền".
 *
 *  → Thêm cột `sales.is_credit` (0/1) làm DẤU HIỆU BỀN VỮNG:
 *     1 = đơn bán chịu  → khi DELIVERED sẽ ghi bút toán ORDER_DEBT
 *     0 = đơn thu tiền  → không ghi công nợ
 *
 *  ADDITIVE: chỉ thêm 1 cột, KHÔNG sửa/xoá dữ liệu nào.
 *  Rollback: `ALTER TABLE sales DROP COLUMN is_credit` (SQLite ≥ 3.35).
 */

const migration = {
  id: 54,
  name: 'debt_sale_credit_flag',

  up: (db) => {
    const log = (m) => {
      try {
        // eslint-disable-next-line no-console
        console.log(`[MIGRATION 054] ${m}`);
      } catch (_) {
        /* ignore */
      }
    };

    try {
      const cols = db.prepare('PRAGMA table_info(sales)').all().map((c) => c.name);
      if (!cols.includes('is_credit')) {
        db.exec('ALTER TABLE sales ADD COLUMN is_credit INTEGER NOT NULL DEFAULT 0');
        log('  Added sales.is_credit');
      } else {
        log('  sales.is_credit already exists');
      }
    } catch (e) {
      log(`  Warning: sales.is_credit: ${e.message}`);
    }

    // Index phục vụ đối soát: các đơn bán chịu đã giao nhưng chưa có bút toán
    try {
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_sales_is_credit
         ON sales(is_credit, delivery_status)`
      );
    } catch (e) {
      log(`  Warning: idx_sales_is_credit: ${e.message}`);
    }
  },

  down: (db) => {
    try {
      db.exec('DROP INDEX IF EXISTS idx_sales_is_credit');
      const cols = db.prepare('PRAGMA table_info(sales)').all().map((c) => c.name);
      if (cols.includes('is_credit')) {
        db.exec('ALTER TABLE sales DROP COLUMN is_credit');
      }
    } catch (e) {
      // SQLite cũ không hỗ trợ DROP COLUMN → bỏ qua, cột vô hại
    }
  },
};

module.exports = migration;
