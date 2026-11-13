/**
 * Audit Log — Test tích hợp (A3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Kiểm tra:
 *  - Migration tạo bảng `audit_logs` đúng cấu trúc
 *  - Service: ghi log, lọc, phân trang, diff, lọc field nhạy cảm
 *  - API: admin đọc được, driver bị chặn 403, chưa đăng nhập → 401
 *  - Middleware tự động ghi log route MUTATION, bỏ qua GET
 *  - FAIL-OPEN: lỗi audit KHÔNG làm hỏng request chính
 */
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Zxcv@1234';
process.env.ADMIN_USER = process.env.ADMIN_USER || 'admin';

const request = require('supertest');
const db = require('../database');
const AuditLogService = require('../src/services/AuditLogService');
const { hashPassword } = require('../src/utils/password');
const { ROLE_ADMIN, ROLE_DRIVER } = require('../middleware/permissions');

jest.setTimeout(20000);

const ADMIN_USER = 'a3_audit_admin';
const DRIVER_USER = 'a3_audit_driver';
const PASSWORD = 'Zxcv@1234';

// ── Build app ──────────────────────────────────────────────────────────────
function buildApp() {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const { requireAuth } = require('../middleware/auth');
  const { apiGuard, attachSanitizer } = require('../middleware/permissions');
  const auditLogger = require('../middleware/auditLog');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // Audit middleware phải mount SAU optionalAuth và TRƯỚC route handler
  // (giống server.js) để kịp bắt res 'finish'.
  app.use('/api', requireAuth, auditLogger);

  // Route giả lập để test middleware audit tự động
  app.post('/api/sales', (req, res) => res.json({ success: true }));
  app.get('/api/sales', (req, res) => res.json({ success: true }));
  app.delete('/api/sales/:id', (req, res) => res.json({ success: true }));

  app.use('/api/sessions', requireAuth, require('../routes/api/sessions'));
  app.use('/api/audit-log', requireAuth, require('../routes/api/auditLog'));

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
  // Bảng audit_logs phải tồn tại (migration 050 chạy khi require database)
  db.prepare('DELETE FROM app_users WHERE username IN (?, ?)').run(ADMIN_USER, DRIVER_USER);
  db.prepare(
    `INSERT INTO app_users (username, password_hash, full_name, role, active)
     VALUES (?, ?, ?, 'DRIVER', 1)`
  ).run(DRIVER_USER, hashPassword(PASSWORD), 'A3 Audit Driver');

  adminToken = createSession(ADMIN_USER, ROLE_ADMIN);
  driverToken = createSession(DRIVER_USER, ROLE_DRIVER, 1);

  // Dọn log cũ để test đếm chính xác
  db.prepare('DELETE FROM audit_logs').run();
});

afterAll(() => {
  try { db.prepare('DELETE FROM app_users WHERE username IN (?, ?)').run(ADMIN_USER, DRIVER_USER); } catch (e) { /* ignore */ }
  try { db.prepare('DELETE FROM auth_sessions WHERE username IN (?, ?)').run(ADMIN_USER, DRIVER_USER); } catch (e) { /* ignore */ }
  try { db.prepare('DELETE FROM audit_logs').run(); } catch (e) { /* ignore */ }
});

// ═══════════════════════════════════════════════════════════════════════
// Migration
// ═══════════════════════════════════════════════════════════════════════
describe('Migration 050 — audit_logs', () => {
  test('bảng audit_logs tồn tại', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_logs'")
      .all();
    expect(tables.length).toBe(1);
  });

  test('có đủ cột chính', () => {
    const cols = db.prepare('PRAGMA table_info(audit_logs)').all().map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'actor_username', 'actor_role', 'action', 'entity', 'entity_id',
        'description', 'changes', 'ip_address', 'user_agent', 'status', 'created_at',
      ])
    );
  });

  test('có index theo created_at, actor, action, entity', () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_logs'")
      .all()
      .map((i) => i.name);
    expect(idx).toEqual(
      expect.arrayContaining([
        'idx_audit_logs_created',
        'idx_audit_logs_actor',
        'idx_audit_logs_action',
        'idx_audit_logs_entity',
      ])
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AuditLogService
// ═══════════════════════════════════════════════════════════════════════
describe('AuditLogService — ghi log', () => {
  test('ghi 1 dòng cơ bản', () => {
    const id = AuditLogService.record({
      action: 'sale_created',
      actorUsername: 'admin',
      actorRole: 'ADMIN',
      entity: 'sale',
      entityId: '123',
      description: 'Tạo đơn bán #123',
    });
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(id);
    expect(row.action).toBe('sale_created');
    expect(row.actor_username).toBe('admin');
    expect(row.entity).toBe('sale');
    expect(row.entity_id).toBe('123');
    expect(row.status).toBe('success');
  });

  test('action rỗng → không ghi', () => {
    const id = AuditLogService.record({ action: '' });
    expect(id).toBeNull();
  });

  test('ghi với status=failed', () => {
    const id = AuditLogService.record({
      action: 'login_failed',
      actorUsername: 'x',
      description: 'sai mật khẩu',
      status: 'failed',
    });
    const row = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(id);
    expect(row.status).toBe('failed');
  });

  test('FAIL-OPEN: lỗi DB không ném ra ngoài', () => {
    // entityId là object → SQLite không nhận → phải bị nuốt, không throw
    expect(() =>
      AuditLogService.record({ action: 'test_fail_open', entityId: { bad: true } })
    ).not.toThrow();
  });
});

describe('AuditLogService — lọc field nhạy cảm', () => {
  test('isSensitive nhận diện field mật khẩu/token', () => {
    expect(AuditLogService.isSensitive('password')).toBe(true);
    expect(AuditLogService.isSensitive('password_hash')).toBe(true);
    expect(AuditLogService.isSensitive('oldPassword')).toBe(true);
    expect(AuditLogService.isSensitive('session_token')).toBe(true);
    expect(AuditLogService.isSensitive('accessToken')).toBe(true);
    expect(AuditLogService.isSensitive('api_key')).toBe(true);
    expect(AuditLogService.isSensitive('zalo_oa_access_token')).toBe(true);
    expect(AuditLogService.isSensitive('name')).toBe(false);
    expect(AuditLogService.isSensitive('price')).toBe(false);
  });

  test('normalizeValue bỏ field nhạy cảm trong object lồng', () => {
    const out = AuditLogService.normalizeValue({
      name: 'Bia',
      password: 'matkhau',
      nested: { token: 'abc', keep: 1 },
    });
    expect(out.name).toBe('Bia');
    expect(out.password).toBe('[REDACTED]');
    expect(out.nested.token).toBe('[REDACTED]');
    expect(out.nested.keep).toBe(1);
  });

  test('changes không chứa field nhạy cảm', () => {
    const id = AuditLogService.record({
      action: 'user_updated',
      entity: 'user',
      changes: { password: 'newpass', name: 'Ten moi' },
    });
    const row = db.prepare('SELECT changes FROM audit_logs WHERE id = ?').get(id);
    const parsed = JSON.parse(row.changes);
    expect(parsed.password).toBeUndefined();
    expect(parsed.name).toBeDefined();
  });
});

describe('AuditLogService — diffObjects', () => {
  test('trả về chỉ field thay đổi', () => {
    const diff = AuditLogService.diffObjects(
      { name: 'A', price: 100, qty: 5 },
      { name: 'A', price: 200, qty: 5 }
    );
    expect(diff).toEqual({ price: { from: 100, to: 200 } });
  });

  test('không đổi gì → null', () => {
    expect(AuditLogService.diffObjects({ a: 1 }, { a: 1 })).toBeNull();
  });

  test('bỏ qua field nhạy cảm', () => {
    const diff = AuditLogService.diffObjects(
      { password: 'a', name: 'x' },
      { password: 'b', name: 'y' }
    );
    expect(diff.password).toBeUndefined();
    expect(diff.name).toEqual({ from: 'x', to: 'y' });
  });

  test('input không hợp lệ → null', () => {
    expect(AuditLogService.diffObjects(null, {})).toBeNull();
    expect(AuditLogService.diffObjects({}, undefined)).toBeNull();
  });
});

describe('AuditLogService — list & thống kê', () => {
  beforeAll(() => {
    db.prepare('DELETE FROM audit_logs').run();
    AuditLogService.record({
      action: 'sale_created', actorUsername: 'admin', actorRole: 'ADMIN',
      entity: 'sale', entityId: '1', description: 'don 1',
    });
    AuditLogService.record({
      action: 'customer_updated', actorUsername: 'driver01', actorRole: 'DRIVER',
      entity: 'customer', entityId: '2', description: 'sua khach',
    });
    AuditLogService.record({
      action: 'login_failed', actorUsername: 'driver01', actorRole: 'DRIVER',
      description: 'sai mat khau', status: 'failed',
    });
  });

  test('list trả về tất cả', () => {
    const res = AuditLogService.list({});
    expect(res.total).toBe(3);
    expect(res.logs.length).toBe(3);
  });

  test('lọc theo actor', () => {
    const res = AuditLogService.list({ actor: 'driver01' });
    expect(res.total).toBe(2);
    expect(res.logs.every((l) => l.actor === 'driver01')).toBe(true);
  });

  test('lọc theo action', () => {
    const res = AuditLogService.list({ action: 'sale_created' });
    expect(res.total).toBe(1);
    expect(res.logs[0].action).toBe('sale_created');
  });

  test('lọc theo status', () => {
    const res = AuditLogService.list({ status: 'failed' });
    expect(res.total).toBe(1);
    expect(res.logs[0].status).toBe('failed');
  });

  test('lọc theo entity + entityId', () => {
    const res = AuditLogService.list({ entity: 'customer', entityId: '2' });
    expect(res.total).toBe(1);
  });

  test('tìm kiếm theo description', () => {
    const res = AuditLogService.list({ search: 'don 1' });
    expect(res.total).toBe(1);
  });

  test('phân trang: limit + offset', () => {
    const p1 = AuditLogService.list({ limit: 2, offset: 0 });
    const p2 = AuditLogService.list({ limit: 2, offset: 2 });
    expect(p1.logs.length).toBe(2);
    expect(p2.logs.length).toBe(1);
    expect(p1.total).toBe(3);
  });

  test('mới nhất trước (ORDER BY id DESC)', () => {
    const res = AuditLogService.list({});
    expect(res.logs[0].id).toBeGreaterThan(res.logs[res.logs.length - 1].id);
  });

  test('stats tổng hợp theo actor & action', () => {
    const stats = AuditLogService.stats(30);
    expect(Array.isArray(stats.byActor)).toBe(true);
    expect(Array.isArray(stats.byAction)).toBe(true);
    expect(stats.failed).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════════
describe('GET /api/audit-log', () => {
  test('trả 401 khi chưa đăng nhập', async () => {
    const res = await request(app).get('/api/audit-log');
    expect(res.status).toBe(401);
  });

  test('trả 403 cho driver', async () => {
    const res = await request(app)
      .get('/api/audit-log')
      .set('Authorization', 'Bearer ' + driverToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_ONLY');
  });

  test('admin đọc được danh sách', async () => {
    const res = await request(app)
      .get('/api/audit-log')
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.logs)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  test('lọc qua query string', async () => {
    AuditLogService.record({
      action: 'product_created', actorUsername: 'admin', entity: 'product', entityId: '9',
    });
    const res = await request(app)
      .get('/api/audit-log?action=product_created')
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(200);
    expect(res.body.logs.every((l) => l.action === 'product_created')).toBe(true);
  });
});

describe('GET /api/audit-log/stats & /actions', () => {
  test('stats trả về thống kê', async () => {
    const res = await request(app)
      .get('/api/audit-log/stats?days=30')
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.stats.byActor)).toBe(true);
  });

  test('actions trả về danh mục', async () => {
    const res = await request(app)
      .get('/api/audit-log/actions')
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(200);
    expect(res.body.actions).toContain('sale_created');
  });
});

describe('POST /api/audit-log/purge', () => {
  test('driver bị chặn', async () => {
    const res = await request(app)
      .post('/api/audit-log/purge')
      .set('Authorization', 'Bearer ' + driverToken)
      .send({ days: 90 });
    expect(res.status).toBe(403);
  });

  test('admin purge được và ghi lại thao tác', async () => {
    // Tạo 1 dòng "cũ" để purge thật sự xoá
    db.prepare(
      `INSERT INTO audit_logs (actor_username, action, created_at)
       VALUES ('old', 'sale_created', datetime('now', '-200 days'))`
    ).run();

    const res = await request(app)
      .post('/api/audit-log/purge')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ days: 90 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deleted).toBeGreaterThanOrEqual(1);

    // Thao tác purge được ghi lại
    const audit = db
      .prepare("SELECT * FROM audit_logs WHERE action = 'audit_log_purged' ORDER BY id DESC LIMIT 1")
      .get();
    expect(audit).toBeTruthy();
    expect(audit.actor_username).toBe(ADMIN_USER);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Middleware tự động
// ═══════════════════════════════════════════════════════════════════════
describe('Middleware audit tự động', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM audit_logs').run();
  });

  test('POST mutation → được ghi log', async () => {
    await request(app)
      .post('/api/sales')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ items: [] });

    const row = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 1').get();
    expect(row).toBeTruthy();
    expect(row.action).toBe('sale_created');
    expect(row.actor_username).toBe(ADMIN_USER);
    expect(row.actor_role).toBe('ADMIN');
    expect(row.entity).toBe('sale');
  });

  test('DELETE mutation → action _deleted', async () => {
    await request(app)
      .delete('/api/sales/55')
      .set('Authorization', 'Bearer ' + adminToken);

    const row = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 1').get();
    expect(row.action).toBe('sale_deleted');
    expect(row.entity_id).toBe('55');
  });

  test('GET → KHÔNG ghi log', async () => {
    await request(app)
      .get('/api/sales')
      .set('Authorization', 'Bearer ' + adminToken);

    const count = db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c;
    expect(count).toBe(0);
  });

  test('path không map entity → KHÔNG ghi log', async () => {
    await request(app)
      .post('/api/unknown-thing')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({});

    const count = db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c;
    expect(count).toBe(0);
  });

  test('resolveEntity suy ra đúng entity', () => {
    const auditLogger = require('../middleware/auditLog');
    expect(auditLogger.resolveEntity('/api/sales')).toBe('sale');
    expect(auditLogger.resolveEntity('/api/sales/12')).toBe('sale');
    expect(auditLogger.resolveEntity('/api/customers')).toBe('customer');
    expect(auditLogger.resolveEntity('/api/xyz')).toBeNull();
  });

  test('resolveAction suy ra đúng action', () => {
    const auditLogger = require('../middleware/auditLog');
    expect(auditLogger.resolveAction('POST', 'sale')).toBe('sale_created');
    expect(auditLogger.resolveAction('PUT', 'sale')).toBe('sale_updated');
    expect(auditLogger.resolveAction('PATCH', 'sale')).toBe('sale_updated');
    expect(auditLogger.resolveAction('DELETE', 'sale')).toBe('sale_deleted');
    expect(auditLogger.resolveAction('GET', 'sale')).toBeNull();
  });

  test('/api/audit-log nằm trong SKIP_PATHS (không ghi trùng)', () => {
    const auditLogger = require('../middleware/auditLog');
    expect(auditLogger.SKIP_PATHS).toContain('/api/audit-log');
    expect(auditLogger.SKIP_PATHS).toContain('/api/sessions');
  });
});
