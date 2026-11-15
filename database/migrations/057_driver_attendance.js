/**
 * Migration: Bảng chấm công tài xế (057)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Công thức cũ tính số ngày làm = (ngày vào làm → hôm nay) BỎ QUA CHỦ NHẬT
 *  (mẫu số 26 = 30 − 4 ngày nghỉ). Nhưng thực tế tài xế CÓ ĐI LÀM
 *  Chủ Nhật (đơn hàng cuối tuần rất nhiều) → không được tính lương → thiếu tiền.
 *
 *  Khắc phục: thêm bảng `driver_attendance` — admin CHẤM CÔNG TAY theo từng
 *  ngày cho từng tài xế. Ngày có trong bảng này được cộng thêm vào số ngày
 *  làm (công thức UNION: lịch ∪ chấm công).
 *
 *  Thiết kế:
 *  - UNIQUE(driver_id, work_date) → 1 tài xế 1 ngày chỉ có 1 dòng.
 *  - `work_date` lưu NGÀY LỊCH THỰC (YYYY-MM-DD), không dùng ngày nghiệp vụ
 *    (cutoff 19:00) vì chấm công là việc thực tế, không phải nghiệp vụ bán hàng.
 *  - `note` ghi lý do (vd: "Đi làm CN chợ", "Công tác đặc biệt").
 *  - `created_by` = admin đã chấm (truy vết).
 *
 * ADDITIVE — chỉ tạo bảng mới, KHÔNG sửa/xoá dữ liệu lương hiện có.
 */

const migration = {
  id: 57,
  name: 'driver_attendance',

  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS driver_attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_id INTEGER NOT NULL,
        work_date TEXT NOT NULL,
        note TEXT,
        created_by TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_id) REFERENCES driver_staff(id) ON DELETE CASCADE,
        UNIQUE(driver_id, work_date)
      )
    `);

    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_driver_attendance_driver_date
       ON driver_attendance(driver_id, work_date DESC)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_driver_attendance_date
       ON driver_attendance(work_date DESC)`
    );
  },

  // Rollback: chỉ gỡ bảng chấm công — KHÔNG đụng driver_staff / driver_monthly_salary.
  down: (db) => {
    try {
      db.exec('DROP INDEX IF EXISTS idx_driver_attendance_date');
      db.exec('DROP INDEX IF EXISTS idx_driver_attendance_driver_date');
      db.exec('DROP TABLE IF EXISTS driver_attendance');
    } catch (e) {
      /* ignore */
    }
  },
};

module.exports = migration;
