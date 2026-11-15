/**
 * DriverAttendanceService — BẢNG CHẤM CÔNG TÀI XẾ
 * ─────────────────────────────────────────────────────────────────────────────
 * Vì sao cần:
 *  Công thức lương cũ suy ra số ngày làm từ LỊCH (start_date → hôm nay) và
 *  CỨNG BỎ QUA CHỦ NHẬT (mẫu số 26). Thực tế tài xế CÓ ĐI LÀM Chủ Nhật
 *  (đơn cuối tuần rất nhiều) → không được tính lương → thiếu tiền tài xế.
 *
 * Cách hoạt động:
 *  - Admin CHẤM CÔNG TAY: tick từng ngày cho từng tài xế trên lịch.
 *  - Ngày có trong bảng chấm công được CỘNG THÊM vào số ngày làm.
 *  - Công thức UNION:  ngày làm = (ngày lịch, không tính CN) ∪ (ngày chấm công)
 *    → ngày CN được tick sẽ KHÔNG bị tính 2 lần (dùng Set).
 *
 * Quy tắc:
 *  - `work_date` = ngày LỊCH THỰC (YYYY-MM-DD), KHÔNG dùng ngày nghiệp vụ
 *    (cutoff 19:00) — chấm công là việc thực tế đã xảy ra.
 *  - 1 tài xế / 1 ngày = 1 dòng (UNIQUE).
 *  - Ghi/xoá đều ghi audit log (ai chấm công, ngày nào).
 */

const db = require('../../database');
const logger = require('../../src/utils/logger');

/** Chuẩn hoá ngày YYYY-MM-DD, trả null nếu sai định dạng / ngày không tồn tại. */
function normalizeDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(raw + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return null;
  return raw;
}

/** Ngày trong tuần: 0 = Chủ Nhật … 6 = Thứ Bảy. */
function dayOfWeek(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay();
}

/** Tên ngày trong tuần (tiếng Việt). */
const DAY_NAMES = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

class DriverAttendanceService {
  // ══════════════════════════════════════════════════════════════════════
  // ĐỌC
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Lấy các ngày đã chấm công của 1 tài xế trong khoảng [from, to].
   *
   * @param {number} driverId
   * @param {string} from  YYYY-MM-DD
   * @param {string} to    YYYY-MM-DD
   * @returns {string[]} danh sách ngày YYYY-MM-DD (đã sort)
   */
  static getWorkDates(driverId, from, to) {
    try {
      const rows = db
        .prepare(
          `SELECT work_date FROM driver_attendance
           WHERE driver_id = ? AND work_date BETWEEN ? AND ?
           ORDER BY work_date ASC`
        )
        .all(driverId, from, to);
      return rows.map((r) => r.work_date);
    } catch (err) {
      logger.error('[DriverAttendanceService] getWorkDates error', { error: err.message });
      return [];
    }
  }

  /**
   * Lấy TẤT CẢ ngày đã chấm công của 1 tài xế trong 1 tháng (YYYY, MM).
   * @returns {string[]}
   */
  static getWorkDatesInMonth(driverId, year, month) {
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const to = `${year}-${String(month).padStart(2, '0')}-31`;
    return DriverAttendanceService.getWorkDates(driverId, from, to);
  }

  /**
   * Lịch chấm công đầy đủ cho 1 tài xế trong 1 tháng — dùng cho UI.
   * Mỗi ngày: { date, dayOfWeek, dayName, isSunday, checked, note, id }
   */
  static getMonthGrid(driverId, year, month) {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const checked = new Map();
    try {
      const rows = db
        .prepare(
          `SELECT id, work_date, note, created_by, created_at
           FROM driver_attendance
           WHERE driver_id = ? AND work_date BETWEEN ? AND ?`
        )
        .all(
          driverId,
          `${year}-${String(month).padStart(2, '0')}-01`,
          `${year}-${String(month).padStart(2, '0')}-${daysInMonth}`
        );
      for (const r of rows) checked.set(r.work_date, r);
    } catch (err) {
      logger.error('[DriverAttendanceService] getMonthGrid error', { error: err.message });
    }

    const grid = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dow = dayOfWeek(date);
      const rec = checked.get(date);
      grid.push({
        date,
        day: d,
        dayOfWeek: dow,
        dayName: DAY_NAMES[dow],
        isSunday: dow === 0,
        checked: !!rec,
        id: rec ? rec.id : null,
        note: rec ? rec.note : null,
        createdBy: rec ? rec.created_by : null,
        createdAt: rec ? rec.created_at : null,
      });
    }
    return grid;
  }

  /**
   * Tổng hợp chấm công của TẤT CẢ tài xế trong 1 tháng.
   * @returns {Array} mỗi tài xế: { driverId, username, fullName, workDates[], count }
   */
  static getMonthSummary(year, month) {
    const drivers = db
      .prepare(
        `SELECT id, username, full_name FROM driver_staff WHERE active = 1 ORDER BY username`
      )
      .all();

    return drivers.map((d) => {
      const dates = DriverAttendanceService.getWorkDatesInMonth(d.id, year, month);
      return {
        driverId: d.id,
        username: d.username,
        fullName: d.full_name || d.username,
        workDates: dates,
        count: dates.length,
        sundayCount: dates.filter((x) => dayOfWeek(x) === 0).length,
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // GHI
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Chấm công 1 ngày cho 1 tài xế (idempotent — gọi lại chỉ cập nhật).
   *
   * @param {number} driverId
   * @param {string} workDate  YYYY-MM-DD
   * @param {object} [opts]
   * @param {string} [opts.note]
   * @param {string} [opts.createdBy]  admin chấm công
   * @returns {{success:boolean, error?:string, id?:number, workDate?:string}}
   */
  static mark(driverId, workDate, opts = {}) {
    const id = parseInt(driverId, 10);
    if (!id || Number.isNaN(id)) {
      return { success: false, error: 'Tài xế không hợp lệ' };
    }
    const date = normalizeDate(workDate);
    if (!date) {
      return { success: false, error: 'Ngày không hợp lệ (YYYY-MM-DD)' };
    }
    const driver = db.prepare('SELECT id FROM driver_staff WHERE id = ?').get(id);
    if (!driver) {
      return { success: false, error: 'Không tìm thấy tài xế' };
    }

    try {
      const note = opts.note !== undefined ? opts.note || null : null;
      const createdBy = opts.createdBy || null;
      db.prepare(
        `INSERT INTO driver_attendance (driver_id, work_date, note, created_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(driver_id, work_date) DO UPDATE SET
           note = excluded.note,
           created_by = excluded.created_by,
           updated_at = datetime('now')`
      ).run(id, date, note, createdBy);

      const row = db
        .prepare('SELECT id FROM driver_attendance WHERE driver_id = ? AND work_date = ?')
        .get(id, date);

      logger.info('[DriverAttendanceService] Marked', { driverId: id, workDate: date, by: createdBy });
      return { success: true, id: row ? row.id : null, workDate: date };
    } catch (err) {
      logger.error('[DriverAttendanceService] mark error', { error: err.message });
      return { success: false, error: err.message };
    }
  }

  /**
   * BỎ chấm công 1 ngày.
   * @returns {{success:boolean, error?:string, removed?:number}}
   */
  static unmark(driverId, workDate) {
    const id = parseInt(driverId, 10);
    if (!id || Number.isNaN(id)) {
      return { success: false, error: 'Tài xế không hợp lệ' };
    }
    const date = normalizeDate(workDate);
    if (!date) {
      return { success: false, error: 'Ngày không hợp lệ (YYYY-MM-DD)' };
    }
    try {
      const info = db
        .prepare('DELETE FROM driver_attendance WHERE driver_id = ? AND work_date = ?')
        .run(id, date);
      logger.info('[DriverAttendanceService] Unmarked', { driverId: id, workDate: date });
      return { success: true, removed: info.changes };
    } catch (err) {
      logger.error('[DriverAttendanceService] unmark error', { error: err.message });
      return { success: false, error: err.message };
    }
  }

  /**
   * Toggle 1 ngày (tick / untick) — tiện cho UI lịch.
   * @returns {{success:boolean, checked?:boolean, error?:string}}
   */
  static toggle(driverId, workDate, opts = {}) {
    const date = normalizeDate(workDate);
    if (!date) return { success: false, error: 'Ngày không hợp lệ (YYYY-MM-DD)' };
    const exists = db
      .prepare('SELECT id FROM driver_attendance WHERE driver_id = ? AND work_date = ?')
      .get(parseInt(driverId, 10), date);
    if (exists) {
      const r = DriverAttendanceService.unmark(driverId, date);
      return r.success ? { success: true, checked: false } : r;
    }
    const r = DriverAttendanceService.mark(driverId, date, opts);
    return r.success ? { success: true, checked: true, id: r.id } : r;
  }

  /**
   * Chấm công hàng loạt (nhiều ngày 1 lúc) — tiện cho "chấm cả tuần".
   * @param {number} driverId
   * @param {string[]} dates  danh sách YYYY-MM-DD
   * @returns {{success:boolean, marked?:number, skipped?:number, error?:string}}
   */
  static markMany(driverId, dates, opts = {}) {
    let marked = 0;
    let skipped = 0;
    for (const d of Array.isArray(dates) ? dates : []) {
      const r = DriverAttendanceService.mark(driverId, d, opts);
      if (r.success) marked++;
      else skipped++;
    }
    return { success: true, marked, skipped };
  }

  /**
   * Xoá toàn bộ chấm công của 1 tài xế trong 1 tháng.
   */
  static clearMonth(driverId, year, month) {
    const id = parseInt(driverId, 10);
    if (!id || Number.isNaN(id)) return { success: false, error: 'Tài xế không hợp lệ' };
    try {
      const info = db
        .prepare(
          `DELETE FROM driver_attendance
           WHERE driver_id = ? AND work_date BETWEEN ? AND ?`
        )
        .run(id, `${year}-${String(month).padStart(2, '0')}-01`, `${year}-${String(month).padStart(2, '0')}-31`);
      return { success: true, removed: info.changes };
    } catch (err) {
      logger.error('[DriverAttendanceService] clearMonth error', { error: err.message });
      return { success: false, error: err.message };
    }
  }
}

module.exports = DriverAttendanceService;
module.exports.normalizeDate = normalizeDate;
module.exports.dayOfWeek = dayOfWeek;
module.exports.DAY_NAMES = DAY_NAMES;
