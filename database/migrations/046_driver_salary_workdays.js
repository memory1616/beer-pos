/**
 * Migration: Driver Salary by Working Days (046)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu:
 *  1. `driver_staff.start_date` — NGÀY VÀO LÀM của tài xế (YYYY-MM-DD).
 *     Dùng làm mốc bắt đầu tính số ngày làm trong tháng.
 *  2. `driver_monthly_salary.work_days` — số ngày làm thực tế đã chốt
 *     cho kỳ lương (để đối chiếu, không tính lại mỗi lần mở bảng).
 *  3. `driver_monthly_salary.daily_rate` — lương 1 ngày (lương cơ bản ÷ 26).
 *
 * Công thức lương theo ngày làm:
 *      lương_cơ_bản_theo_ngày = (lương_cố_định_tháng ÷ 26) × số_ngày_làm
 *  trong đó `số_ngày_làm` = số ngày từ ngày vào làm (trong tháng) đến ngày
 *  hiện tại, KHÔNG tính Chủ Nhật.
 *
 * ADDITIVE — chỉ thêm cột, KHÔNG xóa/sửa dữ liệu kinh doanh hiện có.
 */

const migration = {
  id: 46,
  name: 'driver_salary_workdays',

  up: (db) => {
    // ── 1. driver_staff.start_date ────────────────────────────────────────
    // Ngày vào làm. NULL = chưa khai báo (tính từ đầu tháng).
    try {
      db.exec(`ALTER TABLE driver_staff ADD COLUMN start_date TEXT`);
    } catch (e) {
      /* đã tồn tại */
    }

    // ── 2. driver_monthly_salary.work_days / daily_rate ──────────────────
    try {
      db.exec(`ALTER TABLE driver_monthly_salary ADD COLUMN work_days INTEGER`);
    } catch (e) {
      /* đã tồn tại */
    }
    try {
      db.exec(`ALTER TABLE driver_monthly_salary ADD COLUMN daily_rate REAL`);
    } catch (e) {
      /* đã tồn tại */
    }

    // ── 3. Backfill start_date từ created_at (CHỈ 1 LẦN) ──────────────────
    // Hồ sơ tài xế tạo trước khi có tính năng → lấy ngày tạo hồ sơ làm
    // mốc ngày vào làm (xấp xỉ nhất, admin có thể sửa lại trong UI).
    //
    // QUAN TRỌNG: chỉ chạy 1 lần. Nếu chạy mỗi lần khởi động, tài xế tạo
    // mới mà admin cố ý để trống "Ngày vào làm" sẽ bị ghi đè = ngày tạo,
    // khiến số ngày làm nhảy loạn. Dùng cờ trong sync_meta để đánh dấu.
    try {
      const done = db.prepare("SELECT value FROM sync_meta WHERE key = ?").get('driver_workdays_backfill');
      if (!done) {
        db.exec(`
          UPDATE driver_staff
          SET start_date = date(created_at)
          WHERE (start_date IS NULL OR start_date = '')
            AND created_at IS NOT NULL
            AND created_at <> ''
        `);
        db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)").run(
          'driver_workdays_backfill',
          new Date().toISOString()
        );
      }
    } catch (e) {
      // Không có bảng sync_meta hoặc lỗi → bỏ qua, không chặn migration
    }
  },

  // Rollback: chỉ gỡ cột mới — KHÔNG đụng dữ liệu lương/kinh doanh.
  down: (db) => {
    try { db.exec(`ALTER TABLE driver_monthly_salary DROP COLUMN daily_rate`); } catch (e) {}
    try { db.exec(`ALTER TABLE driver_monthly_salary DROP COLUMN work_days`); } catch (e) {}
    try { db.exec(`ALTER TABLE driver_staff DROP COLUMN start_date`); } catch (e) {}
  },
};

module.exports = migration;
