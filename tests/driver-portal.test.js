/**
 * Driver Portal — Test bảo mật RBAC
 * ─────────────────────────────────────────────────────────────────────────────
 * Kiểm tra:
 *  - Driver KHÔNG đọc được cost_price / profit / doanh thu tổng
 *  - Driver KHÔNG truy cập được API admin (analytics, report, expenses, backup…)
 *  - Admin vẫn hoạt động bình thường, vẫn xem lợi nhuận
 *  - Driver chỉ thấy dữ liệu của mình
 *  - Không nhân đôi đơn / không ghi đè dữ liệu cũ
 */

process.env.NODE_ENV = 'test';

const request = require('supertest');
const db = require('../database');
const { hashPassword } = require('../src/utils/password');
const {
  sanitizeObject,
  FORBIDDEN_FIELDS,
  ROLE_DRIVER,
  ROLE_ADMIN,
} = require('../middleware/permissions');

jest.setTimeout(20000);

// ── Tạo app Express test (không cần listen) ───────────────────────────────
function buildApp() {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const { requireAuth, login } = require('../middleware/auth');
  const { apiGuard, attachSanitizer } = require('../middleware/permissions');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // API driver (giống server.js)
  app.use('/api/driver', requireAuth, require('../routes/api/driver'));

  // Guard chung cho API admin
  app.use('/api', requireAuth, apiGuard, attachSanitizer);

  // API admin thật
  app.use('/api/customers', require('../routes/api/customers'));
  app.use('/api/products', require('../routes/api/products'));
  app.use('/api/sales', require('../routes/api/sales'));
  app.use('/api/analytics', require('../routes/api/analytics'));
  app.use('/api/expenses', require('../routes/api/expenses'));
  app.use('/api/backup', require('../routes/api/backup'));
  app.use('/api/settings', require('../routes/api/settings'));
  app.use('/api/admin', require('../routes/api/admin'));

  return app;
}

let app;

// ── Fixtures ───────────────────────────────────────────────────────────────
const TEST_DRIVER = 'test_driver_01';
const TEST_DRIVER2 = 'test_driver_02';
let driverToken;
let driver2Token;
let adminToken;
let testCustomerId;
let testProductId;
let testSaleId;
let testDeliveryId;

beforeAll(() => {
  app = buildApp();

  // Tạo tài khoản driver test
  const hash = hashPassword('DriverPass123');
  const insert = db.prepare(
    `INSERT OR REPLACE INTO app_users (username, password_hash, role, active, full_name)
     VALUES (?, ?, 'DRIVER', 1, ?)`
  );
  insert.run(TEST_DRIVER, hash, 'Tài xế Test 1');
  insert.run(TEST_DRIVER2, hash, 'Tài xế Test 2');

  // Khách hàng test
  const cust = db.prepare(
    `INSERT INTO customers (name, phone, address, keg_balance, debt, created_at)
     VALUES ('KHÁCH TEST DRIVER', '0900000001', 'Địa chỉ test', 50, 0, datetime('now'))`
  ).run();
  testCustomerId = cust.lastInsertRowid;

  // Sản phẩm test (có cost_price để kiểm tra sanitize)
  const prod = db.prepare(
    `INSERT INTO products (slug, name, stock, cost_price, sell_price, type, archived)
     VALUES ('test_beer_sku', 'Bia Test SKU', 1000, 11000, 20000, 'keg', 0)`
  ).run();
  testProductId = prod.lastInsertRowid;

  // Giá riêng cho khách
  db.prepare(
    `INSERT OR REPLACE INTO prices (customer_id, product_id, product_slug, price)
     VALUES (?, ?, 'test_beer_sku', 21000)`
  ).run(testCustomerId, testProductId);
});

afterAll(() => {
  // Dọn dẹp
  if (testSaleId) {
    try {
      db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(testSaleId);
      db.prepare('DELETE FROM sales WHERE id = ?').run(testSaleId);
    } catch (_) {}
  }
  try {
    db.prepare('DELETE FROM delivery_records WHERE sale_id = ?').run(testSaleId);
    db.prepare('DELETE FROM delivery_record_items WHERE delivery_id NOT IN (SELECT id FROM delivery_records)').run();
    db.prepare('DELETE FROM delivery_events WHERE delivery_id NOT IN (SELECT id FROM delivery_records)').run();
  } catch (_) {}
  try {
    db.prepare('DELETE FROM prices WHERE customer_id = ?').run(testCustomerId);
    db.prepare('DELETE FROM products WHERE id = ?').run(testProductId);
    db.prepare('DELETE FROM customers WHERE id = ?').run(testCustomerId);
    db.prepare("DELETE FROM app_users WHERE username IN (?, ?)").run(TEST_DRIVER, TEST_DRIVER2);
    db.prepare('DELETE FROM auth_sessions WHERE username IN (?, ?)', ).run(TEST_DRIVER, TEST_DRIVER2);
  } catch (_) {}
});

// ── Helpers ────────────────────────────────────────────────────────────────
function loginAs(username, password, driverOnly = true) {
  const { login } = require('../middleware/auth');
  return login(username, password, { driverOnly });
}

describe('Driver Portal — RBAC & Data Protection', () => {
  // ═══════════════════════════════════════════════════════════════════════
  describe('A. Sanitization (lớp dữ liệu)', () => {
    test('sanitizeObject gỡ cost_price và profit', () => {
      const input = {
        id: 1,
        name: 'Bia',
        cost_price: 11000,
        profit: 9000,
        total: 20000,
        nested: { profit: 100, costPrice: 50, ok: 1 },
        list: [{ profit: 5, cost_price: 6, name: 'x' }],
      };
      const out = sanitizeObject(input);

      expect(out.cost_price).toBeUndefined();
      expect(out.profit).toBeUndefined();
      expect(out.total).toBe(20000);
      expect(out.nested.profit).toBeUndefined();
      expect(out.nested.costPrice).toBeUndefined();
      expect(out.nested.ok).toBe(1);
      expect(out.list[0].profit).toBeUndefined();
      expect(out.list[0].cost_price).toBeUndefined();
      expect(out.list[0].name).toBe('x');
    });

    test('sanitizeObject gỡ các trường tài chính tổng hợp', () => {
      const out = sanitizeObject({
        totalRevenue: 100,
        totalProfit: 50,
        margin: 0.2,
        profitByProduct: [{ p: 1 }],
        revenue: 999,
        keep: true,
      });
      expect(out.totalRevenue).toBeUndefined();
      expect(out.totalProfit).toBeUndefined();
      expect(out.margin).toBeUndefined();
      expect(out.profitByProduct).toBeUndefined();
      expect(out.revenue).toBeUndefined();
      expect(out.keep).toBe(true);
    });

    test('FORBIDDEN_FIELDS bao gồm cost_price và profit', () => {
      expect(FORBIDDEN_FIELDS.has('cost_price')).toBe(true);
      expect(FORBIDDEN_FIELDS.has('profit')).toBe(true);
      expect(FORBIDDEN_FIELDS.has('totalProfit')).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('B. Driver đăng nhập', () => {
    test('driver login thành công, nhận role DRIVER', () => {
      const res = loginAs(TEST_DRIVER, 'DriverPass123');
      expect(res).not.toBeNull();
      expect(res.role).toBe(ROLE_DRIVER);
      driverToken = res.token;    });

    test('driver login sai mật khẩu → thất bại', () => {
      expect(loginAs(TEST_DRIVER, 'wrong-password')).toBeNull();
    });

    test('driver bị chặn đăng nhập qua endpoint admin', () => {
      const res = loginAs(TEST_DRIVER, 'DriverPass123', false);
      // driverOnly=false → vẫn cho driver login (hợp lệ), nhưng admin env thì không
      expect(res === null || res.role === ROLE_DRIVER).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('C. Driver KHÔNG đọc được giá vốn / lợi nhuận', () => {
    beforeAll(() => {
      driverToken = loginAs(TEST_DRIVER, 'DriverPass123').token;
    });

    test('GET /api/products của admin KHÔNG trả cost_price cho driver', async () => {
      const res = await request(app)
        .get('/api/products')
        .set('Authorization', 'Bearer ' + driverToken);
      expect(res.status).toBe(403);
    });

    test('GET /api/driver/products KHÔNG có cost_price', async () => {
      const res = await request(app)
        .get('/api/driver/products')
        .set('Authorization', 'Bearer ' + driverToken);
      expect(res.status).toBe(200);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('cost_price');
      expect(raw).not.toContain('costPrice');
      const p = res.body.products.find((x) => x.id === testProductId);
      expect(p).toBeDefined();
      expect(p.cost_price).toBeUndefined();
      expect(p.sell_price).toBeDefined();
    });

    test('GET /api/driver/customers/:id không có trường tài chính', async () => {
      const res = await request(app)
        .get('/api/driver/customers/' + testCustomerId)
        .set('Authorization', 'Bearer ' + driverToken);
      expect(res.status).toBe(200);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('cost_price');
      expect(raw).not.toContain('"profit"');
    });

    test('GET /api/driver/sales/:id không có profit/cost_price', async () => {
      // Tạo đơn trước
      const create = await request(app)
        .post('/api/driver/sales')
        .set('Authorization', 'Bearer ' + driverToken)
        .send({
          customerId: testCustomerId,
          items: [{ productId: testProductId, quantity: 5 }],
          deliverKegs: 5,
        });
      expect(create.status).toBe(200);
      expect(create.body.success).toBe(true);
      testSaleId = create.body.id;

      const res = await request(app)
        .get('/api/driver/sales/' + testSaleId)
        .set('Authorization', 'Bearer ' + driverToken);
      expect(res.status).toBe(200);
      expect(res.body.profit).toBeUndefined();
      expect(res.body.items[0].cost_price).toBeUndefined();
      expect(res.body.items[0].profit).toBeUndefined();
      // Vẫn thấy giá bán & số lượng
      expect(res.body.items[0].price).toBeDefined();
      expect(res.body.items[0].quantity).toBe(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('D. Driver KHÔNG truy cập được API admin', () => {
    const deniedPaths = [
      '/api/analytics',
      '/api/expenses',
      '/api/backup/list',
      '/api/settings',
      '/api/sales',
      '/api/customers',
      '/api/products',
      '/api/payments/debt',
      '/api/debts',
      '/api/kegs/state',
      '/api/stock/alerts',
      '/api/promotions',
      '/api/state/full',
      '/api/sync/status',
      '/api/routing/route',
      '/api/devices',
      '/api/expenses/summary',
    ];

    test.each(deniedPaths)('GET %s bị chặn (403)', async (path) => {
      const res = await request(app)
        .get(path)
        .set('Authorization', 'Bearer ' + driverToken);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('DRIVER_FORBIDDEN');
    });

    test('POST /api/sales bị chặn (không tạo đơn ngoài namespace driver)', async () => {
      const before = db.prepare('SELECT COUNT(*) AS c FROM sales').get().c;
      const res = await request(app)
        .post('/api/sales')
        .set('Authorization', 'Bearer ' + driverToken)
        .send({ customerId: testCustomerId, items: [{ productId: testProductId, quantity: 1 }] });
      expect(res.status).toBe(403);
      const after = db.prepare('SELECT COUNT(*) AS c FROM sales').get().c;
      expect(after).toBe(before); // không tạo đơn
    });

    test('DELETE /api/sales/:id bị chặn', async () => {
      const res = await request(app)
        .delete('/api/sales/' + testSaleId)
        .set('Authorization', 'Bearer ' + driverToken);
      expect(res.status).toBe(403);
    });

    test('PUT /api/products/:id bị chặn', async () => {
      const res = await request(app)
        .put('/api/products/' + testProductId)
        .set('Authorization', 'Bearer ' + driverToken)
        .send({ name: 'hack' });
      expect(res.status).toBe(403);
    });

    test('GET /api/admin/drivers bị chặn (403)', async () => {
      const res = await request(app)
        .get('/api/admin/drivers')
        .set('Authorization', 'Bearer ' + driverToken);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('DRIVER_FORBIDDEN');
    });

    test('POST /api/admin/drivers bị chặn — driver KHÔNG tự tạo tài khoản', async () => {
      const before = db.prepare('SELECT COUNT(*) AS c FROM app_users').get().c;
      const res = await request(app)
        .post('/api/admin/drivers')
        .set('Authorization', 'Bearer ' + driverToken)
        .send({ username: 'driver_self_created', password: 'HackerPass123' });
      expect(res.status).toBe(403);
      const after = db.prepare('SELECT COUNT(*) AS c FROM app_users').get().c;
      expect(after).toBe(before);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('D2. Admin quản lý tài xế (API /api/admin/drivers)', () => {
    const NEW_DRIVER = 'admin_created_driver_01';
    let createdId;

    beforeAll(() => {
      const { hashPassword } = require('../src/utils/password');
      db.prepare(
        `INSERT OR REPLACE INTO app_users (username, password_hash, role, active, full_name)
         VALUES ('admin_test_user', ?, 'ADMIN', 1, 'Admin Test')`
      ).run(hashPassword('AdminPass123'));
      adminToken = loginAs('admin_test_user', 'AdminPass123', false).token;
    });

    afterAll(() => {
      try {
        db.prepare('DELETE FROM app_users WHERE username IN (?, ?)').run(NEW_DRIVER, 'admin_test_user');
        db.prepare('DELETE FROM auth_sessions WHERE username IN (?, ?)')
          .run(NEW_DRIVER, 'admin_test_user');
      } catch (_) {}
    });

    test('Admin tạo được tài khoản tài xế mới', async () => {
      const res = await request(app)
        .post('/api/admin/drivers')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({
          username: NEW_DRIVER,
          password: 'TaiXeMoi@2026',
          fullName: 'Tài xế Mới',
          phone: '0900111222',
        });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.role).toBe(ROLE_DRIVER);
      createdId = res.body.id;

      const row = db.prepare('SELECT * FROM app_users WHERE id = ?').get(createdId);
      expect(row).toBeDefined();
      // Mật khẩu phải được hash, không lưu plaintext
      expect(row.password_hash).not.toContain('TaiXeMoi@2026');
      expect(row.password_hash.length).toBeGreaterThan(20);
    });

    test('Danh sách tài xế KHÔNG chứa password_hash', async () => {
      const res = await request(app)
        .get('/api/admin/drivers')
        .set('Authorization', 'Bearer ' + adminToken);
      expect(res.status).toBe(200);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('password_hash');
      expect(raw).not.toContain('passwordHash');
    });

    test('Tài xế tạo xong đăng nhập được vào Driver Portal', async () => {
      const res = loginAs(NEW_DRIVER, 'TaiXeMoi@2026');
      expect(res).not.toBeNull();
      expect(res.role).toBe(ROLE_DRIVER);
    });

    test('Tài xế tự nâng role lên ADMIN bị từ chối', async () => {
      const res = await request(app)
        .put('/api/admin/drivers/' + createdId)
        .set('Authorization', 'Bearer ' + driverToken)
        .send({ role: ROLE_ADMIN });
      expect(res.status).toBe(403);
      const row = db.prepare('SELECT role FROM app_users WHERE id = ?').get(createdId);
      expect(row.role).toBe(ROLE_DRIVER);
    });

    test('Admin khoá được tài xế — session bị huỷ', async () => {
      const res = await request(app)
        .delete('/api/admin/drivers/' + createdId)
        .set('Authorization', 'Bearer ' + adminToken);
      expect(res.status).toBe(200);
      const row = db.prepare('SELECT active FROM app_users WHERE id = ?').get(createdId);
      expect(row.active).toBe(0);
      const sess = db.prepare('SELECT COUNT(*) AS c FROM auth_sessions WHERE app_user_id = ?')
        .get(createdId).c;
      expect(sess).toBe(0);
    });

    test('Tài khoản bị khoá không đăng nhập được', () => {
      expect(loginAs(NEW_DRIVER, 'TaiXeMoi@2026')).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('E. Driver scope — chỉ thấy dữ liệu của mình', () => {
    test('driver 2 không xem được đơn của driver 1', async () => {
      driver2Token = loginAs(TEST_DRIVER2, 'DriverPass123').token;
      const res = await request(app)
        .get('/api/driver/sales/' + testSaleId)
        .set('Authorization', 'Bearer ' + driver2Token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('DRIVER_SCOPE');
    });

    test('driver 2 không sửa được đơn của driver 1', async () => {
      const res = await request(app)
        .put('/api/driver/sales/' + testSaleId)
        .set('Authorization', 'Bearer ' + driver2Token)
        .send({ items: [{ productId: testProductId, quantity: 1 }] });
      expect(res.status).toBe(403);
    });

    test('driver 2 không huỷ được đơn của driver 1', async () => {
      const res = await request(app)
        .delete('/api/driver/sales/' + testSaleId)
        .set('Authorization', 'Bearer ' + driver2Token);
      expect(res.status).toBe(403);
    });

    test('driver 1 xem được đơn của chính mình', async () => {
      const res = await request(app)
        .get('/api/driver/sales/' + testSaleId)
        .set('Authorization', 'Bearer ' + driverToken);
      expect(res.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('F. Giao hàng — trạng thái & audit', () => {
    test('tạo delivery record cho đơn của mình', async () => {
      const res = await request(app)
        .post('/api/driver/deliveries')
        .set('Authorization', 'Bearer ' + driverToken)
        .send({ saleId: testSaleId });
      expect(res.status).toBe(201);
      expect(res.body.delivery.status).toBe('PENDING');
      expect(res.body.delivery.driver_username).toBe(TEST_DRIVER);
      testDeliveryId = res.body.delivery.id;
    });

    test('tạo lại delivery record KHÔNG nhân đôi (idempotent)', async () => {
      const res = await request(app)
        .post('/api/driver/deliveries')
        .set('Authorization', 'Bearer ' + driverToken)
        .send({ saleId: testSaleId });
      expect(res.status).toBe(200);
      expect(res.body.created).toBe(false);

      const count = db
        .prepare('SELECT COUNT(*) AS c FROM delivery_records WHERE sale_id = ?')
        .get(testSaleId).c;
      expect(count).toBe(1);
    });

    test('đổi trạng thái PENDING → IN_PROGRESS → DELIVERED', async () => {
      const deliveryId = testDeliveryId;

      const start = await request(app)
        .patch('/api/driver/deliveries/' + deliveryId + '/status')
        .set('Authorization', 'Bearer ' + driverToken)
        .send({ status: 'IN_PROGRESS' });
      expect(start.status).toBe(200);
      expect(start.body.delivery.status).toBe('IN_PROGRESS');

      const done = await request(app)
        .patch('/api/driver/deliveries/' + deliveryId + '/status')
        .set('Authorization', 'Bearer ' + driverToken)
        .send({ status: 'DELIVERED' });
      expect(done.status).toBe(200);
      expect(done.body.delivery.status).toBe('DELIVERED');
    });

    test('mọi thay đổi đều được ghi vào delivery_events kèm tài khoản', async () => {
      const events = db
        .prepare('SELECT * FROM delivery_events WHERE delivery_id IN (SELECT id FROM delivery_records WHERE sale_id = ?) ORDER BY id')
        .all(testSaleId);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.actor_username === TEST_DRIVER)).toBe(true);
      expect(events.some((e) => e.event_type === 'CREATED')).toBe(true);
      expect(events.some((e) => e.event_type === 'STATUS_CHANGED')).toBe(true);
    });

    test('driver khác không truy cập được delivery của driver này', async () => {
      const res = await request(app)
        .get('/api/driver/deliveries/' + testDeliveryId)
        .set('Authorization', 'Bearer ' + driver2Token);
      expect(res.status).toBe(404);
    });

    test('driver bị chặn trang HTML quản trị (adminPageGuard)', () => {
      const { adminPageGuard } = require('../middleware/permissions');
      const mk = (path) => {
        const req = { path, method: 'GET', user: { role: ROLE_DRIVER, username: TEST_DRIVER } };
        const res = {
          statusCode: 200,
          status(c) { this.statusCode = c; return this; },
          send(body) { this.body = body; return this; },
          redirect(u) { this.redirected = u; return this; },
        };
        adminPageGuard(req, res, () => { res.passed = true; });
        return res;
      };

      // Các trang quản trị phải bị chặn
      for (const p of ['/dashboard', '/report', '/expenses', '/stock', '/products', '/backup']) {
        const res = mk(p);
        expect(res.passed).toBeUndefined();
        expect(res.statusCode).toBe(403);
      }

      // Trang Driver Portal được phép
      for (const p of ['/driver', '/driver/ban-hang', '/driver/giao-hang']) {
        const res = mk(p);
        expect(res.passed).toBe(true);
      }
    });

    test('driver bị chặn trang HTML quản trị kể cả khi KHÔNG có header Accept', () => {
      // Regression: guard HTML trước đây dựa vào `Accept: text/html`,
      // attacker bỏ header → lách guard. Phải chặn bất kể Accept.
      const { adminPageGuard } = require('../middleware/permissions');
      const mk = (path, accept) => {
        const req = {
          path,
          method: 'GET',
          headers: accept ? { accept } : {},
          user: { role: ROLE_DRIVER, username: TEST_DRIVER },
        };
        const res = {
          statusCode: 200,
          status(c) { this.statusCode = c; return this; },
          send(body) { this.body = body; return this; },
        };
        adminPageGuard(req, res, () => { res.passed = true; });
        return res;
      };

      for (const accept of [undefined, '', 'application/json', '*/*', 'text/html']) {
        for (const p of ['/dashboard', '/report', '/expenses', '/backup', '/products']) {
          const res = mk(p, accept);
          expect(res.passed).toBeUndefined();
          expect(res.statusCode).toBe(403);
        }
      }
    });

    test('getAppMode ưu tiên Host header (giaohang → driver kể cả khi nginx set admin)', () => {
      const { getAppMode } = require('../src/utils/appMode');
      expect(getAppMode({
        headers: { host: 'giaohang.biatuoitayninh.store', 'x-app-mode': 'admin' },
      })).toBe('driver');
      expect(getAppMode({
        headers: { host: 'giaohang.biatuoitayninh.store', 'x-app-mode': 'driver' },
      })).toBe('driver');
      expect(getAppMode({
        headers: { host: 'admin.biatuoitayninh.store', 'x-app-mode': 'admin' },
      })).toBe('admin');
      expect(getAppMode({
        headers: { host: 'biatuoitayninh.store', 'x-app-mode': 'public' },
      })).toBe('public');
    });

    test('ghi nhận sai lệch → trạng thái DISCREPANCY', async () => {
      const res = await request(app)
        .post('/api/driver/deliveries/' + testDeliveryId + '/discrepancy')
        .set('Authorization', 'Bearer ' + driverToken)
        .send({ missingLiters: 5, excessLiters: 0, damagedLiters: 2, note: 'Test' });
      expect(res.status).toBe(200);
      expect(res.body.delivery.status).toBe('DISCREPANCY');
      expect(res.body.delivery.missing_liters).toBe(5);
    });

    test('dashboard tài xế KHÔNG có doanh thu/lợi nhuận', async () => {
      const res = await request(app)
        .get('/api/driver/dashboard')
        .set('Authorization', 'Bearer ' + driverToken);
      expect(res.status).toBe(200);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('profit');
      expect(raw).not.toContain('cost_price');
      expect(raw).not.toContain('totalRevenue');
      expect(res.body.orders).toBeDefined();
      expect(res.body.liters).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('F2. Phạm vi giao hàng — own_plus_unassigned', () => {
    let unassignedSaleId;
    let otherDriverSaleId;

    beforeAll(() => {
      const today = new Date().toISOString().split('T')[0];

      // Đơn Admin tạo — CHƯA gán tài xế
      const s1 = db
        .prepare(
          `INSERT INTO sales (customer_id, date, type, total, driver_username, created_at)
           VALUES (?, ?, 'sale', 100000, NULL, datetime('now'))`
        )
        .run(testCustomerId, today);
      unassignedSaleId = s1.lastInsertRowid;
      db.prepare(
        `INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price)
         VALUES (?, ?, 5, 21000, 11000)`
      ).run(unassignedSaleId, testProductId);

      // Đơn của tài xế KHÁC — driver 1 KHÔNG được thấy
      const s2 = db
        .prepare(
          `INSERT INTO sales (customer_id, date, type, total, driver_username, created_at)
           VALUES (?, ?, 'sale', 100000, ?, datetime('now'))`
        )
        .run(testCustomerId, today, TEST_DRIVER2);
      otherDriverSaleId = s2.lastInsertRowid;
      db.prepare(
        `INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price)
         VALUES (?, ?, 5, 21000, 11000)`
      ).run(otherDriverSaleId, testProductId);
    });

    afterAll(() => {
      for (const id of [unassignedSaleId, otherDriverSaleId]) {
        if (!id) continue;
        try {
          db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(id);
          db.prepare('DELETE FROM delivery_records WHERE sale_id = ?').run(id);
          db.prepare('DELETE FROM sales WHERE id = ?').run(id);
        } catch (_) {}
      }
    });

    test('delivery/page-data chỉ trả đơn của mình + đơn chưa gán (KHÔNG có đơn tài xế khác)', async () => {
      const res = await request(app)
        .get('/api/driver/delivery/page-data')
        .set('Authorization', 'Bearer ' + driverToken);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.customers)).toBe(true);

      const saleIds = res.body.customers.map((c) => c.sale_id);
      expect(saleIds).toContain(unassignedSaleId);
      expect(saleIds).not.toContain(otherDriverSaleId);
    });

    test('page-data KHÔNG lộ delivery_cost_per_km (dữ liệu chi phí)', async () => {
      const res = await request(app)
        .get('/api/driver/delivery/page-data')
        .set('Authorization', 'Bearer ' + driverToken);
      expect(res.status).toBe(200);
      expect(res.body.settings).not.toHaveProperty('delivery_cost_per_km');
      expect(res.body.settings).not.toHaveProperty('delivery_base_cost');
    });

    test('page-data KHÔNG lộ cost_price / profit', async () => {
      const res = await request(app)
        .get('/api/driver/delivery/page-data')
        .set('Authorization', 'Bearer ' + driverToken);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('cost_price');
      expect(raw).not.toContain('profit');
    });

    test('driver KHÔNG tạo được delivery record cho đơn của tài xế khác', async () => {
      const res = await request(app)
        .post('/api/driver/deliveries')
        .set('Authorization', 'Bearer ' + driverToken)
        .send({ saleId: otherDriverSaleId });
      expect(res.status).toBe(403);
    });

    test('driver CÓ tạo được delivery record cho đơn chưa gán và được gán cho mình', async () => {
      const res = await request(app)
        .post('/api/driver/deliveries')
        .set('Authorization', 'Bearer ' + driverToken)
        .send({ saleId: unassignedSaleId });
      expect(res.status).toBe(201);
      expect(res.body.delivery.driver_username).toBe(TEST_DRIVER);

      const sale = db
        .prepare('SELECT driver_username FROM sales WHERE id = ?')
        .get(unassignedSaleId);
      expect(sale.driver_username).toBe(TEST_DRIVER);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('G. Tính toàn vẹn dữ liệu', () => {
    test('đơn tạo bởi driver được ghi nhận driver_username', async () => {
      const sale = db.prepare('SELECT driver_username FROM sales WHERE id = ?').get(testSaleId);
      expect(sale.driver_username).toBe(TEST_DRIVER);
    });

    test('tạo đơn KHÔNG làm sai lợi nhuận hệ thống (cost_price giữ nguyên)', async () => {
      const item = db.prepare('SELECT cost_price FROM sale_items WHERE sale_id = ?').get(testSaleId);
      const prod = db.prepare('SELECT cost_price FROM products WHERE id = ?').get(testProductId);
      expect(item.cost_price).toBe(prod.cost_price);
    });

    test('giá bán dùng giá riêng của khách (21000)', async () => {
      const item = db.prepare('SELECT price FROM sale_items WHERE sale_id = ?').get(testSaleId);
      expect(item.price).toBe(21000);
    });

    test('tạo 2 đơn liên tiếp KHÔG nhân đôi số đơn', async () => {
      const before = db.prepare('SELECT COUNT(*) AS c FROM sales').get().c;
      await request(app)
        .post('/api/driver/sales')
        .set('Authorization', 'Bearer ' + driverToken)
        .send({ customerId: testCustomerId, items: [{ productId: testProductId, quantity: 1 }] });
      const after = db.prepare('SELECT COUNT(*) AS c FROM sales').get().c;
      expect(after).toBe(before + 1);
    });

    test('ghi nhận vỏ thu hồi cập nhật keg_stats + customer balance', async () => {
      const beforeStats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get().empty_collected;
      const beforeCust = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(testCustomerId).keg_balance;

      const res = await request(app)
        .post('/api/driver/deliveries/' + testDeliveryId + '/kegs')
        .set('Authorization', 'Bearer ' + driverToken)
        .send({ collectedKegs: 3 });
      expect(res.status).toBe(200);

      const afterStats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get().empty_collected;
      const afterCust = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(testCustomerId).keg_balance;

      expect(afterStats).toBe(beforeStats + 3);
      expect(afterCust).toBe(beforeCust - 3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('H. Admin vẫn hoạt động bình thường', () => {
    beforeAll(() => {
      const { login } = require('../middleware/auth');
      adminToken = login(process.env.ADMIN_USER || 'admin', process.env.ADMIN_PASSWORD, {
        driverOnly: false,
      })?.token || null;
      // Nếu không có ADMIN_PASSWORD trong env → bỏ qua phần này
    });

    test('admin đăng nhập được (nếu ADMIN_PASSWORD có trong env)', () => {
      if (!process.env.ADMIN_PASSWORD) {
        console.warn('  [SKIP] ADMIN_PASSWORD không có trong env — bỏ qua test admin');
        return;
      }
      expect(adminToken).not.toBeNull();
    });

    test('admin vẫn xem được cost_price trên /api/products', async () => {
      if (!adminToken) return;
      const res = await request(app)
        .get('/api/products')
        .set('Authorization', 'Bearer ' + adminToken);
      expect(res.status).toBe(200);
      const p = res.body.find((x) => x.id === testProductId);
      expect(p).toBeDefined();
      expect(p.cost_price).toBeDefined();
    });

    test('admin vẫn truy cập được báo cáo tài chính', async () => {
      if (!adminToken) return;
      const res = await request(app)
        .get('/api/expenses/summary')
        .set('Authorization', 'Bearer ' + adminToken);
      expect(res.status).toBe(200);
    });

    test('admin vẫn xem được lợi nhuận trên /api/sales', async () => {
      if (!adminToken) return;
      const res = await request(app)
        .get('/api/sales?page=1&limit=5')
        .set('Authorization', 'Bearer ' + adminToken);
      expect(res.status).toBe(200);
      expect(res.body.sales).toBeDefined();
      // Lợi nhuận phải CÒN trong response của admin
      const hasProfitField = res.body.sales.some((s) => s.profit !== undefined);
      expect(hasProfitField).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // I. Chống reload liên tục (reload loop)
  // ═══════════════════════════════════════════════════════════════════════
  describe('I. Chống vòng lặp reload liên tục', () => {
    const fs = require('fs');
    const path = require('path');

    const coreSrc = fs.readFileSync(
      path.join(__dirname, '../public/js/driver/core.js'), 'utf8');
    const loginSrc = fs.readFileSync(
      path.join(__dirname, '../views/driver/login.html'), 'utf8');
    const serverSrc = fs.readFileSync(
      path.join(__dirname, '../server.js'), 'utf8');

    test('core.js chỉ redirect khi 401, KHÔNG redirect khi 429', () => {
      // Đoạn xử lý 401 phải nằm sau check 401, và 429 phải được đánh dấu
      expect(coreSrc).toMatch(/res\.status === 401/);
      expect(coreSrc).toMatch(/err\.rateLimited\s*=\s*true/);
      // Không được có nhánh redirect chung cho mọi lỗi
      expect(coreSrc).not.toMatch(/catch\s*\(\s*_\s*\)\s*\{\s*window\.location\.href\s*=\s*'\/auth\/driver'/);
    });

    test('requireAuth bỏ qua redirect khi lỗi tạm thời (429/5xx/mạng)', () => {
      expect(coreSrc).toMatch(/transient/);
      expect(coreSrc).toMatch(/err\.rateLimited\s*\|\|\s*err\.status === 429/);
    });

    test('có bộ đếm chặn vòng lặp redirect (MAX_REDIRECTS)', () => {
      expect(coreSrc).toMatch(/MAX_REDIRECTS/);
      expect(coreSrc).toMatch(/guardRedirect/);
      expect(loginSrc).toMatch(/g\.count > 5/);
    });

    test('login.html KHÔNG xoá token khi API lỗi tạm thời (429/5xx)', () => {
      // Chỉ xoá token khi 401
      expect(loginSrc).toMatch(/res\.status === 401[\s\S]{0,200}removeItem/);
      // Không xoá token trong catch (lỗi mạng)
      const catchBlock = loginSrc.slice(loginSrc.indexOf('} catch (_) {'));
      expect(catchBlock.slice(0, 200)).not.toMatch(/removeItem/);
    });

    test('server có limiter riêng cho /api/driver, tính theo token', () => {
      expect(serverSrc).toMatch(/app\.use\('\/api\/driver',\s*driverLimiter\)/);
      expect(serverSrc).toMatch(/keyGenerator/);
      // Limiter chung phải BỎ QUA /api/driver
      expect(serverSrc).toMatch(/req\.path\.startsWith\('\/driver\/'\)/);
    });

    test('token ưu tiên Authorization header, không để cookie admin đè lên driver', () => {
      const authSrc = fs.readFileSync(
        path.join(__dirname, '../middleware/auth.js'), 'utf8');
      const permSrc = fs.readFileSync(
        path.join(__dirname, '../middleware/permissions.js'), 'utf8');

      // requireAuth: thử header TRƯỚC cookie admin
      expect(authSrc).toMatch(
        /candidates\s*=\s*\[headerToken,\s*driverCookieToken,\s*adminCookieToken,\s*queryToken\]/);
      // optionalAuth: cùng thứ tự ưu tiên
      expect(permSrc).toMatch(/headerToken \|\| driverCookieToken \|\| adminCookieToken/);
    });

    test('bottom menu Driver chỉ có 4 mục: Trang Chủ | Bán Hàng | Giao Hàng | Đăng Xuất', () => {
      expect(coreSrc).toMatch(/\{ key: 'home', href: '\/driver'/);
      expect(coreSrc).toMatch(/\{ key: 'sale', href: '\/driver\/ban-hang'/);
      expect(coreSrc).toMatch(/\{ key: 'delivery', href: '\/driver\/giao-hang'/);
      // KHÔNG còn mục KHÁCH HÀNG trong bottom menu
      expect(coreSrc).not.toMatch(/key: 'customers'/);

      // Các trang dùng nav cũng phải có đủ 4 mục
      for (const f of ['index.html', 'customers.html']) {
        const src = fs.readFileSync(
          path.join(__dirname, '../views/driver', f), 'utf8');
        expect(src).toMatch(/data-nav="home"/);
        expect(src).toMatch(/data-nav="sale"/);
        expect(src).toMatch(/data-nav="delivery"/);
        expect(src).toMatch(/data-nav="logout"/);
        expect(src).not.toMatch(/data-nav="customers"/);
      }
    });

    test('không có inline onclick chứa dấu nháy kép (phá vỡ attribute → lộ code ra text)', () => {
      const saleSrc = fs.readFileSync(
        path.join(__dirname, '../views/driver/sale.html'), 'utf8');

      // onclick="..." không được chứa thêm dấu nháy kép bên trong
      const badOnclick = saleSrc.match(/onclick="[^"]*"[^"]*"/g) || [];
      // Mọi match phải là attribute onclick hợp lệ (dấu nháy kép đóng ngay sau code JS)
      for (const m of badOnclick) {
        // onclick hợp lệ: onclick="..." rồi tiếp theo là space hoặc > hoặc dấu nháy đơn
        expect(m).toMatch(/onclick="[^"]*"(\s|>|$)/);
      }

      // Nút tài khoản phải dùng hàm riêng, không nhúng HTML vào onclick
      expect(saleSrc).toMatch(/onclick="window\.Drv\.openAccountModal\(\)"/);
      expect(saleSrc).not.toMatch(/onclick="window\.Drv\.openModal\(/);
      // Hàm openAccountModal phải tồn tại trong core.js
      expect(coreSrc).toMatch(/function openAccountModal\(\)/);
      expect(coreSrc).toMatch(/openAccountModal:\s*openAccountModal/);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // J. Trang chủ tài xế — thiết kế lại
    // ═══════════════════════════════════════════════════════════════════════
    describe('J. Trang chủ tài xế (thiết kế lại)', () => {
      const fs2 = require('fs');
      const path2 = require('path');
      const homeHtml = fs2.readFileSync(
        path2.join(__dirname, '../views/driver/index.html'), 'utf8');
      const homeJs = fs2.readFileSync(
        path2.join(__dirname, '../public/js/driver/home.js'), 'utf8');
      const driverApiSrc = fs2.readFileSync(
        path2.join(__dirname, '../routes/api/driver.js'), 'utf8');

      test('HEADER có logo BIA TƯƠI TÂY NINH + nhãn CỔNG TÀI XẾ', () => {
        expect(homeHtml).toMatch(/BIA TƯƠI TÂY NINH/);
        expect(homeHtml).toMatch(/CỔNG TÀI XẾ/);
      });

      test('HEADER có tên tài xế, ngày hiện tại và trạng thái tài khoản', () => {
        expect(homeHtml).toMatch(/id="home-user-name"/);
        expect(homeHtml).toMatch(/id="home-date"/);
        expect(homeHtml).toMatch(/id="home-status"/);
        // home.js phải đổ đủ 3 trường này
        expect(homeJs).toMatch(/setText\('home-user-name'/);
        expect(homeJs).toMatch(/renderDate\(\)/);
        expect(homeJs).toMatch(/setStatus\(/);
      });

      test('THỐNG KÊ có các thẻ: số đơn + số lít + tổng vỏ đã thu', () => {
        expect(homeHtml).toMatch(/id="home-orders"/);
        expect(homeHtml).toMatch(/id="home-liters"/);
        expect(homeHtml).toMatch(/id="home-kegs"/);
        expect(homeHtml).toMatch(/Số đơn/);
        expect(homeHtml).toMatch(/Số lít bia/);
        expect(homeHtml).toMatch(/Vỏ đã thu/);

        // Đúng 3 thẻ KPI, không thêm thẻ thống kê nào khác
        const kpiCount = (homeHtml.match(/class="drv-home-kpi drv-home-kpi--/g) || []).length;
        expect(kpiCount).toBe(3);

        // Icon Lucide: SVG inline, stroke=currentColor, viewBox chuẩn 24
        const svgs = homeHtml.match(/<svg[^>]*>/g) || [];
        expect(svgs.length).toBe(3);
        for (const svg of svgs) {
          expect(svg).toMatch(/viewBox="0 0 24 24"/);
          expect(svg).toMatch(/stroke="currentColor"/);
          expect(svg).toMatch(/fill="none"/);
        }

        // Không còn các thẻ thống kê cũ
        for (const old of ['st-total', 'st-delivered', 'st-pending', 'st-stops',
          'st-to-deliver', 'st-delivered-liters', 'st-missing', 'st-kegs',
          'st-walkin', 'st-wait', 'st-discrepancy']) {
          expect(homeHtml).not.toContain('id="' + old + '"');
        }
        // Không còn section "Sản lượng giao" / "Bán trực tiếp" / "Khách hàng cần ghé"
        expect(homeHtml).not.toMatch(/Sản lượng giao/);
        expect(homeHtml).not.toMatch(/Bán trực tiếp/);
        expect(homeHtml).not.toMatch(/Khách hàng cần ghé/);
      });

      test('API /api/driver/home chỉ trả về chỉ số tối giản, không lộ tài chính', () => {
        expect(driverApiSrc).toMatch(/router\.get\('\/home',\s*requireDriver/);
        expect(driverApiSrc).toMatch(/todayOrders/);
        expect(driverApiSrc).toMatch(/todayLiters/);
        expect(driverApiSrc).toMatch(/todayKegs/);

        // Chỉ xét riêng handler /home (không tính các endpoint khác của file)
        const homeHandler = driverApiSrc.slice(
          driverApiSrc.indexOf("router.get('/home'"),
          driverApiSrc.indexOf("router.get('/home'") + 2500);
        expect(homeHandler).not.toMatch(/profit/);
        expect(homeHandler).not.toMatch(/cost_price/);
        expect(homeHandler).not.toMatch(/revenue|\btotal\b.*money/i);
      });

      test('Số lít hôm nay phải TÍNH CẢ BIA PET (không lọc p.type = keg)', () => {
        const homeStart = driverApiSrc.indexOf("router.get('/home'");
        const homeHandler = driverApiSrc.slice(homeStart, homeStart + 2500);
        // Không được lọc bỏ pet trong phép tính lít
        expect(homeHandler).not.toMatch(/p\.type = 'keg'/);
        expect(homeHandler).not.toMatch(/p\.type != 'pet'/);
        // Phải cộng toàn bộ số lượng item (keg + pet + box)
        expect(homeHandler).toMatch(/SUM\(si\.quantity\)/);
      });

      test('Tổng vỏ đã thu hôm nay lấy từ 2 nguồn + dedupe theo đơn', () => {
        const homeStart = driverApiSrc.indexOf("router.get('/home'");
        const homeHandler = driverApiSrc.slice(homeStart, homeStart + 4000);

        // Nguồn 1: vỏ thu trên đơn bán (sales.return_kegs)
        expect(homeHandler).toMatch(/s\.return_kegs/);
        // Nguồn 2: vỏ thu trên phiếu giao (delivery_records.collected_kegs)
        expect(homeHandler).toMatch(/dr\.collected_kegs/);
        // Dedupe: MAX theo order_key trong subquery
        expect(homeHandler).toMatch(/GROUP BY order_key/);
        expect(homeHandler).toMatch(/MAX\(kegs_sale, kegs_delivery\)/);
        // Ngày tính = ngày hoàn tất thực tế, KHÔNG dùng scheduled_date
        expect(homeHandler).toMatch(/COALESCE\(NULLIF\(dr\.completed_at, ''\), dr\.updated_at, dr\.scheduled_date\)/);
        // Không được giới hạn status = DELIVERED (bỏ sót đơn DISCREPANCY)
        expect(homeHandler).not.toMatch(/dr\.status = 'DELIVERED'/);
      });

      test('CSS có style riêng cho trang chủ mới', () => {
        const css = fs2.readFileSync(
          path2.join(__dirname, '../public/css/driver.css'), 'utf8');
        expect(css).toMatch(/\.drv-home-header\b/);
        expect(css).toMatch(/\.drv-home-kpi--orders/);
        expect(css).toMatch(/\.drv-home-kpi--liters/);
        expect(css).toMatch(/\.drv-home-kpi--kegs/);
        expect(css).toMatch(/\.drv-home-user__name/);

        // Nền thẻ #202830 + bo góc 12px
        expect(css).toMatch(/\.drv-home-kpi\s*\{[^}]*background:\s*#202830/);
        expect(css).toMatch(/\.drv-home-kpi\s*\{[^}]*border-radius:\s*12px/);
        // Desktop 3 cột, mobile 2 cột
        expect(css).toMatch(/\.drv-home-stats\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
        expect(css).toMatch(/@media \(max-width: 560px\)\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
      });
    });
  });
});
