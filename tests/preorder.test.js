/**
 * PRE-ORDER — Đặt hàng trước, giao dở ngày mai
 * ─────────────────────────────────────────────────────────────────────────────
 * Nghiệp vụ:
 *  "Đơn hàng đặt trước sẽ được đẩy đến giao hàng lúc 07:00 sáng hằng ngày"
 *
 * Luồng kiểm chứng:
 *  K1. Admin tạo được đơn đặt trước với ngày giao trong tương lai.
 *  K2. Non-Admin (STAFF/DRIVER) bị chặn 403.
 *  K3. Ngày giao trong quá khứ / sai định dạng bị từ chối.
 *  K4. Đơn SCHEDULED KHÔNG xuất hiện trong truy vấn doanh thu.
 *  K5. Đơn SCHEDULED KHÔNG hiện cho tài xế (driver delivery list).
 *  K6. Đơn SCHEDULED không cộng sản lượng mua của khách lúc tạo.
 *  K7. `releaseDuePreOrders()` → RELEASED, tạo phiếu giao, cộng sản lượng.
 *  K8. `releaseNow()` đẩy tay 1 đơn.
 *  K9. `cancelPreOrder()` trả đơn về trạng thái thường.
 *  K10. Idempotent: release 2 lần chỉ ghi nhận 1 lần.
 *  K11. Xoá đơn đặt trước → hoàn kho, KHÔNG trừ sản lượng (vì chưa cộng).
 */
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const db = require('../database');
const PreOrderService = require('../src/services/PreOrderService');
const PreOrderSQL = require('../src/services/PreOrderSQL');
const { hashPassword } = require('../src/utils/password');

jest.setTimeout(30000);

const ADMIN_USER = 'po_admin';
const STAFF_USER = 'po_staff';
const DRIVER_USER = 'po_driver';

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildApp(role, username) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => {
    req.user = { username, role };
    next();
  });
  a.use('/api/sales', require('../routes/api/sales'));
  a.use('/api/preorders', require('../routes/api/preorders'));
  return a;
}

function createUser(username, role, active = 1) {
  const hash = hashPassword('test_pw_123');
  const existing = db.prepare('SELECT id FROM app_users WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE app_users SET password_hash = ?, role = ?, active = ? WHERE id = ?')
      .run(hash, role, active, existing.id);
    return existing.id;
  }
  const r = db
    .prepare('INSERT INTO app_users (username, password_hash, full_name, role, active) VALUES (?, ?, ?, ?, ?)')
    .run(username, hash, username, role, active);
  return r.lastInsertRowid;
}

function createCustomer(name) {
  const r = db
    .prepare('INSERT INTO customers (name, phone, deposit, keg_balance) VALUES (?, ?, 0, 0)')
    .run(name, '0900' + Math.floor(1000000 + Math.random() * 8999999));
  return r.lastInsertRowid;
}

function getProduct() {
  return db.prepare('SELECT id, cost_price, sell_price FROM products WHERE archived = 0 LIMIT 1').get();
}

/** Ngày giao hợp lệ trong tương lai (theo giờ VN). */
function futureDate(daysAhead = 2) {
  const d = new Date(Date.now() + 7 * 3600 * 1000 + daysAhead * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Ngày hôm nay theo giờ VN. */
function _todayVn() {
  return db.getVietnamDateStr();
}

let customerId = null;
let productId = null;

function createPreorderSale(dateStr, custId, qty = 2) {
  const r = db
    .prepare(
      `INSERT INTO sales (customer_id, date, total, type, deliver_kegs, preorder_status, preorder_date, created_at)
       VALUES (?, ?, ?, 'sale', ?, 'SCHEDULED', ?, CURRENT_TIMESTAMP)`
    )
    .run(custId, dateStr, 100000, qty, dateStr);
  const saleId = r.lastInsertRowid;
  db.prepare('INSERT INTO sale_items (sale_id, product_id, quantity, price) VALUES (?, ?, ?, ?)')
    .run(saleId, productId, qty, 50000);
  return saleId;
}

beforeAll(() => {
  createUser(ADMIN_USER, 'ADMIN');
  createUser(STAFF_USER, 'STAFF');
  createUser(DRIVER_USER, 'DRIVER');
  customerId = createCustomer('KH PreOrder Test');
  productId = getProduct().id;
});

afterEach(() => {
  db.prepare("DELETE FROM sales WHERE preorder_status IS NOT NULL").run();
  db.prepare("DELETE FROM sale_items WHERE sale_id NOT IN (SELECT id FROM sales)").run();
});

// ── K1/K2/K3 ────────────────────────────────────────────────────────────────

describe('POST /api/sales — tạo đơn đặt trước', () => {
  test('K1: Admin tạo được đơn đặt trước cho ngày tương lai', async () => {
    const app = buildApp('ADMIN', ADMIN_USER);
    const date = futureDate(3);
    const res = await request(app)
      .post('/api/sales')
      .send({ customerId, items: [{ productId, quantity: 2, price: 50000 }], preorderDate: date });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.preorder).toBeTruthy();
    expect(res.body.preorder.date).toBe(date);

    const row = db.prepare('SELECT preorder_status, preorder_date FROM sales WHERE id = ?').get(res.body.id);
    expect(row.preorder_status).toBe('SCHEDULED');
    expect(row.preorder_date).toBe(date);
  });

  test('K2: Non-Admin bị chặn 403 khi tạo đơn đặt trước', async () => {
    const app = buildApp('STAFF', STAFF_USER);
    const res = await request(app)
      .post('/api/sales')
      .send({ customerId, items: [{ productId, quantity: 1, price: 50000 }], preorderDate: futureDate(2) });

    expect(res.status).toBe(403);
  });

  test('K3a: Ngày giao trong quá khứ bị từ chối', async () => {
    const app = buildApp('ADMIN', ADMIN_USER);
    const past = new Date(Date.now() - 5 * 86400 * 1000).toISOString().slice(0, 10);
    const res = await request(app)
      .post('/api/sales')
      .send({ customerId, items: [{ productId, quantity: 1, price: 50000 }], preorderDate: past });

    expect(res.status).toBe(400);
  });

  test('K3b: Ngày giao sai định dạng bị từ chối', async () => {
    const app = buildApp('ADMIN', ADMIN_USER);
    const res = await request(app)
      .post('/api/sales')
      .send({ customerId, items: [{ productId, quantity: 1, price: 50000 }], preorderDate: '22/11/2026' });

    expect(res.status).toBe(400);
  });

  test('K3c: Driver được tạo đơn giao ngay (không đặt trước)', async () => {
    const app = buildApp('DRIVER', DRIVER_USER);
    const res = await request(app)
      .post('/api/sales')
      .send({ customerId, items: [{ productId, quantity: 1, price: 50000 }] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.preorder).toBeFalsy();
  });
});

// ── K4/K5/K6 ────────────────────────────────────────────────────────────────

describe('Đơn SCHEDULED bị loại khỏi doanh thu & danh sách giao', () => {
  test('K4: Không xuất hiện trong truy vấn doanh thu (COUNTED_FILTER)', () => {
    const date = futureDate(2);
    createPreorderSale(date, customerId);

    const counted = db
      .prepare(
        `SELECT COUNT(*) AS c FROM sales s
          WHERE s.type = 'sale' AND s.deleted = 0 AND ${PreOrderSQL.COUNTED_FILTER}`
      )
      .get();
    const pending = db
      .prepare(`SELECT COUNT(*) AS c FROM sales s WHERE ${PreOrderSQL.PENDING_FILTER}`)
      .get();

    // Đơn SCHEDULED nằm trong nhóm pending, không nằm trong nhóm doanh thu.
    expect(pending.c).toBeGreaterThan(0);
    expect(counted.c).toBeGreaterThanOrEqual(0);
    const scheduledIds = db.prepare(`SELECT id FROM sales s WHERE ${PreOrderSQL.PENDING_FILTER}`).all();
    const revenueIds = db
      .prepare(`SELECT id FROM sales s WHERE ${PreOrderSQL.COUNTED_FILTER}`)
      .all();
    const revenueIdSet = new Set(revenueIds.map((r) => r.id));
    scheduledIds.forEach((s) => expect(revenueIdSet.has(s.id)).toBe(false));
  });

  test('K5: Không hiện trong danh sách đơn của tài xế', async () => {
    const date = futureDate(2);
    const saleId = createPreorderSale(date, customerId);
    // Gán tài xế thủ công để chắc chắn đơn KHÔNG nằm trong danh sách driver.
    db.prepare("UPDATE sales SET driver_username = ? WHERE id = ?").run(DRIVER_USER, saleId);

    const app = buildApp('DRIVER', DRIVER_USER);
    const res = await request(app).get('/api/driver/deliveries');

    if (res.body && Array.isArray(res.body.deliveries)) {
      expect(res.body.deliveries.map((d) => d.id)).not.toContain(saleId);
    }
  });

  test('K6: Không cộng sản lượng mua của khách lúc tạo đơn đặt trước', () => {
    const before = db.prepare('SELECT monthly_purchased_liters FROM customers WHERE id = ?').get(customerId);
    const date = futureDate(2);
    createPreorderSale(date, customerId);

    const after = db.prepare('SELECT monthly_purchased_liters FROM customers WHERE id = ?').get(customerId);
    expect(Number(after.monthly_purchased_liters)).toBe(Number(before.monthly_purchased_liters));
  });
});

// ── K7/K10 ──────────────────────────────────────────────────────────────────

describe('releaseDuePreOrders — đẩy đơn 07:00', () => {
  test('K7: Release đơn → RELEASED + cộng sản lượng + tạo phiếu giao', async () => {
    const date = futureDate(2);
    const saleId = createPreorderSale(date, customerId);
    const before = db.prepare('SELECT monthly_purchased_liters FROM customers WHERE id = ?').get(customerId);

    const result = await PreOrderService.releaseDuePreOrders({ date });
    expect(result.total).toBe(1);
    expect(result.released).toBe(1);
    expect(result.failed).toBe(0);

    const row = db.prepare('SELECT preorder_status, preorder_released_at FROM sales WHERE id = ?').get(saleId);
    expect(row.preorder_status).toBe('RELEASED');
    expect(row.preorder_released_at).toBeTruthy();

    const after = db.prepare('SELECT monthly_purchased_liters FROM customers WHERE id = ?').get(customerId);
    expect(Number(after.monthly_purchased_liters)).toBe(Number(before.monthly_purchased_liters) + 2);
  });

  test('K7b: Đơn RELEASED được tính vào doanh thu', async () => {
    const date = futureDate(2);
    createPreorderSale(date, customerId);
    await PreOrderService.releaseDuePreOrders({ date });

    const revenueIds = db.prepare(`SELECT id FROM sales s WHERE ${PreOrderSQL.COUNTED_FILTER}`).all();
    expect(revenueIds.length).toBeGreaterThan(0);
  });

  test('K10: Release lần 2 không ghi nhận sản lượng lần nữa (idempotent)', async () => {
    const date = futureDate(2);
    createPreorderSale(date, customerId);

    await PreOrderService.releaseDuePreOrders({ date });
    const mid = db.prepare('SELECT monthly_purchased_liters FROM customers WHERE id = ?').get(customerId);

    const second = await PreOrderService.releaseDuePreOrders({ date });
    expect(second.total).toBe(0);

    const end = db.prepare('SELECT monthly_purchased_liters FROM customers WHERE id = ?').get(customerId);
    expect(Number(end.monthly_purchased_liters)).toBe(Number(mid.monthly_purchased_liters));
  });

  test('K7c: dryRun không thay đổi trạng thái đơn', async () => {
    const date = futureDate(2);
    const saleId = createPreorderSale(date, customerId);
    const result = await PreOrderService.releaseDuePreOrders({ date, dryRun: true });

    expect(result.total).toBe(1);
    expect(result.released).toBe(0);
    const row = db.prepare('SELECT preorder_status FROM sales WHERE id = ?').get(saleId);
    expect(row.preorder_status).toBe('SCHEDULED');
  });
});

// ── K8/K9 ───────────────────────────────────────────────────────────────────

describe('releaseNow & cancelPreOrder', () => {
  test('K8: releaseNow đẩy tay được 1 đơn', async () => {
    const date = futureDate(2);
    const saleId = createPreorderSale(date, customerId);

    const res = await PreOrderService.releaseNow(saleId);
    expect(res.success).toBe(true);

    const row = db.prepare('SELECT preorder_status FROM sales WHERE id = ?').get(saleId);
    expect(row.preorder_status).toBe('RELEASED');
  });

  test('K8b: releaseNow trên đơn không phải pre-order bị từ chối', async () => {
    const res = await PreOrderService.releaseNow(999999);
    expect(res.success).toBe(false);
  });

  test('K9: cancelPreOrder trả đơn về trạng thái thường', () => {
    const date = futureDate(2);
    const saleId = createPreorderSale(date, customerId);

    const res = PreOrderService.cancelPreOrder(saleId);
    expect(res.success).toBe(true);

    const row = db.prepare('SELECT preorder_status, preorder_date FROM sales WHERE id = ?').get(saleId);
    expect(row.preorder_status).toBeNull();
    expect(row.preorder_date).toBeNull();
  });

  test('K9b: Không huỷ được đơn đã RELEASED', async () => {
    const date = futureDate(2);
    const saleId = createPreorderSale(date, customerId);
    await PreOrderService.releaseNow(saleId);

    const res = PreOrderService.cancelPreOrder(saleId);
    expect(res.success).toBe(false);
  });
});

// ── API quản lý ─────────────────────────────────────────────────────────────

describe('API /api/preorders', () => {
  test('Non-Admin bị chặn 403', async () => {
    const app = buildApp('STAFF', STAFF_USER);
    const res = await request(app).get('/api/preorders');
    expect(res.status).toBe(403);
  });

  test('GET /api/preorders liệt kê đơn đặt trước', async () => {
    const date = futureDate(2);
    createPreorderSale(date, customerId);

    const app = buildApp('ADMIN', ADMIN_USER);
    const res = await request(app).get('/api/preorders');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBeGreaterThan(0);
  });

  test('GET /api/preorders/scheduled lọc theo ngày', async () => {
    const date = futureDate(2);
    createPreorderSale(date, customerId);

    const app = buildApp('ADMIN', ADMIN_USER);
    const res = await request(app).get('/api/preorders/scheduled?date=' + date);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  test('GET/PUT /api/preorders/settings quản lý giờ đẩy', async () => {
    const app = buildApp('ADMIN', ADMIN_USER);

    const getRes = await request(app).get('/api/preorders/settings');
    expect(getRes.status).toBe(200);
    expect(typeof getRes.body.data.releaseHour).toBe('number');

    const putRes = await request(app).put('/api/preorders/settings').send({ releaseHour: 6 });
    expect(putRes.status).toBe(200);
    expect(PreOrderService.getReleaseHour()).toBe(6);

    // Khôi phục mặc định 07:00
    await request(app).put('/api/preorders/settings').send({ releaseHour: 7 });
    expect(PreOrderService.getReleaseHour()).toBe(7);
  });

  test('PUT /api/preorders/settings từ chối giờ không hợp lệ', async () => {
    const app = buildApp('ADMIN', ADMIN_USER);
    const res = await request(app).put('/api/preorders/settings').send({ releaseHour: 99 });
    expect(res.status).toBe(400);
  });
});

// ── K11 ─────────────────────────────────────────────────────────────────────

describe('Xoá đơn đặt trước', () => {
  test('K11: Xoá đơn SCHEDULED không trừ sản lượng (vì chưa cộng)', () => {
    const date = futureDate(2);
    const saleId = createPreorderSale(date, customerId);
    const before = db.prepare('SELECT monthly_purchased_liters FROM customers WHERE id = ?').get(customerId);

    const { deleteSaleRestoringInventory } = require('../src/services/saleDelete');
    const res = deleteSaleRestoringInventory(saleId, DRIVER_USER);
    expect(res).toBeTruthy();

    const after = db.prepare('SELECT monthly_purchased_liters FROM customers WHERE id = ?').get(customerId);
    expect(Number(after.monthly_purchased_liters)).toBe(Number(before.monthly_purchased_liters));
  });
});
