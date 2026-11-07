/**
 * Migration: Driver Staff Management & Monthly Salary (044)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu:
 *  1. Bảng `driver_staff` — hồ sơ tài xế (thực thể RIÊNG, không dùng chung
 *     bảng `sales_staff` của module Sales). Liên kết 1-1 với `app_users`
 *     (tài khoản đăng nhập Driver Portal).
 *  2. Bảng `driver_monthly_salary` — lương CỨNG theo tháng của tài xế
 *     (base/bonus/deduction/trạng thái trả).
 *
 * Tất cả ADDITIVE — KHÔNG sửa/xóa dữ liệu kinh doanh hiện có.
 */

const migration = {
  id: 44,
  name: 'driver_staff_salary',

  up: (db) => {
    // ── 1. driver_staff ────────────────────────────────────────────────────
    // Hồ sơ tài xế. app_user_id trỏ tới app_users.id (tài khoản đăng nhập).
    // UNIQUE(app_user_id) đảm bảo 1 tài khoản ↔ 1 hồ sơ tài xế.
    db.exec(`
      CREATE TABLE IF NOT EXISTS driver_staff (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_user_id INTEGER,
        username TEXT NOT NULL,
        full_name TEXT,
        phone TEXT,
        monthly_salary REAL NOT NULL DEFAULT 0,
        bank_account TEXT,
        note TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (app_user_id) REFERENCES app_users(id) ON DELETE SET NULL
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_staff_app_user ON driver_staff(app_user_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_driver_staff_username ON driver_staff(username)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_driver_staff_active ON driver_staff(active)`);

    // ── 2. driver_monthly_salary ──────────────────────────────────────────
    // Lương cứng theo tháng. total = base_salary + bonus - deduction.
    db.exec(`
      CREATE TABLE IF NOT EXISTS driver_monthly_salary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_id INTEGER NOT NULL,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        base_salary REAL NOT NULL DEFAULT 0,
        bonus REAL NOT NULL DEFAULT 0,
        deduction REAL NOT NULL DEFAULT 0,
        total REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        paid_at TEXT,
        note TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_id) REFERENCES driver_staff(id) ON DELETE CASCADE,
        UNIQUE(driver_id, year, month)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_driver_salary_period ON driver_monthly_salary(year, month)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_driver_salary_driver ON driver_monthly_salary(driver_id)`);
  },

  // Rollback: chỉ xoá dữ liệu lương tài xế — KHÔNG đụng app_users hay bảng kinh doanh.
  down: (db) => {
    db.exec(`DROP INDEX IF EXISTS idx_driver_salary_driver`);
    db.exec(`DROP INDEX IF EXISTS idx_driver_salary_period`);
    db.exec(`DROP TABLE IF EXISTS driver_monthly_salary`);
    db.exec(`DROP INDEX IF EXISTS idx_driver_staff_active`);
    db.exec(`DROP INDEX IF EXISTS idx_driver_staff_username`);
    db.exec(`DROP INDEX IF EXISTS idx_driver_staff_app_user`);
    db.exec(`DROP TABLE IF EXISTS driver_staff`);
  },
};

module.exports = migration;
