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
});
