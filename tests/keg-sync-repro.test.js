/**
 * Tái hiện lỗi: sửa đơn hàng → số vỏ giao không cập nhật ở admin & trang giao hàng.
 * Chạy trên bản sao DB (DB_PATH).
 */
process.env.NODE_ENV = 'test';
process.env.DB_PATH = process.env.DB_PATH || require('path').join(require('os').tmpdir(), 'beer_test.sqlite');

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

const db = require('../database');
const { hashPassword } = require('../src/utils/password');
const { requireAuth, login } = require('../middleware/auth');
const { apiGuard, attachSanitizer } = require('../middleware/permissions');
const DeliveryService = require('../src/services/DeliveryService');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/driver', requireAuth, require('../routes/api/driver'));
  app.use('/api', requireAuth, apiGuard, attachSanitizer);
  app.use('/api/sales', require('../routes/api/sales'));
  app.use('/api/products', require('../routes/api/products'));
  return app;
}

const ADMIN = 'test_admin_keg';
const DRIVER = 'test_driver_keg';

let app;
let adminToken;
let customerId;
let productId;
let saleId;
let deliveryId;

beforeAll(() => {
  app = buildApp();
  db.prepare(
    `INSERT OR REPLACE INTO app_users (username, password_hash, role, active, full_name)
     VALUES (?, ?, 'ADMIN', 1, 'Admin Test')`
  ).run(ADMIN, hashPassword('AdminPass123'));
  db.prepare(
    `INSERT OR REPLACE INTO app_users (username, password_hash, role, active, full_name)
     VALUES (?, ?, 'DRIVER', 1, 'Driver Test')`
  ).run(DRIVER, hashPassword('DriverPass123'));

  const cust = db.prepare(
    `INSERT INTO customers (name, phone, address, keg_balance, debt, created_at)
     VALUES ('KH TEST KEG', '0900000011', 'Địa chỉ', 0, 0, datetime('now'))`
  ).run();
  customerId = cust.lastInsertRowid;

  const prod = db.prepare(
    `INSERT INTO products (slug, name, stock, cost_price, sell_price, type, archived)
     VALUES ('test_keg_sku', 'Bia Test KEG', 1000, 11000, 21000, 'keg', 0)`
  ).run();
  productId = prod.lastInsertRowid;

  adminToken = login(ADMIN, 'AdminPass123', { driverOnly: false }).token;
});

afterAll(() => {
  try {
    db.prepare('DELETE FROM delivery_record_items WHERE delivery_id = ?').run(deliveryId);
    db.prepare('DELETE FROM delivery_events WHERE delivery_id = ?').run(deliveryId);
    db.prepare('DELETE FROM delivery_records WHERE id = ?').run(deliveryId);
    db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(saleId);
    db.prepare('DELETE FROM sales WHERE id = ?').run(saleId);
    db.prepare('DELETE FROM products WHERE id = ?').run(productId);
    db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
    db.prepare('DELETE FROM app_users WHERE username IN (?, ?)').run(ADMIN, DRIVER);
  } catch (_) {}
});

describe('Sửa đơn → số vỏ giao', () => {
  test('Tạo đơn 10 vỏ + phiếu giao', async () => {
    const res = await request(app)
      .post('/api/sales')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        customerId,
        driverUsername: DRIVER,
        items: [{ productId, quantity: 10, price: 21000 }],
      });
    expect(res.status).toBe(200);
    saleId = res.body.id;
    expect(saleId).toBeTruthy();

    const sale = db.prepare('SELECT deliver_kegs FROM sales WHERE id = ?').get(saleId);
    console.log('Sau khi tạo: deliver_kegs =', sale.deliver_kegs);

    const rec = DeliveryService.ensureRecord(saleId, DRIVER);
    deliveryId = rec.delivery.id;
    const rec2 = db.prepare('SELECT expected_kegs FROM delivery_records WHERE id = ?').get(deliveryId);
    console.log('Phiếu giao: expected_kegs =', rec2.expected_kegs);
  });

  test('Admin sửa đơn 10 → 25', async () => {
    const res = await request(app)
      .put('/api/sales/' + saleId)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        customerId,
        items: [{ productId, quantity: 25, price: 21000 }],
      });
    console.log('PUT status =', res.status, JSON.stringify(res.body).slice(0, 300));
    expect(res.status).toBe(200);
  });

  test('sales.deliver_kegs đã cập nhật?', () => {
    const sale = db.prepare('SELECT deliver_kegs, return_kegs FROM sales WHERE id = ?').get(saleId);
    console.log('>>> sales.deliver_kegs sau khi sửa =', sale.deliver_kegs);
    expect(sale.deliver_kegs).toBe(25);
  });

  test('delivery_records.expected_kegs đã cập nhật?', () => {
    const rec = db.prepare('SELECT expected_kegs, status FROM delivery_records WHERE id = ?').get(deliveryId);
    console.log('>>> delivery_records.expected_kegs =', rec.expected_kegs, 'status =', rec.status);
    expect(rec.expected_kegs).toBe(25);
  });

  test('delivery_record_items.expected_quantity đã cập nhật?', () => {
    const items = db.prepare('SELECT * FROM delivery_record_items WHERE delivery_id = ?').all(deliveryId);
    console.log('>>> items =', JSON.stringify(items.map(i => ({ n: i.product_name, e: i.expected_quantity }))));
    expect(items[0].expected_quantity).toBe(25);
  });

  test('Trang giao hàng (driver) thấy số vỏ mới?', async () => {
    const driverToken = login(DRIVER, 'DriverPass123', { driverOnly: true }).token;
    const res = await request(app)
      .get('/api/driver/delivery/page-data')
      .set('Authorization', 'Bearer ' + driverToken);
    console.log('>>> page-data customers =', JSON.stringify(res.body.customers?.map(c => ({ id: c.id, dk: c.deliver_kegs, l: c.expected_liters }))));
  });
});
