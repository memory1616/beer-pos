/**
 * Migration: Driver Salary Advance — Ứng lương tài xế (047)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu:
 *  1. Bảng `driver_salary_advances` — ghi nhận các khoản ứng lương cho
 *     tài xế. Admin nhập khi chi trả trước; khoản ứng được TRỪ khỏi
 *     tổng lương tháng khi chốt (lương thực nhận = lương theo ngày
 *     + thưởng − phạt − đã ứng).
 *  2. Cột `advance_paid` trên `driver_monthly_salary` — cờ đánh dấu
 *     khoản ứng đã được bù/trừ trong kỳ lương đó (tránh trừ trùng).
 *
 * Quy ước:
 *  • Mỗi khoản ứng thuộc 1 tài xế + 1 KỲ LƯƠNG (year, month).
 *  • `deducted` = 1 → khoản ứng đã được tính vào total của kỳ lương.
 *  • `status` : pending = đã ghi nhận, settled = đã bù/trừ xong,
 *               cancelled = huỷ (không tính vào lương).
 *  • Số tiền luôn > 0. Admin có thể xoá (xoá mềm: status='cancelled').
 *
 * ADDITIVE — KHÔNG sửa/xoá dữ liệu kinh doanh hiện có.
 */

const migration = {
  id: 47,
  name: 'driver_salary_advance',

  up: (db) => {
    // ── driver_salary_advances ────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS driver_salary_advances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_id INTEGER NOT NULL,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        method TEXT DEFAULT 'cash',
        note TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        deducted INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_id) REFERENCES driver_staff(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_drv_adv_driver ON driver_salary_advances(driver_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_drv_adv_period ON driver_salary_advances(year, month)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_drv_adv_status ON driver_salary_advances(status)`);

    // ── driver_monthly_salary.advance_paid ────────────────────────────────
    try {
      db.exec(`ALTER TABLE driver_monthly_salary ADD COLUMN advance_paid REAL NOT NULL DEFAULT 0`);
    } catch (e) {
      // Cột đã tồn tại → idempotent
    }
  },

  // Rollback: chỉ gỡ bảng + cột mới — KHÔNG đụng driver_staff / bảng kinh doanh.
  down: (db) => {
    try { db.exec(`ALTER TABLE driver_monthly_salary DROP COLUMN advance_paid`); } catch (e) {}
    db.exec(`DROP INDEX IF EXISTS idx_drv_adv_status`);
    db.exec(`DROP INDEX IF EXISTS idx_drv_adv_period`);
    db.exec(`DROP INDEX IF EXISTS idx_drv_adv_driver`);
    db.exec(`DROP TABLE IF EXISTS driver_salary_advances`);
  },
};

module.exports = migration;
