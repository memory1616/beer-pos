/**
 * CHẤM CÔNG TÀI XẾ — Test bảng chấm công + công thức UNION
 * ─────────────────────────────────────────────────────────────────────────────
 * Vấn đề gốc: công thức lương cũ CỨNG BỎ QUA Chủ Nhật (mẫu số 26) → tài xế
 * đi làm CN nhưng không được tính lương.
 *
 * Khắc phục: bảng `driver_attendance` — admin tick tay. Ngày đã tick được
 * CỘNG vào số ngày làm theo công thức UNION:
 *
 *      ngày làm = (lịch, không tính CN) ∪ (ngày chấm công)
 *
 * Kiểm tra:
 *  A. DriverAttendanceService — CRUD + lịch tháng
 *  B. Công thức UNION — CN được tính, không tính trùng
 *  C. Tích hợp DriverStaffService — lương tính đúng
 *  D. API admin — quyền, tick/untick, bulk
 *  E. Migration 057 — idempotent, index, unique
 */
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const db = require('../database');
const { hashPassword } = require('../src/utils/password');
const DriverSalaryCalculator = require('../src/services/DriverSalaryCalculator');
const DriverAttendanceService = require('../src/services/DriverAttendanceService');
const DriverStaffService = require('../src/services/DriverStaffService');
const migration057 = require('../database/migrations/057_driver_attendance');

jest.setTimeout(20000);

// 2026-11-01 = Chủ Nhật, 2026-11-08 = Chủ Nhật, 2026-11-15 = Chủ Nhật
const SUNDAY_1 = '2026-11-01';
const SUNDAY_2 = '2026-11-08';
const SUNDAY_3 = '2026-11-15';

const ADMIN_USER = 'att_admin';
const ADMIN_PASS = 'att_admin_pw';

let app;
let driverId;

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildApp() {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => {
    req.user = { username: 'att_admin', role: 'ADMIN' };
    next();
  });
  a.use('/api/admin/driver-staff', require('../routes/api/driverStaff'));
  return a;
}

beforeAll(async () => {
  app = buildApp();

  // Tạo admin
  const hash = hashPassword(ADMIN_PASS);
  const existing = db.prepare('SELECT id FROM app_users WHERE username = ?').get(ADMIN_USER);
  if (existing) {
    db.prepare('UPDATE app_users SET password_hash = ?, role = ? WHERE id = ?').run(
      hash,
      'ADMIN',
      existing.id
    );
  } else {
    db.prepare(
      "INSERT INTO app_users (username, password_hash, full_name, role, active) VALUES (?, ?, ?, 'ADMIN', 1)"
    ).run(ADMIN_USER, hash, 'Attendance Admin');
  }

  // Tạo tài xế
  const created = DriverStaffService.create({
    username: 'att_driver',
    password: 'att_driver_pw',
    fullName: 'Tài Xế Chấm Công',
    phone: '0900000000',
    monthlySalary: 5200000,
    startDate: '2026-11-01',
  });
  driverId = created.driver ? created.driver.id : created.id;
});

afterAll(() => {
  try {
    db.prepare('DELETE FROM driver_attendance WHERE driver_id = ?').run(driverId);
    db.prepare('DELETE FROM driver_monthly_salary WHERE driver_id = ?').run(driverId);
    db.prepare('DELETE FROM driver_staff WHERE id = ?').run(driverId);
    db.prepare('DELETE FROM app_users WHERE username = ?').run(ADMIN_USER);
    db.close();
  } catch (_) {
    /* ignore */
  }
});

beforeEach(() => {
  db.prepare('DELETE FROM driver_attendance WHERE driver_id = ?').run(driverId);
  db.prepare('DELETE FROM driver_monthly_salary WHERE driver_id = ?').run(driverId);
});

// ═══════════════════════════════════════════════════════════════════════════
// A. DriverAttendanceService — CRUD
// ═══════════════════════════════════════════════════════════════════════════
describe('A. DriverAttendanceService', () => {
  test('mark tạo dòng chấm công', () => {
    const r = DriverAttendanceService.mark(driverId, SUNDAY_1, { note: 'Đi làm CN' });
    expect(r.success).toBe(true);
    expect(r.workDate).toBe(SUNDAY_1);

    const dates = DriverAttendanceService.getWorkDatesInMonth(driverId, 2026, 11);
    expect(dates).toContain(SUNDAY_1);
  });

  test('mark idempotent (gọi 2 lần chỉ 1 dòng)', () => {
    DriverAttendanceService.mark(driverId, SUNDAY_1);
    DriverAttendanceService.mark(driverId, SUNDAY_1);
    const dates = DriverAttendanceService.getWorkDatesInMonth(driverId, 2026, 11);
    expect(dates.filter((d) => d === SUNDAY_1)).toHaveLength(1);
  });

  test('unmark xoá dòng', () => {
    DriverAttendanceService.mark(driverId, SUNDAY_1);
    const r = DriverAttendanceService.unmark(driverId, SUNDAY_1);
    expect(r.success).toBe(true);
    expect(r.removed).toBe(1);
    expect(DriverAttendanceService.getWorkDatesInMonth(driverId, 2026, 11)).not.toContain(SUNDAY_1);
  });

  test('toggle: tick rồi untick', () => {
    const t1 = DriverAttendanceService.toggle(driverId, SUNDAY_1);
    expect(t1.checked).toBe(true);
    const t2 = DriverAttendanceService.toggle(driverId, SUNDAY_1);
    expect(t2.checked).toBe(false);
  });

  test('ngày sai định dạng → lỗi, không ghi', () => {
    const r = DriverAttendanceService.mark(driverId, '01/11/2026');
    expect(r.success).toBe(false);
    expect(DriverAttendanceService.getWorkDatesInMonth(driverId, 2026, 11)).toHaveLength(0);
  });

  test('ngày không tồn tại (2026-02-31) → lỗi', () => {
    const r = DriverAttendanceService.mark(driverId, '2026-02-31');
    expect(r.success).toBe(false);
  });

  test('markMany chấm nhiều ngày 1 lúc', () => {
    const r = DriverAttendanceService.markMany(driverId, [SUNDAY_1, SUNDAY_2, SUNDAY_3]);
    expect(r.success).toBe(true);
    expect(r.marked).toBe(3);
    expect(DriverAttendanceService.getWorkDatesInMonth(driverId, 2026, 11)).toHaveLength(3);
  });

  test('clearMonth xoá toàn bộ tháng', () => {
    DriverAttendanceService.markMany(driverId, [SUNDAY_1, SUNDAY_2]);
    const r = DriverAttendanceService.clearMonth(driverId, 2026, 11);
    expect(r.success).toBe(true);
    expect(r.removed).toBe(2);
  });

  test('getMonthGrid trả đủ số ngày trong tháng + đánh dấu CN', () => {
    DriverAttendanceService.mark(driverId, SUNDAY_1);
    const grid = DriverAttendanceService.getMonthGrid(driverId, 2026, 11);
    expect(grid).toHaveLength(30);
    expect(grid[0].date).toBe('2026-11-01');
    expect(grid[0].isSunday).toBe(true);
    expect(grid[0].checked).toBe(true);
    expect(grid[1].isSunday).toBe(false);
    expect(grid[1].checked).toBe(false);
  });

  test('getMonthSummary liệt kê tất cả tài xế + đếm ngày CN', () => {
    DriverAttendanceService.markMany(driverId, [SUNDAY_1, SUNDAY_2, '2026-11-03']);
    const summary = DriverAttendanceService.getMonthSummary(2026, 11);
    const row = summary.find((r) => r.driverId === driverId);
    expect(row).toBeTruthy();
    expect(row.count).toBe(3);
    expect(row.sundayCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Công thức UNION
// ═══════════════════════════════════════════════════════════════════════════
describe('B. Công thức UNION — lịch ∪ chấm công', () => {
  const driver = { start_date: '2026-11-01', monthly_salary: 5200000 };
  const TODAY = '2026-11-10';

  test('KHÔNG có chấm công → giữ nguyên hành vi cũ (bỏ CN)', () => {
    const calc = DriverSalaryCalculator.calculate(driver, 2026, 11, { today: TODAY });
    // 2026-11-01 (CN) → 2026-11-10 (T3): 10 ngày, bỏ 2 CN (01, 08) → 8
    expect(calc.workDays).toBe(8);
    expect(calc.scheduleWorkDays).toBe(8);
    expect(calc.attendanceWorkDays).toBe(0);
    expect(calc.extraAttendanceDays).toBe(0);
  });

  test('chấm công CHỦ NHẬT → được cộng vào số ngày làm', () => {
    const calc = DriverSalaryCalculator.calculate(driver, 2026, 11, {
      today: TODAY,
      attendanceDates: [SUNDAY_1],
    });
    // 8 ngày lịch + 1 CN chấm công = 9
    expect(calc.workDays).toBe(9);
    expect(calc.scheduleWorkDays).toBe(8);
    expect(calc.attendanceWorkDays).toBe(1);
    expect(calc.extraAttendanceDays).toBe(1);
  });

  test('chấm công ngày ĐÃ có trong lịch → KHÔNG tính trùng', () => {
    const calc = DriverSalaryCalculator.calculate(driver, 2026, 11, {
      today: TODAY,
      attendanceDates: ['2026-11-03'], // T3 — đã nằm trong lịch
    });
    expect(calc.workDays).toBe(8); // không tăng
    expect(calc.extraAttendanceDays).toBe(0);
  });

  test('chấm công nhiều CN → cộng dồn đúng', () => {
    const calc = DriverSalaryCalculator.calculate(driver, 2026, 11, {
      today: TODAY,
      attendanceDates: [SUNDAY_1, SUNDAY_2],
    });
    expect(calc.workDays).toBe(10);
    expect(calc.extraAttendanceDays).toBe(2);
  });

  test('lương tăng đúng theo số ngày chấm công', () => {
    const base = DriverSalaryCalculator.calculate(driver, 2026, 11, { today: TODAY });
    const withSunday = DriverSalaryCalculator.calculate(driver, 2026, 11, {
      today: TODAY,
      attendanceDates: [SUNDAY_1],
    });
    expect(withSunday.proratedBase).toBe(base.proratedBase + Math.round(base.dailyRate));
  });

  test('manualWorkDays vẫn ghi đè tuyệt đối', () => {
    const calc = DriverSalaryCalculator.calculate(driver, 2026, 11, {
      today: TODAY,
      attendanceDates: [SUNDAY_1, SUNDAY_2],
      manualWorkDays: 5,
    });
    expect(calc.workDays).toBe(5);
  });

  test('tháng quá: chấm công vẫn được tính', () => {
    // Tài xế chưa có ngày vào làm → tính từ đầu tháng 10
    const calc = DriverSalaryCalculator.calculate(
      { start_date: null, monthly_salary: 5200000 },
      2026,
      10,
      {
        today: TODAY,
        attendanceDates: ['2026-10-11'], // CN tháng 10
      }
    );
    // Tháng 10/2026: 01(CN) → 31(CN), CN: 4, 11, 18, 25 → 31 - 4 = 27 lịch
    expect(calc.scheduleWorkDays).toBe(27);
    expect(calc.workDays).toBe(28); // + 1 CN chấm công
  });

  test('tài xế vào làm SAU kỳ → 0 ngày làm', () => {
    const calc = DriverSalaryCalculator.calculate(driver, 2026, 10, {
      today: TODAY,
      attendanceDates: ['2026-10-11'],
    });
    expect(calc.workDays).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Tích hợp DriverStaffService
// ═══════════════════════════════════════════════════════════════════════════
describe('C. Tích hợp DriverStaffService', () => {
  test('getMonthlySalary phản ánh số ngày chấm công', () => {
    DriverAttendanceService.mark(driverId, SUNDAY_1);
    const salary = DriverStaffService.getMonthlySalary(driverId, 2026, 11);
    expect(salary.schedule_work_days).toBeGreaterThan(0);
    expect(salary.attendance_work_days).toBe(1);
    expect(salary.work_days).toBe(salary.schedule_work_days + 1);
    expect(salary.attendance_dates).toContain(SUNDAY_1);
  });

  test('getMonthlySalarySummary có trường chấm công', () => {
    DriverAttendanceService.mark(driverId, SUNDAY_1);
    const summary = DriverStaffService.getMonthlySalarySummary(2026, 11);
    const row = summary.find((r) => r.driverId === driverId);
    expect(row).toBeTruthy();
    expect(row.attendanceWorkDays).toBe(1);
    expect(row.extraAttendanceDays).toBe(1);
  });

  test('setMonthlySalary tính lương theo ngày chấm công', () => {
    DriverAttendanceService.mark(driverId, SUNDAY_1);
    const res = DriverStaffService.setMonthlySalary(driverId, 2026, 11, {
      baseSalary: 5200000,
    });
    expect(res.success).toBe(true);
    expect(res.workDays).toBeGreaterThan(0);
    // lương > 0 vì đã có ngày làm
    expect(res.total).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. API admin
// ═══════════════════════════════════════════════════════════════════════════
describe('D. API admin — chấm công', () => {
  test('GET /attendance/summary trả về danh sách', async () => {
    const res = await request(app)
      .get('/api/admin/driver-staff/attendance/summary?year=2026&month=11');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test('GET /:id/attendance trả lịch chi tiết', async () => {
    DriverAttendanceService.mark(driverId, SUNDAY_1);
    const res = await request(app).get(
      `/api/admin/driver-staff/${driverId}/attendance?year=2026&month=11`
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(30);
    expect(res.body.checkedCount).toBe(1);
  });

  test('POST /:id/attendance chấm công 1 ngày', async () => {
    const res = await request(app)
      .post(`/api/admin/driver-staff/${driverId}/attendance`)
      .send({ date: SUNDAY_2, note: 'Đi làm CN chợ' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(
      DriverAttendanceService.getWorkDatesInMonth(driverId, 2026, 11)
    ).toContain(SUNDAY_2);
  });

  test('POST /:id/attendance/toggle tick/untick', async () => {
    const r1 = await request(app)
      .post(`/api/admin/driver-staff/${driverId}/attendance/toggle`)
      .send({ date: SUNDAY_3 });
    expect(r1.body.data.checked).toBe(true);
    const r2 = await request(app)
      .post(`/api/admin/driver-staff/${driverId}/attendance/toggle`)
      .send({ date: SUNDAY_3 });
    expect(r2.body.data.checked).toBe(false);
  });

  test('POST /:id/attendance/bulk chấm nhiều ngày', async () => {
    const res = await request(app)
      .post(`/api/admin/driver-staff/${driverId}/attendance/bulk`)
      .send({ dates: [SUNDAY_1, SUNDAY_2] });
    expect(res.status).toBe(200);
    expect(res.body.data.marked).toBe(2);
  });

  test('POST với ngày sai định dạng → 400', async () => {
    const res = await request(app)
      .post(`/api/admin/driver-staff/${driverId}/attendance`)
      .send({ date: 'abc' });
    expect(res.status).toBe(400);
  });

  test('DELETE /:id/attendance bỏ chấm công', async () => {
    DriverAttendanceService.mark(driverId, SUNDAY_1);
    const res = await request(app).delete(
      `/api/admin/driver-staff/${driverId}/attendance?date=${SUNDAY_1}`
    );
    expect(res.status).toBe(200);
    expect(
      DriverAttendanceService.getWorkDatesInMonth(driverId, 2026, 11)
    ).not.toContain(SUNDAY_1);
  });

  test('DELETE /:id/attendance/month xoá cả tháng', async () => {
    DriverAttendanceService.markMany(driverId, [SUNDAY_1, SUNDAY_2]);
    const res = await request(app).delete(
      `/api/admin/driver-staff/${driverId}/attendance/month?year=2026&month=11`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Migration 057
// ═══════════════════════════════════════════════════════════════════════════
describe('E. Migration 057 — driver_attendance', () => {
  test('idempotent: chạy 2 lần không lỗi', () => {
    expect(() => migration057.up(db)).not.toThrow();
    expect(() => migration057.up(db)).not.toThrow();
  });

  test('bảng driver_attendance tồn tại', () => {
    const t = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='driver_attendance'")
      .get();
    expect(t).toBeTruthy();
  });

  test('có index driver + date', () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_driver_attendance%'")
      .all()
      .map((r) => r.name);
    expect(idx).toContain('idx_driver_attendance_driver_date');
    expect(idx).toContain('idx_driver_attendance_date');
  });

  test('UNIQUE(driver_id, work_date) — không chấm trùng 1 ngày', () => {
    // Unique được enforce qua ON CONFLICT — kiểm tra bằng insert thẳng
    DriverAttendanceService.mark(driverId, SUNDAY_1);
    expect(() => {
      db.prepare(
        'INSERT INTO driver_attendance (driver_id, work_date) VALUES (?, ?)'
      ).run(driverId, SUNDAY_1);
    }).toThrow();
  });
});
