/**
 * Migration: Customer Closure — Chốt khách ngừng bán (064)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Khi khách hàng (quán bar/nhà hàng) NGỪNG BÁN, chủ cửa hàng cần:
 *   1. Thu hồi toàn bộ VỎ bình khách đang giữ.
 *   2. Thu hồi BIA/HÀNG còn tồn ở quán (chưa bán hết) → về kho + hoàn tiền.
 *   3. Hoàn CỌC (tiền khách đặt trước).
 *   4. CHỐT CÔNG NỢ (cấn trừ / xóa nợ / giữ nguyên).
 *   5. Lưu trữ khách (tuỳ chọn).
 *
 *  Migration này tạo 2 bảng lưu PHIẾU CHỐT để có dấu vết kiểm toán:
 *   - `customer_closures`        : 1 phiếu chốt / 1 khách / 1 lần.
 *   - `customer_closure_items`   : chi tiết từng mã hàng đã thu hồi.
 *
 *  ADDITIVE — chỉ tạo bảng mới, KHÔNG sửa dữ liệu cũ.
 *  Idempotent — `CREATE TABLE IF EXISTS`.
 */

const migration = {
  id: 64,
  name: 'customer_closure',

  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS customer_closures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        closure_no TEXT UNIQUE,
        customer_id INTEGER NOT NULL,
        customer_name TEXT,
        closure_date TEXT NOT NULL,
        kegs_empty INTEGER DEFAULT 0,
        kegs_full INTEGER DEFAULT 0,
        kegs_lost INTEGER DEFAULT 0,
        total_goods_amount REAL DEFAULT 0,
        deposit_refund REAL DEFAULT 0,
        total_refund REAL DEFAULT 0,
        debt_before REAL DEFAULT 0,
        debt_mode TEXT,
        debt_after REAL DEFAULT 0,
        cash_refund REAL DEFAULT 0,
        archived INTEGER DEFAULT 0,
        note TEXT,
        actor_username TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS customer_closure_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        closure_id INTEGER NOT NULL,
        product_id INTEGER,
        product_name TEXT,
        product_type TEXT,
        quantity REAL DEFAULT 0,
        unit_price REAL DEFAULT 0,
        amount REAL DEFAULT 0,
        FOREIGN KEY (closure_id) REFERENCES customer_closures(id) ON DELETE CASCADE
      )
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_customer_closures_customer ON customer_closures(customer_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_customer_closure_items_closure ON customer_closure_items(closure_id)');
  },

  down: (db) => {
    try {
      db.exec('DROP TABLE IF EXISTS customer_closure_items');
      db.exec('DROP TABLE IF EXISTS customer_closures');
    } catch (_) {
      /* rollback best-effort */
    }
  },
};

module.exports = migration;
