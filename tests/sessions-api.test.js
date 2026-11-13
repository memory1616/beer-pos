/**
 * Sessions API — Test tích hợp (A4)
 * ─────────────────────────────────────────────────────────────────────────────
 * Kiểm tra:
 *  - Admin xem được danh sách phiên, huỷ phiên từ xa, huỷ hàng loạt
 *  - Driver bị chặn 403 ở mọi endpoint
 *  - Không đăng nhập → 401
 *  - Không huỷ được chính phiên của mình
 *  - Token bị huỷ mất hiệu lực ngay
 */
process.env.NODE_ENV = 'test';
// middleware/auth.js yêu cầu ADMIN_PASSWORD (chỉ để chặn process khi NODE_ENV
// !== 'test'). Đặt ở đây để không in cảnh báo "FATAL: ADMIN_PASSWORD not set".
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Zxcv@1234';
process.env.ADMIN_USER = process.env.ADMIN_USER || 'admin';

const request = require('supertest');
const db = require('../database');
const { hashPassword } = require('../src/utils/password');
const { ROLE_ADMIN, ROLE_DRIVER } = require('../middleware/permissions');

jest.setTimeout(20000);

const ADMIN_USER = 'a4_sess_admin';
const DRIVER_USER = 'a4_sess_driver';
const PASSWORD = 'Zxcv@1234';

// ── Build app ──────────────────────────────────────────────────────────────
function buildApp() {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const { requireAuth } = require('../middleware/auth');
  const { apiGuard, attachSanitizer } = require('../middleware/permissions');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.use('/api/sessions', requireAuth, require('../routes/api/sessions'));

  // Guard chung cho API admin (như server.js)
  app.use('/api', apiGuard, attachSanitizer);

  return app;
}

const app = buildApp();

let adminToken;
let driverToken;

function createSession(username, role, appUserId = null) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    `INSERT OR REPLACE INTO auth_sessions
     (token, username, created_at, expires_at, last_active, role, app_user_id)
     VALUES (?, ?, datetime('now'), ?, ?, ?, ?)`
  ).run(token, username, Date.now() + 60000, Date.now(), role, appUserId);
  return token;
}

beforeAll(() => {
  db.prepare('DELETE FROM app_users WHERE username IN (?, ?)').run(ADMIN_USER, DRIVER_USER);
  db.prepare(
    `INSERT INTO app_users (username, password_hash, full_name, role, active)
     VALUES (?, ?, ?, 'DRIVER', 1)`
  ).run(DRIVER_USER, hashPassword(PASSWORD), 'A4 Sess Driver');

  adminToken = createSession(ADMIN_USER, ROLE_ADMIN);
  driverToken = createSession(DRIVER_USER, ROLE_DRIVER, 1);
});

afterAll(() => {
  try { db.prepare('DELETE FROM app_users WHERE username IN (?, ?)').run(ADMIN_USER, DRIVER_USER); } catch (e) { /* ignore */ }
  try { db.prepare('DELETE FROM auth_sessions WHERE username IN (?, ?)').run(ADMIN_USER, DRIVER_USER); } catch (e) { /* ignore */ }
});

describe('GET /api/sessions', () => {
  test('trả 401 khi chưa đăng nhập', async () => {
    const res = await request(app).get('/api/sessions');
    expect(res.status).toBe(401);
  });

  test('trả 403 cho driver', async () => {
    const res = await request(app)
      .get('/api/sessions')
      .set('Authorization', 'Bearer ' + driverToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_ONLY');
  });

  test('admin thấy danh sách phiên, đánh dấu phiên hiện tại', async () => {
    const res = await request(app)
      .get('/api/sessions')
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions.length).toBeGreaterThanOrEqual(2);

    const current = res.body.sessions.find((s) => s.isCurrent);
    expect(current).toBeTruthy();
    expect(current.username).toBe(ADMIN_USER);
  });

  test('danh sách có role của từng phiên', async () => {
    const res = await request(app)
      .get('/api/sessions')
      .set('Authorization', 'Bearer ' + adminToken);
    const drv = res.body.sessions.find((s) => s.username === DRIVER_USER);
    expect(drv).toBeTruthy();
    expect(drv.role).toBe('DRIVER');
    expect(drv.isCurrent).toBe(false);
  });
});

describe('POST /api/sessions/:token/revoke', () => {
  test('trả 403 cho driver', async () => {
    const res = await request(app)
      .post('/api/sessions/abc/revoke')
      .set('Authorization', 'Bearer ' + driverToken);
    expect(res.status).toBe(403);
  });

  test('huỷ phiên của user khác → token mất hiệu lực', async () => {
    const target = createSession('a4_sess_target', ROLE_DRIVER, 1);

    const res = await request(app)
      .post('/api/sessions/' + encodeURIComponent(target) + '/revoke')
      .set('Authorization', 'Bearer ' + adminToken);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.username).toBe('a4_sess_target');

    const row = db.prepare('SELECT * FROM auth_sessions WHERE token = ?').get(target);
    expect(row).toBeUndefined();
  });

  test('không huỷ được chính phiên của mình', async () => {
    const res = await request(app)
      .post('/api/sessions/' + encodeURIComponent(adminToken) + '/revoke')
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/chính mình/i);
  });

  test('phiên không tồn tại → 404', async () => {
    const res = await request(app)
      .post('/api/sessions/khong-ton-tai-xyz/revoke')
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/sessions/revoke-all', () => {
  test('scope=drivers chỉ huỷ phiên driver, giữ phiên admin', async () => {
    const d1 = createSession('a4_sess_d1', ROLE_DRIVER, 1);
    const d2 = createSession('a4_sess_d2', ROLE_DRIVER, 1);

    const res = await request(app)
      .post('/api/sessions/revoke-all')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ scope: 'drivers' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.revoked).toBeGreaterThanOrEqual(2);

    expect(db.prepare('SELECT * FROM auth_sessions WHERE token = ?').get(d1)).toBeUndefined();
    expect(db.prepare('SELECT * FROM auth_sessions WHERE token = ?').get(d2)).toBeUndefined();
    // Phiên admin vẫn còn
    expect(db.prepare('SELECT * FROM auth_sessions WHERE token = ?').get(adminToken)).toBeTruthy();
  });

  test('scope=all huỷ mọi phiên trừ phiên hiện tại', async () => {
    const other = createSession('a4_sess_other', ROLE_DRIVER, 1);

    const res = await request(app)
      .post('/api/sessions/revoke-all')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ scope: 'all' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(db.prepare('SELECT * FROM auth_sessions WHERE token = ?').get(other)).toBeUndefined();
    expect(db.prepare('SELECT * FROM auth_sessions WHERE token = ?').get(adminToken)).toBeTruthy();
  });
});
