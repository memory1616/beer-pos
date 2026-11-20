/**
 * Migration: Customer closure devices + per-type full kegs (065)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Khi chốt khách ngừng bán, ngoài vỏ bình và hàng tồn, chủ cửa hàng còn phải
 *  thu hồi THIẾT BỊ (tủ lạnh) đang đặt tại quán. Thiết bị phải được:
 *    1. Ghi lại trong phiếu chốt (dấu vết kiểm toán) → bảng `customer_closure_devices`.
 *    2. Trả về kho (`devices.status = 'available'`, `customer_id = NULL`).
 *    3. Đồng bộ `customers.horizontal_fridge` / `vertical_fridge` về 0.
 *
 *  Ngoài ra, bảng `customer_closures` cần thêm cột `devices_returned` để đếm
 *  nhanh số thiết bị đã thu hồi.
 *
 *  ADDITIVE — chỉ tạo bảng mới + thêm cột, KHÔNG sửa dữ liệu cũ.
 *  Idempotent — `CREATE TABLE IF NOT EXISTS` + kiểm tra PRAGMA trước khi ALTER.
 */

const migration = {
  id: 65,
  name: 'customer_closure_devices',

  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS customer_closure_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        closure_id INTEGER NOT NULL,
        device_id INTEGER,
        device_name TEXT,
        device_type TEXT,
        serial_number TEXT,
        note TEXT,
        FOREIGN KEY (closure_id) REFERENCES customer_closures(id) ON DELETE CASCADE
      )
    `);

    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_customer_closure_devices_closure ON customer_closure_devices(closure_id)'
    );

    // Thêm cột `devices_returned` vào `customer_closures` (nếu chưa có).
    const cols = db.prepare('PRAGMA table_info(customer_closures)').all().map((c) => c.name);
    if (!cols.includes('devices_returned')) {
      db.exec(
        'ALTER TABLE customer_closures ADD COLUMN devices_returned INTEGER DEFAULT 0'
      );
    }
  },

  down: (db) => {
    try {
      db.exec('DROP TABLE IF EXISTS customer_closure_devices');
    } catch (_) {
      /* rollback best-effort */
    }
    try {
      const cols = db.prepare('PRAGMA table_info(customer_closures)').all().map((c) => c.name);
      if (cols.includes('devices_returned')) {
        db.exec('ALTER TABLE customer_closures DROP COLUMN devices_returned');
      }
    } catch (_) {
      /* rollback best-effort */
    }
  },
};

module.exports = migration;
