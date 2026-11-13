/**
 * Driver Push Notification — Test tích hợp
 * ─────────────────────────────────────────────────────────────────────────────
 * Kiểm tra:
 *  - Migration 051 tạo bảng `push_subscriptions` + `push_notifications`
 *  - PushService: VAPID, subscribe/unsubscribe, notifyDriver, log
 *  - API /api/push: driver subscribe OK, admin bị chặn 403, chưa đăng nhập 401
 *  - Socket: room riêng `driver:<username>` + event `order:assigned`
 *  - Bảo mật: payload tài xế KHÔNG chứa field tài chính
 */
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Zxcv@1234';
process.env.ADMIN_USER = process.env.ADMIN_USER || 'admin';

const request = require('supertest');
const db = require('../database');
const PushService = require('../src/services/PushService');
const { hashPassword } = require('../src/utils/password');
const { ROLE_ADMIN, ROLE_DRIVER } = require('../middleware/permissions');

jest.setTimeout(25000);

const ADMIN_USER = 'push_admin';
const DRIVER_USER = 'push_driver';
const PASSWORD = 'Zxcv@1234';

// ── Build app ──────────────────────────────────────────────────────────────
function buildApp() {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const { requireAuth } = require('../middleware/auth');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/push', requireAuth, require('../routes/api/push'));
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
  ).run(DRIVER_USER, hashPassword(PASSWORD), 'Push Driver');

  adminToken = createSession(ADMIN_USER, ROLE_ADMIN);
  driverToken = createSession(DRIVER_USER, ROLE_DRIVER, 1);

  try { db.prepare('DELETE FROM push_subscriptions').run(); } catch (e) { /* ignore */ }
  try { db.prepare('DELETE FROM push_notifications').run(); } catch (e) { /* ignore */ }
});

afterAll(() => {
  try { db.prepare('DELETE FROM app_users WHERE username IN (?, ?)').run(ADMIN_USER, DRIVER_USER); } catch (e) { /* ignore */ }
  try { db.prepare('DELETE FROM auth_sessions WHERE username IN (?, ?)').run(ADMIN_USER, DRIVER_USER); } catch (e) { /* ignore */ }
  try { db.prepare('DELETE FROM push_subscriptions').run(); } catch (e) { /* ignore */ }
  try { db.prepare('DELETE FROM push_notifications').run(); } catch (e) { /* ignore */ }
});

// ═══════════════════════════════════════════════════════════════════════
// Migration 051
// ═══════════════════════════════════════════════════════════════════════
describe('Migration 051 — push tables', () => {
  test('bảng push_subscriptions tồn tại', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='push_subscriptions'")
      .all();
    expect(tables.length).toBe(1);
  });

  test('bảng push_notifications tồn tại', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='push_notifications'")
      .all();
    expect(tables.length).toBe(1);
  });

  test('push_subscriptions có đủ cột chính', () => {
    const cols = db.prepare('PRAGMA table_info(push_subscriptions)').all().map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'username', 'endpoint', 'p256dh', 'auth', 'user_agent',
        'push_enabled', 'failure_count', 'created_at', 'last_used_at',
      ])
    );
  });

  test('có index theo username', () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='push_subscriptions'")
      .all()
      .map((i) => i.name);
    expect(idx).toEqual(expect.arrayContaining(['idx_push_subscriptions_username']));
  });

  test('settings push_* đã được seed', () => {
    const rows = db
      .prepare("SELECT key FROM settings WHERE key LIKE 'push_%'")
      .all()
      .map((r) => r.key);
    expect(rows).toEqual(
      expect.arrayContaining([
        'push_enabled', 'push_vapid_public_key',
        'push_vapid_private_key', 'push_title_template',
      ])
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PushService
// ═══════════════════════════════════════════════════════════════════════
describe('PushService — VAPID', () => {
  test('ensureVapid trả về public key hợp lệ', () => {
    const res = PushService.ensureVapid();
    expect(res.ok).toBe(true);
    expect(res.publicKey.length).toBeGreaterThan(20);
  });

  test('getPublicKey trả về khóa đã lưu', () => {
    const key = PushService.getPublicKey();
    const stored = db
      .prepare("SELECT value FROM settings WHERE key = 'push_vapid_public_key'")
      .get();
    expect(key).toBe(stored.value);
  });

  test('isEnabled đọc từ settings', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('push_enabled', '1')").run();
    expect(PushService.isEnabled()).toBe(true);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('push_enabled', '0')").run();
    expect(PushService.isEnabled()).toBe(false);
  });
});

describe('PushService — subscription', () => {
  const endpoint = 'https://push.example.com/sub/test-1';

  afterEach(() => {
    try { db.prepare('DELETE FROM push_subscriptions').run(); } catch (e) { /* ignore */ }
  });

  test('lưu subscription thành công', () => {
    const res = PushService.saveSubscription(DRIVER_USER, {
      endpoint,
      keys: { p256dh: 'PUBKEY', auth: 'AUTHKEY' },
    }, 'jest-agent');
    expect(res.ok).toBe(true);

    const row = db
      .prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?')
      .get(endpoint);
    expect(row).toBeTruthy();
    expect(row.username).toBe(DRIVER_USER);
    expect(row.p256dh).toBe('PUBKEY');
    expect(row.push_enabled).toBe(1);
  });

  test('lưu lại cùng endpoint → update, không nhân bản', () => {
    PushService.saveSubscription(DRIVER_USER, {
      endpoint, keys: { p256dh: 'P1', auth: 'A1' },
    });
    PushService.saveSubscription(DRIVER_USER, {
      endpoint, keys: { p256dh: 'P2', auth: 'A2' },
    });
    const rows = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').all(endpoint);
    expect(rows.length).toBe(1);
    expect(rows[0].p256dh).toBe('P2');
  });

  test('subscription thiếu endpoint → từ chối', () => {
    const res = PushService.saveSubscription(DRIVER_USER, { keys: { p256dh: 'x', auth: 'y' } });
    expect(res.ok).toBe(false);
  });

  test('subscription thiếu keys → từ chối', () => {
    const res = PushService.saveSubscription(DRIVER_USER, { endpoint: 'https://x/y' });
    expect(res.ok).toBe(false);
  });

  test('xoá subscription', () => {
    PushService.saveSubscription(DRIVER_USER, {
      endpoint, keys: { p256dh: 'P', auth: 'A' },
    });
    const res = PushService.removeSubscription(DRIVER_USER, endpoint);
    expect(res.ok).toBe(true);
    expect(PushService.listSubscriptions(DRIVER_USER).length).toBe(0);
  });

  test('listSubscriptions chỉ trả về thiết bị đang bật', () => {
    PushService.saveSubscription(DRIVER_USER, {
      endpoint, keys: { p256dh: 'P', auth: 'A' },
    });
    expect(PushService.listSubscriptions(DRIVER_USER).length).toBe(1);

    db.prepare('UPDATE push_subscriptions SET push_enabled = 0').run();
    expect(PushService.listSubscriptions(DRIVER_USER).length).toBe(0);
  });
});

describe('PushService — gửi', () => {
  test('notifyDriver với tài xế chưa đăng ký → không lỗi', async () => {
    const res = await PushService.notifyDriver('khong-ton-tai', {
      title: 'Test', body: 'Test',
    });
    expect(res.sent).toBe(0);
    expect(res.failed).toBe(0);
  });

  test('notifyNewOrder ghi log vào push_notifications', async () => {
    await PushService.notifyNewOrder({
      driverUsername: DRIVER_USER,
      saleId: 4242,
      customerName: 'Quán Test',
      kegs: 3,
      liters: 12,
    });
    const row = db
      .prepare('SELECT * FROM push_notifications WHERE sale_id = 4242 ORDER BY id DESC LIMIT 1')
      .get();
    expect(row).toBeTruthy();
    expect(row.driver_username).toBe(DRIVER_USER);
  });

  test('getHistory trả về danh sách giảm dần', () => {
    const history = PushService.getHistory(10);
    expect(Array.isArray(history)).toBe(true);
    if (history.length > 1) {
      expect(history[0].id).toBeGreaterThan(history[1].id);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// API /api/push
// ═══════════════════════════════════════════════════════════════════════
describe('API /api/push — tài xế', () => {
  test('GET /vapid-key khi chưa đăng nhập → 401', async () => {
    const res = await request(app).get('/api/push/vapid-key');
    expect(res.status).toBe(401);
  });

  test('GET /vapid-key với token driver → 200 + publicKey', async () => {
    const res = await request(app)
      .get('/api/push/vapid-key')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.publicKey).toBe('string');
    expect(res.body.publicKey.length).toBeGreaterThan(20);
  });

  test('POST /subscribe lưu subscription của chính tài xế', async () => {
    const endpoint = 'https://push.example.com/api-test';
    const res = await request(app)
      .post('/api/push/subscribe')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        subscription: { endpoint, keys: { p256dh: 'PUB', auth: 'AUTH' } },
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const row = db
      .prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?')
      .get(endpoint);
    expect(row.username).toBe(DRIVER_USER);
  });

  test('POST /subscribe không có endpoint → 400', async () => {
    const res = await request(app)
      .post('/api/push/subscribe')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ subscription: { keys: { p256dh: 'x', auth: 'y' } } });
    expect(res.status).toBe(400);
  });

  test('POST /subscribe bị admin gọi → 403 DRIVER_ONLY', async () => {
    const res = await request(app)
      .post('/api/push/subscribe')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        subscription: {
          endpoint: 'https://push.example.com/admin-test',
          keys: { p256dh: 'x', auth: 'y' },
        },
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DRIVER_ONLY');
  });

  test('GET /status trả về số thiết bị', async () => {
    const res = await request(app)
      .get('/api/push/status')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.devices).toBe('number');
  });

  test('POST /unsubscribe xoá subscription', async () => {
    const endpoint = 'https://push.example.com/unsub-test';
    try { db.prepare('DELETE FROM push_subscriptions').run(); } catch (e) { /* ignore */ }
    PushService.saveSubscription(DRIVER_USER, {
      endpoint, keys: { p256dh: 'P', auth: 'A' },
    });
    expect(PushService.listSubscriptions(DRIVER_USER).length).toBe(1);

    const res = await request(app)
      .post('/api/push/unsubscribe')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ endpoint });
    expect(res.status).toBe(200);
    expect(PushService.listSubscriptions(DRIVER_USER).length).toBe(0);
  });
});

describe('API /api/push — admin', () => {
  test('GET /admin/config với token driver → 403', async () => {
    const res = await request(app)
      .get('/api/push/admin/config')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_ONLY');
  });

  test('GET /admin/config với token admin → 200', async () => {
    const res = await request(app)
      .get('/api/push/admin/config')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.enabled).toBe('boolean');
    expect(Array.isArray(res.body.stats)).toBe(true);
  });

  test('POST /admin/config lưu cấu hình', async () => {
    const res = await request(app)
      .post('/api/push/admin/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true, titleTemplate: '🚚 Đơn mới' });
    expect(res.status).toBe(200);

    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'push_title_template'")
      .get();
    expect(row.value).toBe('🚚 Đơn mới');

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('push_enabled', '0')").run();
  });

  test('GET /admin/history với token admin → 200', async () => {
    const res = await request(app)
      .get('/api/push/admin/history')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.history)).toBe(true);
  });

  test('POST /admin/test/:username với tài xế không tồn tại → 404', async () => {
    const res = await request(app)
      .post('/api/push/admin/test/khong-ton-tai')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Socket — room riêng từng tài xế
// ═══════════════════════════════════════════════════════════════════════
describe('Socket — order:assigned tới đúng tài xế', () => {
  const socketAuth = require('../src/socket/socketAuth');

  test('driverRoom() tạo room riêng theo username', () => {
    expect(socketAuth.driverRoom('driver1')).toBe('driver:driver1');
    // Không phân biệt hoa/thường
    expect(socketAuth.driverRoom('DRIVER1')).toBe('driver:driver1');
  });

  test('driverRoom() với username rỗng → room driver', () => {
    expect(socketAuth.driverRoom('')).toBe('driver:');
  });

  test('emitOrderAssigned chỉ gửi tới tài xế được gán', async () => {
    const http = require('http');
    const socketServer = require('../src/socket/socketServer');
    const { io: clientIo } = require('socket.io-client');
    const auth = require('../middleware/auth');

    const server = http.createServer();
    const io = socketServer.init(server);

    const origGetSession = auth.getSession;
    auth.getSession = (token) => {
      if (token === 'tok-driver1') {
        return { username: 'driver1', role: ROLE_DRIVER, appUserId: 1 };
      }
      if (token === 'tok-driver2') {
        return { username: 'driver2', role: ROLE_DRIVER, appUserId: 2 };
      }
      return origGetSession(token);
    };

    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const d1 = clientIo(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      auth: { token: 'tok-driver1' },
      query: { mode: 'driver' },
    });
    const d2 = clientIo(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      auth: { token: 'tok-driver2' },
      query: { mode: 'driver' },
    });

    const got1 = [];
    const got2 = [];
    d1.on('order:assigned', (d) => got1.push(d));
    d2.on('order:assigned', (d) => got2.push(d));

    await Promise.all([
      new Promise((res, rej) => {
        d1.on('connect', res);
        d1.on('connect_error', rej);
      }),
      new Promise((res, rej) => {
        d2.on('connect', res);
        d2.on('connect_error', rej);
      }),
    ]);

    socketServer.emitOrderAssigned('driver1', {
      saleId: 777,
      customerName: 'Khách A',
      customerAddress: 'Địa chỉ A',
      customerPhone: '0900000000',
      kegs: 4,
      liters: 20,
    });

    await new Promise((r) => setTimeout(r, 400));

    expect(got1.length).toBe(1);
    expect(got1[0].saleId).toBe(777);
    // Tài xế KHÁC không nhận được
    expect(got2.length).toBe(0);

    // Payload không chứa dữ liệu tài chính
    expect(got1[0].total).toBeUndefined();
    expect(got1[0].profit).toBeUndefined();
    expect(got1[0].cost_price).toBeUndefined();

    d1.close();
    d2.close();
    io.close();
    server.close();
    auth.getSession = origGetSession;
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Backend: admin gán tài xế khi tạo đơn
// ═══════════════════════════════════════════════════════════════════════
describe('Backend — admin gán tài xế khi tạo đơn', () => {
  test('route sales có validate driver tồn tại', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'routes', 'api', 'sales.js'),
      'utf8'
    );
    // Có validate tài xế + role check
    expect(src).toContain('DRIVER_NOT_FOUND');
    expect(src).toContain('DRIVER_ASSIGN_FORBIDDEN');
    // Có gọi notifyAssignedDriver
    expect(src).toContain('notifyAssignedDriver');
  });

  test('driver không thể gán đơn cho tài xế khác', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'routes', 'api', 'sales.js'),
      'utf8'
    );
    expect(src).toContain("requesterRole !== 'ADMIN'");
  });

  test('UI: buildDriverAssignHtml ẩn với Driver Portal', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'public', 'js', 'sales.js'),
      'utf8'
    );
    // Có guard theo window.APP_MODE
    expect(src).toContain("window.APP_MODE === 'driver'");
    // Có select + hàm setSaleDriver
    expect(src).toContain('sale-driver-assign');
    expect(src).toContain('window.setSaleDriver');
  });

  test('UI: submitSale gửi driverUsername khi tạo mới', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'public', 'js', 'sales.js'),
      'utf8'
    );
    expect(src).toContain('payload.driverUsername = saleState.driverUsername');
    // resetSaleState phải xoá driverUsername để đơn sau không bị gán nhầm
    expect(src).toContain('saleState.driverUsername = null;');
  });

  test('UI: resetSaleState xoá tài xế đã chọn', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'public', 'js', 'sales.js'),
      'utf8'
    );
    const idx = src.indexOf('function resetSaleState');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 800);
    expect(body).toContain('saleState.driverUsername = null;');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Permission — driver bị chặn ở các API admin
// ═══════════════════════════════════════════════════════════════════════
describe('Permission — /api/push', () => {
  test('apiGuard cho phép DRIVER gọi /api/push', () => {
    const { DRIVER_ALLOWED_API_PREFIXES } = require('../middleware/permissions');
    expect(DRIVER_ALLOWED_API_PREFIXES).toContain('/api/push');
  });

  test('/push-notify là trang ADMIN-ONLY', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'middleware', 'permissions.js'),
      'utf8'
    );
    expect(src).toContain("'/push-notify'");
  });
});
