/**
 * Driver Salary by Working Days — Test công thức tính lương theo ngày làm
 * ─────────────────────────────────────────────────────────────────────────────
 * Công thức: lương = (lương_cơ_bản_tháng ÷ 26) × số_ngày_làm
 *   - số ngày làm: từ ngày vào làm đến ngày hiện tại, KHÔNG tính Chủ Nhật.
 */

process.env.NODE_ENV = 'test';

const db = require('../database');
const DriverSalaryCalculator = require('../src/services/DriverSalaryCalculator');

jest.setTimeout(20000);

// 2026-11-01 là Chủ Nhật, 2026-11-10 là Thứ Ba
const TODAY = '2026-11-10';

describe('Driver Salary Calculator — tính lương theo ngày làm', () => {
  // ═══════════════════════════════════════════════════════════════════════
  describe('A. Đếm ngày làm (không tính Chủ Nhật)', () => {
    test('Một tuần đầy đủ = 6 ngày làm', () => {
      // 2026-11-02 (T2) → 2026-11-08 (CN) = 7 ngày, bỏ CN → 6
      expect(DriverSalaryCalculator.countWorkingDays('2026-11-02', '2026-11-08')).toBe(6);
    });

    test('Chủ Nhật không được tính', () => {
      // 2026-11-01 là CN → 0 ngày làm
      expect(DriverSalaryCalculator.countWorkingDays('2026-11-01', '2026-11-01')).toBe(0);
      // 2026-11-01 (CN) → 2026-11-02 (T2) = 1 ngày làm
      expect(DriverSalaryCalculator.countWorkingDays('2026-11-01', '2026-11-02')).toBe(1);
    });

    test('Khoảng đảo ngược (from > to) → 0', () => {
      expect(DriverSalaryCalculator.countWorkingDays('2026-11-10', '2026-11-01')).toBe(0);
    });

    test('Tháng 2 năm nhuận (29 ngày, 4 CN) → 25 ngày làm', () => {
      // 2024-02-01 (T5) → 2024-02-29 (T5), CN: 04, 11, 18, 25 → 29 - 4 = 25
      expect(DriverSalaryCalculator.countWorkingDays('2024-02-01', '2024-02-29')).toBe(25);
    });

    test('Tháng 31 ngày có 5 CN → 26 ngày làm (đủ mẫu số 26)', () => {
      // 2026-05-01 (T6) → 2026-05-31 (CN): CN: 03,10,17,24,31 → 31 - 5 = 26
      expect(DriverSalaryCalculator.countWorkingDays('2026-05-01', '2026-05-31')).toBe(26);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('B. Công thức lương theo ngày làm', () => {
    const driver = { start_date: '2026-11-01', monthly_salary: 5200000 };

    test('Tính lương tháng hiện tại: từ ngày vào làm đến hôm nay', () => {
      const calc = DriverSalaryCalculator.calculate(driver, 2026, 11, { today: TODAY });
      // 2026-11-01 (CN) → 2026-11-10 (T3): 10 ngày, bỏ 2 CN (01, 08) → 8 ngày làm
      expect(calc.workDays).toBe(8);
      expect(calc.dailyRate).toBeCloseTo(5200000 / 26, 4);
      expect(calc.proratedBase).toBe(Math.round((5200000 / 26) * 8));
      expect(calc.standardWorkDays).toBe(26);
      expect(calc.isCurrentMonth).toBe(true);
    });

    test('Không có ngày vào làm → tính từ đầu tháng', () => {
      const calc = DriverSalaryCalculator.calculate(
        { start_date: null, monthly_salary: 5200000 },
        2026, 11, { today: TODAY }
      );
      expect(calc.workDays).toBe(8); // 01 (CN) → 10 (T3), bỏ CN 01, 08
      expect(calc.startDate).toBeNull();
    });

    test('Ngày vào làm giữa tháng → chỉ tính từ ngày đó', () => {
      const calc = DriverSalaryCalculator.calculate(
        { start_date: '2026-11-05', monthly_salary: 5200000 },
        2026, 11, { today: TODAY }
      );
      // 05 (T4) → 10 (T2) = 6 ngày, bỏ CN 08 → 5 ngày làm
      expect(calc.workDays).toBe(5);
    });

    test('Tháng ĐÃ QUA → tính trọn tháng (không giới hạn ngày hiện tại)', () => {
      const calc = DriverSalaryCalculator.calculate(
        { start_date: '2026-10-01', monthly_salary: 5200000 },
        2026, 10, { today: TODAY }
      );
      // 2026-10-01 → 2026-10-31: 31 ngày, bỏ 4 CN → 27 ngày làm
      expect(calc.workDays).toBe(27);
      expect(calc.isCurrentMonth).toBe(false);
      // 27 ngày làm > 26 → lương theo ngày làm VƯỢT mức lương tháng
      expect(calc.proratedBase).toBe(Math.round((5200000 / 26) * 27));
      expect(calc.proratedBase).toBeGreaterThan(5200000);
    });

    test('Tháng ĐÃ QUA nhưng ngày vào làm ở tháng sau → 0 ngày làm', () => {
      const calc = DriverSalaryCalculator.calculate(driver, 2026, 10, { today: TODAY });
      expect(calc.workDays).toBe(0);
      expect(calc.proratedBase).toBe(0);
    });

    test('Admin ghi đè số ngày làm thủ công → dùng giá trị đó', () => {
      const calc = DriverSalaryCalculator.calculate(driver, 2026, 11, {
        today: TODAY,
        manualWorkDays: 15,
      });
      expect(calc.workDays).toBe(15);
      expect(calc.proratedBase).toBe(Math.round((5200000 / 26) * 15));
    });

    test('Lương 0 → mọi thứ bằng 0', () => {
      const calc = DriverSalaryCalculator.calculate(
        { start_date: '2026-11-01', monthly_salary: 0 },
        2026, 11, { today: TODAY }
      );
      expect(calc.dailyRate).toBe(0);
      expect(calc.proratedBase).toBe(0);
    });

    test('Ngày vào làm SAU kỳ tính → 0 ngày làm', () => {
      const calc = DriverSalaryCalculator.calculate(
        { start_date: '2026-12-01', monthly_salary: 5000000 },
        2026, 11, { today: TODAY }
      );
      expect(calc.workDays).toBe(0);
      expect(calc.proratedBase).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('C. Tích hợp DriverStaffService', () => {
    const Service = require('../src/services/DriverStaffService');
    let driverId;

    beforeAll(() => {
      const res = Service.create({
        username: 'ds_wd_' + Date.now().toString().slice(-6),
        password: 'TaiXeMoi@2026',
        fullName: 'Tài xế ngày làm',
        monthlySalary: 5200000,
        startDate: '2026-11-01',
      });
      expect(res.success).toBe(true);
      driverId = res.id;
    });

    afterAll(() => {
      try {
        db.prepare('DELETE FROM driver_monthly_salary WHERE driver_id = ?').run(driverId);
        db.prepare('DELETE FROM driver_staff WHERE id = ?').run(driverId);
      } catch (_) {}
    });

    test('Hồ sơ lưu được ngày vào làm', () => {
      const d = Service.getById(driverId);
      expect(d.start_date).toBe('2026-11-01');
    });

    test('Ngày vào làm sai định dạng bị từ chối', () => {
      const res = Service.update(driverId, { startDate: 'abc' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('Ngày vào làm');
    });

    test('Bảng lương trả về số ngày làm + lương/ngày + lương prorate', () => {
      const summary = Service.getMonthlySalarySummary(2026, 11);
      const row = summary.find((r) => r.driverId === driverId);
      expect(row).toBeDefined();
      expect(row.startDate).toBe('2026-11-01');
      expect(row.standardWorkDays).toBe(26);
      expect(row.dailyRate).toBeCloseTo(5200000 / 26, 4);
      expect(row.workDays).toBeGreaterThan(0);
      expect(row.proratedBase).toBe(Math.round(row.dailyRate * row.workDays));
      // Tổng = lương theo ngày + thưởng − phạt
      expect(row.total).toBe(row.proratedBase + row.bonus - row.deduction);
    });

    test('Lưu lương → work_days ghi đè tay được lưu vào DB', () => {
      const res = Service.setMonthlySalary(driverId, 2026, 11, {
        baseSalary: 5200000,
        bonus: 500000,
        deduction: 0,
        workDays: 12,
      });
      expect(res.success).toBe(true);
      expect(res.body).toBeUndefined();
      expect(res.workDays).toBe(12);
      expect(res.proratedBase).toBe(Math.round((5200000 / 26) * 12));

      const row = db
        .prepare('SELECT * FROM driver_monthly_salary WHERE driver_id = ? AND year = 2026 AND month = 11')
        .get(driverId);
      expect(row.work_days).toBe(12);
      expect(row.total).toBe(Math.round((5200000 / 26) * 12) + 500000);
    });

    test('Sau khi ghi đè tay → summary đánh dấu workDaysManual', () => {
      const summary = Service.getMonthlySalarySummary(2026, 11);
      const row = summary.find((r) => r.driverId === driverId);
      expect(row.workDaysManual).toBe(true);
      expect(row.workDays).toBe(12);
    });
  });
});
