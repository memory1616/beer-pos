/**
 * Driver Staff Management — Test RBAC & logic lương tài xế
 * ─────────────────────────────────────────────────────────────────────────────
 * Kiểm tra:
 *  - Driver KHÔNG truy cập được /api/admin/driver-staff (403)
 *  - Admin tạo/sửa/khoá được hồ sơ tài xế
 *  - Tài xế tự tạo / tự nâng quyền bị chặn
 *  - Lương cứng theo tháng: total = base + bonus - deduction
 *  - Response KHÔNG chứa password_hash
 */

process.env.NODE_ENV = 'test';

const request = require('supertest');
const db = require('../database');
const { hashPassword } = require('../src/utils/password');

jest.setTimeout(20000);

// ── Build app Express test ─────────────────────────────────────────────────
function buildApp() {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const { requireAuth, login } = require('../middleware/auth');
  const { apiGuard, attachSanitizer } = require('../middleware/permissions');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.use('/api/driver', requireAuth, require('../routes/api/driver'));
  app.use('/api', requireAuth, apiGuard, attachSanitizer);

  // Thứ tự như server.js: driver-staff TRƯỚC admin
  app.use('/api/admin/driver-staff', require('../routes/api/driverStaff'));
  app.use('/api/admin', require('../routes/api/admin'));

  return app;
}

let app;
let driverToken;
let adminToken;

const DRIVER_USER = 'ds_test_driver';
const ADMIN_USER = 'ds_test_admin';
const NEW_DRIVER = 'ds_new_driver_' + Date.now().toString().slice(-5);

function loginAs(username, password, driverOnly = true) {
  const { login } = require('../middleware/auth');
  return login(username, password, { driverOnly });
}

beforeAll(() => {
  app = buildApp();

  const insert = db.prepare(
    `INSERT OR REPLACE INTO app_users (username, password_hash, role, active, full_name)
     VALUES (?, ?, ?, 1, ?)`
  );
  insert.run(DRIVER_USER, hashPassword('DriverPass123'), 'DRIVER', 'Tài xế DS Test');
  insert.run(ADMIN_USER, hashPassword('AdminPass123'), 'ADMIN', 'Admin DS Test');

  driverToken = loginAs(DRIVER_USER, 'DriverPass123').token;
  adminToken = loginAs(ADMIN_USER, 'AdminPass123', false).token;
});

afterAll(() => {
  try {
    db.prepare('DELETE FROM driver_monthly_salary WHERE driver_id IN (SELECT id FROM driver_staff WHERE username LIKE ?)')
      .run(NEW_DRIVER + '%');
    db.prepare('DELETE FROM driver_staff WHERE username LIKE ?').run(NEW_DRIVER + '%');
    db.prepare('DELETE FROM app_users WHERE username IN (?, ?, ?)').run(DRIVER_USER, ADMIN_USER, NEW_DRIVER);
    db.prepare('DELETE FROM auth_sessions WHERE username IN (?, ?, ?)').run(DRIVER_USER, ADMIN_USER, NEW_DRIVER);
  } catch (_) {}
});

describe('Driver Staff Management — RBAC & Lương tháng', () => {
  // ═══════════════════════════════════════════════════════════════════════
  describe('A. Driver KHÔNG được truy cập API quản lý tài xế', () => {
    test('GET /api/admin/driver-staff bị chặn (403 DRIVER_FORBIDDEN)', async () => {
      const res = await request(app)
        .get('/api/admin/driver-staff')
        .set('Authorization', 'Bearer ' + driverToken);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('DRIVER_FORBIDDEN');
    });

    test('POST /api/admin/driver-staff bị chặn — driver KHÔNG tự tạo tài xế', async () => {
      const before = db.prepare('SELECT COUNT(*) AS c FROM app_users').get().c;
      const res = await request(app)
        .post('/api/admin/driver-staff')
        .set('Authorization', 'Bearer ' + driverToken)
        .send({ username: 'driver_self_made', password: 'HackerPass123' });
      expect(res.status).toBe(403);
      const after = db.prepare('SELECT COUNT(*) AS c FROM app_users').get().c;
      expect(after).toBe(before);
    });

    test('GET bảng lương bị chặn', async () => {
      const res = await request(app)
        .get('/api/admin/driver-staff/salary/summary?year=2026&month=11')
        .set('Authorization', 'Bearer ' + driverToken);
      expect(res.status).toBe(403);
    });

    test('PUT lương bị chặn', async () => {
      const res = await request(app)
        .put('/api/admin/driver-staff/1/salary')
        .set('Authorization', 'Bearer ' + driverToken)
        .send({ year: 2026, month: 11, baseSalary: 99999999 });
      expect(res.status).toBe(403);
    });

    test('Không đăng nhập → 401', async () => {
      const res = await request(app).get('/api/admin/driver-staff');
      expect(res.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('B. Admin tạo & quản lý hồ sơ tài xế', () => {
    let driverId;

    test('Admin tạo tài xế kèm tài khoản đăng nhập', async () => {
      const res = await request(app)
        .post('/api/admin/driver-staff')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({
          username: NEW_DRIVER,
          password: 'TaiXeMoi@2026',
          fullName: 'Tài xế Mới',
          phone: '0900111222',
          monthlySalary: 5000000,
        });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.accountCreated).toBe(true);
      driverId = res.body.id;

      const user = db.prepare('SELECT * FROM app_users WHERE username = ?').get(NEW_DRIVER);
      expect(user).toBeDefined();
      expect(user.role).toBe('DRIVER');
      expect(user.password_hash).not.toContain('TaiXeMoi@2026');
      expect(user.password_hash.length).toBeGreaterThan(20);
    });

    test('Tài xế tạo xong đăng nhập được Driver Portal', () => {
      const res = loginAs(NEW_DRIVER, 'TaiXeMoi@2026');
      expect(res).not.toBeNull();
      expect(res.role).toBe('DRIVER');
    });

    test('Danh sách tài xế KHÔNG chứa password_hash', async () => {
      const res = await request(app)
        .get('/api/admin/driver-staff')
        .set('Authorization', 'Bearer ' + adminToken);
      expect(res.status).toBe(200);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('password_hash');
      expect(raw).not.toContain('passwordHash');
    });

    test('Sửa hồ sơ đồng bộ sang app_users', async () => {
      const res = await request(app)
        .put('/api/admin/driver-staff/' + driverId)
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ fullName: 'Tên Mới', monthlySalary: 6000000 });
      expect(res.status).toBe(200);

      const user = db.prepare('SELECT full_name FROM app_users WHERE username = ?').get(NEW_DRIVER);
      expect(user.full_name).toBe('Tên Mới');

      const profile = db.prepare('SELECT monthly_salary FROM driver_staff WHERE id = ?').get(driverId);
      expect(profile.monthly_salary).toBe(6000000);
    });

    test('Trùng username bị từ chối', async () => {
      const res = await request(app)
        .post('/api/admin/driver-staff')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ username: NEW_DRIVER, password: 'TaiXeMoi@2026' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('đã tồn tại');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('C. Lương cứng theo tháng', () => {
    let driverId;
    const year = new Date().getFullYear();
    const month = new Date().getMonth() + 1;

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/admin/driver-staff')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({
          username: NEW_DRIVER + '_sal',
          password: 'TaiXeMoi@2026',
          fullName: 'Tài xế Lương',
          monthlySalary: 5000000,
        });
      driverId = res.body.id;
    });

    test('Chưa có bản ghi → dùng mức lương cố định', async () => {
      const res = await request(app)
        .get('/api/admin/driver-staff/' + driverId)
        .set('Authorization', 'Bearer ' + adminToken);
      expect(res.status).toBe(200);
      expect(res.body.data.monthly_salary).toBe(5000000);
    });

    test('Thiết lập lương: total = base + bonus - deduction', async () => {
      const res = await request(app)
        .put('/api/admin/driver-staff/' + driverId + '/salary')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ year, month, baseSalary: 5000000, bonus: 1000000, deduction: 200000 });
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(5800000);

      const row = db
        .prepare('SELECT * FROM driver_monthly_salary WHERE driver_id = ? AND year = ? AND month = ?')
        .get(driverId, year, month);
      expect(row.total).toBe(5800000);
      expect(row.status).toBe('pending');
    });

    test('Cập nhật một phần KHÔNG mất trường khác', async () => {
      const res = await request(app)
        .put('/api/admin/driver-staff/' + driverId + '/salary')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ year, month, bonus: 1500000 });
      expect(res.status).toBe(200);

      const row = db
        .prepare('SELECT * FROM driver_monthly_salary WHERE driver_id = ? AND year = ? AND month = ?')
        .get(driverId, year, month);
      expect(row.bonus).toBe(1500000);
      expect(row.deduction).toBe(200000);
      expect(row.base_salary).toBe(5000000);
      expect(row.total).toBe(6300000);
    });

    test('Bảng tổng hợp lương tháng trả về đúng số liệu', async () => {
      const res = await request(app)
        .get(`/api/admin/driver-staff/salary/summary?year=${year}&month=${month}`)
        .set('Authorization', 'Bearer ' + adminToken);
      expect(res.status).toBe(200);
      const row = res.body.data.find((d) => d.driverId === driverId);
      expect(row).toBeDefined();
      expect(row.total).toBe(6300000);
      expect(row.username).toBe(NEW_DRIVER + '_sal');
    });

    test('Đánh dấu đã trả lương', async () => {
      const res = await request(app)
        .post('/api/admin/driver-staff/' + driverId + '/salary/paid')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ year, month, paid: true });
      expect(res.status).toBe(200);

      const row = db
        .prepare('SELECT * FROM driver_monthly_salary WHERE driver_id = ? AND year = ? AND month = ?')
        .get(driverId, year, month);
      expect(row.status).toBe('paid');
      expect(row.paid_at).not.toBeNull();
    });

    test('Kỳ lương không hợp lệ bị từ chối', async () => {
      const res = await request(app)
        .put('/api/admin/driver-staff/' + driverId + '/salary')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ year: 2026, month: 13, baseSalary: 100 });
      expect(res.status).toBe(400);
    });

    test('Lịch sử lương trả về lịch sử đã lưu', async () => {
      const res = await request(app)
        .get('/api/admin/driver-staff/' + driverId + '/salary-history')
        .set('Authorization', 'Bearer ' + adminToken);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].year).toBe(year);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('D. Khoá tài xế', () => {
    let driverId;

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/admin/driver-staff')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ username: NEW_DRIVER + '_lock', password: 'TaiXeMoi@2026' });
      driverId = res.body.id;
    });

    test('Khoá tài xế → tài khoản bị khoá + session bị huỷ', async () => {
      const res = await request(app)
        .delete('/api/admin/driver-staff/' + driverId)
        .set('Authorization', 'Bearer ' + adminToken);
      expect(res.status).toBe(200);

      const user = db.prepare('SELECT active FROM app_users WHERE username = ?').get(NEW_DRIVER + '_lock');
      expect(user.active).toBe(0);

      const sess = db
        .prepare('SELECT COUNT(*) AS c FROM auth_sessions WHERE username = ?')
        .get(NEW_DRIVER + '_lock').c;
      expect(sess).toBe(0);
    });

    test('Tài khoản bị khoá không đăng nhập được', () => {
      expect(loginAs(NEW_DRIVER + '_lock', 'TaiXeMoi@2026')).toBeNull();
    });
  });
});
