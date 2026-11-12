/**
 * Test: Ứng lương tài xế (047)
 * ─────────────────────────────────────────────────────────────────────────────
 * Nghiệp vụ:
 *  - Admin ghi nhận khoản ứng cho 1 tài xế trong 1 kỳ lương.
 *  - Khoản ứng được TRỪ khỏi tổng lương thực nhận của kỳ đó.
 *  - Tài xế xem được trên Driver Portal (lương dự kiến / đã ứng / còn nhận).
 *  - Huỷ khoản ứng → không còn tính vào lương.
 */

const db = require('../database');
const DriverStaffService = require('../src/services/DriverStaffService');

const TODAY = db.getVietnamDateStr();
const CUR_Y = Number(TODAY.slice(0, 4));
const CUR_M = Number(TODAY.slice(5, 7));

describe('Driver Salary Advance — Ứng lương tài xế', () => {
  let driverId;

  beforeAll(() => {
    const Service = DriverStaffService;
    const res = Service.create({
      username: 'ds_adv_' + Date.now().toString().slice(-6),
      password: 'TaiXeUng@2026',
      fullName: 'Tài xế ứng lương',
      monthlySalary: 5200000,
      startDate: `${CUR_Y}-${String(CUR_M).padStart(2, '0')}-01`,
    });
    expect(res.success).toBe(true);
    driverId = res.id;
  });

  afterAll(() => {
    try {
      db.prepare('DELETE FROM driver_salary_advances WHERE driver_id = ?').run(driverId);
      db.prepare('DELETE FROM driver_monthly_salary WHERE driver_id = ?').run(driverId);
      db.prepare('DELETE FROM driver_staff WHERE id = ?').run(driverId);
    } catch (_) {}
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('A. Service — ghi nhận / huỷ ứng lương', () => {
    test('Tạo khoản ứng lương thành công', () => {
      const res = DriverStaffService.createAdvance(driverId, CUR_Y, CUR_M, {
        amount: 1000000,
        method: 'cash',
        note: 'Ứng trước 10 ngày',
      });
      expect(res.success).toBe(true);
      expect(res.amount).toBe(1000000);
    });

    test('Số tiền ứng phải > 0', () => {
      const res = DriverStaffService.createAdvance(driverId, CUR_Y, CUR_M, { amount: 0 });
      expect(res.success).toBe(false);
      expect(res.error).toContain('Số tiền ứng');

      const res2 = DriverStaffService.createAdvance(driverId, CUR_Y, CUR_M, { amount: -500 });
      expect(res2.success).toBe(false);
    });

    test('Tổng khoản ứng của kỳ được cộng dồn', () => {
      DriverStaffService.createAdvance(driverId, CUR_Y, CUR_M, { amount: 500000 });
      const total = DriverStaffService.getAdvanceTotal(driverId, CUR_Y, CUR_M);
      expect(total).toBe(1500000);
    });

    test('Danh sách khoản ứng trả về đủ số bản ghi', () => {
      const list = DriverStaffService.getAdvances(driverId, CUR_Y, CUR_M);
      expect(list.length).toBe(2);
      expect(list[0].amount).toBeGreaterThan(0);
    });

    test('Huỷ khoản ứng → không còn tính vào tổng', () => {
      const list = DriverStaffService.getAdvances(driverId, CUR_Y, CUR_M);
      const target = list.find((a) => a.amount === 500000);
      const res = DriverStaffService.cancelAdvance(target.id);
      expect(res.success).toBe(true);
      expect(DriverStaffService.getAdvanceTotal(driverId, CUR_Y, CUR_M)).toBe(1000000);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('B. Tính lương — trừ khoản ứng', () => {
    test('Lương thực nhận = lương theo ngày − khoản đã ứng', () => {
      const res = DriverStaffService.setMonthlySalary(driverId, CUR_Y, CUR_M, {
        baseSalary: 5200000,
        bonus: 500000,
        deduction: 200000,
      });
      expect(res.success).toBe(true);

      const salary = DriverStaffService.getMonthlySalary(driverId, CUR_Y, CUR_M);
      expect(salary.advance_total).toBe(1000000);
      expect(salary.gross_total).toBe(salary.prorated_base + 500000 - 200000);
      expect(salary.total).toBe(Math.max(0, salary.gross_total - 1000000));
      expect(salary.net_total).toBe(salary.total);
    });

    test('Bản ghi lương trong DB lưu total đã trừ ứng', () => {
      const row = db
        .prepare('SELECT total, advance_paid FROM driver_monthly_salary WHERE driver_id = ? AND year = ? AND month = ?')
        .get(driverId, CUR_Y, CUR_M);
      expect(row.advance_paid).toBe(1000000);
      expect(row.total).toBe(Math.max(0, row.total));
      expect(row.total).toBeLessThan(row.advance_paid + 5200000);
    });

    test('Tổng thực nhận KHÔNG âm khi ứng nhiều hơn lương', () => {
      DriverStaffService.createAdvance(driverId, CUR_Y, CUR_M, { amount: 999999999 });
      const salary = DriverStaffService.getMonthlySalary(driverId, CUR_Y, CUR_M);
      expect(salary.total).toBe(0);
      expect(salary.total).toBeGreaterThanOrEqual(0);
    });

    test('Summary bảng lương có cột ứng lương', () => {
      const summary = DriverStaffService.getMonthlySalarySummary(CUR_Y, CUR_M);
      const row = summary.find((r) => r.driverId === driverId);
      expect(row).toBeDefined();
      expect(row.advanceTotal).toBeGreaterThan(0);
      expect(row.netTotal).toBe(row.total);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('C. API admin — /api/admin/driver-staff/:id/advances', () => {
    const request = require('supertest');
    const { hashPassword } = require('../src/utils/password');
    let app;
    let adminToken;

    beforeAll(() => {
      const express = require('express');
      const cookieParser = require('cookie-parser');
      const { requireAuth } = require('../middleware/auth');

      app = express();
      app.use(express.json());
      app.use(cookieParser());
      app.use('/api/admin/driver-staff', requireAuth, require('../routes/api/driverStaff'));

      const ADMIN_USER = 'ds_adv_admin_' + Date.now().toString().slice(-6);
      db.prepare(
        `INSERT OR REPLACE INTO app_users (username, password_hash, role, active, full_name)
         VALUES (?, ?, 'ADMIN', 1, 'Admin test')`
      ).run(ADMIN_USER, hashPassword('AdminPass123'));

      const { login } = require('../middleware/auth');
      adminToken = login(ADMIN_USER, 'AdminPass123').token;
    });

    test('POST tạo khoản ứng → 201', async () => {
      const res = await request(app)
        .post(`/api/admin/driver-staff/${driverId}/advances`)
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ year: CUR_Y, month: CUR_M, amount: 250000, method: 'bank', note: 'test' });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    test('POST số tiền không hợp lệ → 400', async () => {
      const res = await request(app)
        .post(`/api/admin/driver-staff/${driverId}/advances`)
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ year: CUR_Y, month: CUR_M, amount: 0 });
      expect(res.status).toBe(400);
    });

    test('GET danh sách khoản ứng', async () => {
      const res = await request(app)
        .get(`/api/admin/driver-staff/${driverId}/advances?year=${CUR_Y}&month=${CUR_M}`)
        .set('Authorization', 'Bearer ' + adminToken);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.total).toBeGreaterThan(0);
    });

    test('DELETE huỷ khoản ứng', async () => {
      const listRes = await request(app)
        .get(`/api/admin/driver-staff/${driverId}/advances?year=${CUR_Y}&month=${CUR_M}`)
        .set('Authorization', 'Bearer ' + adminToken);
      const target = listRes.body.data.find((a) => a.amount === 250000);

      const res = await request(app)
        .delete(`/api/admin/driver-staff/advances/${target.id}`)
        .set('Authorization', 'Bearer ' + adminToken);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('D. API Driver Portal — lương dự kiến có ứng lương', () => {
    const request = require('supertest');
    const { hashPassword } = require('../src/utils/password');
    let app;
    let driverToken;
    const DRIVER_USER = 'ds_adv_drv_' + Date.now().toString().slice(-6);

    beforeAll(() => {
      const express = require('express');
      const cookieParser = require('cookie-parser');
      const { requireAuth } = require('../middleware/auth');

      app = express();
      app.use(express.json());
      app.use(cookieParser());
      app.use('/api/driver', requireAuth, require('../routes/api/driver'));

      db.prepare(
        `INSERT OR REPLACE INTO app_users (username, password_hash, role, active, full_name)
         VALUES (?, ?, 'DRIVER', 1, 'Tài xế ứng')`
      ).run(DRIVER_USER, hashPassword('DriverPass123'));

      DriverStaffService.create({
        username: DRIVER_USER,
        password: 'DriverPass123',
        fullName: 'Tài xế ứng',
        monthlySalary: 5200000,
        startDate: `${CUR_Y}-${String(CUR_M).padStart(2, '0')}-01`,
      });

      // Ứng 1.000.000
      const ds = DriverStaffService.getByUsername(DRIVER_USER);
      DriverStaffService.createAdvance(ds.id, CUR_Y, CUR_M, { amount: 1000000 });

      const { login } = require('../middleware/auth');
      driverToken = login(DRIVER_USER, 'DriverPass123').token;
    });

    afterAll(() => {
      try {
        const ds = DriverStaffService.getByUsername(DRIVER_USER);
        if (ds) {
          db.prepare('DELETE FROM driver_salary_advances WHERE driver_id = ?').run(ds.id);
          db.prepare('DELETE FROM driver_monthly_salary WHERE driver_id = ?').run(ds.id);
          db.prepare('DELETE FROM driver_staff WHERE id = ?').run(ds.id);
        }
        db.prepare('DELETE FROM auth_sessions WHERE username = ?').run(DRIVER_USER);
        db.prepare('DELETE FROM app_users WHERE username = ?').run(DRIVER_USER);
      } catch (_) {}
    });

    test('/api/driver/home trả estimatedSalary kèm advanceTotal + netAmount', async () => {
      const res = await request(app)
        .get('/api/driver/home')
        .set('Authorization', 'Bearer ' + driverToken);
      expect(res.status).toBe(200);

      const s = res.body.estimatedSalary;
      expect(s).toBeTruthy();
      expect(s.advanceTotal).toBe(1000000);
      expect(s.netAmount).toBe(Math.max(0, Math.round((s.amount - 1000000) * 100) / 100));
    });

    test('/api/driver/me cũng trả estimatedSalary', async () => {
      const res = await request(app)
        .get('/api/driver/me')
        .set('Authorization', 'Bearer ' + driverToken);
      expect(res.status).toBe(200);
      expect(res.body.estimatedSalary).toBeTruthy();
      expect(res.body.estimatedSalary.advanceTotal).toBe(1000000);
    });
  });
});
