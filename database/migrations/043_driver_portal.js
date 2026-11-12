/**
 * Migration: Driver Portal — Users, Roles, Delivery Tracking
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu:
 *  1. Thêm bảng `app_users` (tài khoản người dùng + role + password hash)
 *  2. Thêm cột `role` vào `auth_sessions` (phân biệt ADMIN / DRIVER)
 *  3. Thêm cột `driver_username` vào `sales` (ghi nhận tài xế tạo đơn)
 *  4. Thêm bảng `delivery_records` + `delivery_record_items` + `delivery_events`
 *
 * Tất cả đều ADDITIVE — KHÔNG sửa/xóa dữ liệu kinh doanh hiện có.
 */

const migration = {
  id: 43,
  name: 'driver_portal',

  up: (db) => {
    // ── 1. app_users ─────────────────────────────────────────────────────────
    // Bảng tài khoản. Role chỉ có ADMIN hoặc DRIVER (driver KHÔNG thể tự đổi).
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        full_name TEXT,
        phone TEXT,
        role TEXT NOT NULL DEFAULT 'DRIVER',
        active INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        last_login_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_app_users_role ON app_users(role)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_app_users_username ON app_users(username)`);

    // ── 2. auth_sessions.role ───────────────────────────────────────────────
    const sessionCols = db.prepare('PRAGMA table_info(auth_sessions)').all().map((c) => c.name);
    if (!sessionCols.includes('role')) {
      db.exec(`ALTER TABLE auth_sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'ADMIN'`);
    }
    if (!sessionCols.includes('app_user_id')) {
      db.exec(`ALTER TABLE auth_sessions ADD COLUMN app_user_id INTEGER`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_role ON auth_sessions(role)`);

    // ── 3. sales.driver_username ────────────────────────────────────────────
    const saleCols = db.prepare('PRAGMA table_info(sales)').all().map((c) => c.name);
    if (!saleCols.includes('driver_username')) {
      db.exec(`ALTER TABLE sales ADD COLUMN driver_username TEXT`);
    }
    if (!saleCols.includes('delivery_status')) {
      db.exec(`ALTER TABLE sales ADD COLUMN delivery_status TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_driver_username ON sales(driver_username)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_delivery_status ON sales(delivery_status)`);

    // ── 4. delivery_records ─────────────────────────────────────────────────
    // Mỗi đơn giao hàng = 1 record. Gắn với sales.id để liên kết nghiệp vụ bán hàng.
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER,
        customer_id INTEGER,
        driver_username TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        scheduled_date TEXT,
        started_at TEXT,
        completed_at TEXT,
        delivered_liters REAL DEFAULT 0,
        missing_liters REAL DEFAULT 0,
        excess_liters REAL DEFAULT 0,
        damaged_liters REAL DEFAULT 0,
        collected_kegs INTEGER DEFAULT 0,
        expected_kegs INTEGER DEFAULT 0,
        note TEXT,
        failure_reason TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_records_driver ON delivery_records(driver_username)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_records_status ON delivery_records(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_records_sale ON delivery_records(sale_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_records_date ON delivery_records(scheduled_date)`);

    // ── 5. delivery_record_items ────────────────────────────────────────────
    // Chi tiết số lít giao thực tế từng sản phẩm + trạng thái thiếu/thừa/hư hỏng.
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_record_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id INTEGER NOT NULL,
        product_id INTEGER,
        product_name TEXT,
        expected_quantity REAL DEFAULT 0,
        delivered_quantity REAL DEFAULT 0,
        missing_quantity REAL DEFAULT 0,
        excess_quantity REAL DEFAULT 0,
        damaged_quantity REAL DEFAULT 0,
        is_reward INTEGER DEFAULT 0,
        note TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (delivery_id) REFERENCES delivery_records(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_items_delivery ON delivery_record_items(delivery_id)`);

    // ── 6. delivery_events ──────────────────────────────────────────────────
    // Audit trail: mọi thay đổi trạng thái đều ghi lại + tài khoản tài xế.
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        actor_username TEXT,
        payload TEXT,
        note TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (delivery_id) REFERENCES delivery_records(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_events_delivery ON delivery_events(delivery_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_events_actor ON delivery_events(actor_username)`);
  },

  // Rollback: chỉ xóa dữ liệu DRIVER (an toàn), KHÔNG đụng vào bảng kinh doanh.
  down: (db) => {
    db.exec(`DROP TABLE IF EXISTS delivery_events`);
    db.exec(`DROP TABLE IF EXISTS delivery_record_items`);
    db.exec(`DROP TABLE IF EXISTS delivery_records`);
    db.exec(`DROP INDEX IF EXISTS idx_sales_driver_username`);
    db.exec(`DROP INDEX IF EXISTS idx_sales_delivery_status`);
    db.exec(`DROP INDEX IF EXISTS idx_auth_sessions_role`);
    db.exec(`DROP INDEX IF EXISTS idx_app_users_role`);
    db.exec(`DROP INDEX IF EXISTS idx_app_users_username`);
    db.exec(`DROP TABLE IF EXISTS app_users`);
  },
};

module.exports = migration;
