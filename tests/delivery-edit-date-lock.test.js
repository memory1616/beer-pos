/**
 * KHOÁ SỬA ĐƠN GIAO THEO NGÀY (next_day + backfill_lock + admin_force)
 * ─────────────────────────────────────────────────────────────────────────────
 * VẤN ĐỀ (2026-11-27): "những đơn đã giao, đã thu vỏ qua nhiều ngày nhưng vẫn
 * sửa được" → đơn giao ngày 20/11, đến 27/11 vẫn sửa số liệu vỏ thoải mái.
 *
 * QUY TẮC:
 *   1. `next_day`      — sửa số liệu CHỈ trong ngày giao thực tế.
 *                        Hôm sau → khoá (EDIT_LOCKED_PAST_DAY).
 *   2. `backfill_lock` — phiếu thuộc ngày hôm trước mà BÂY GIỜ mới nhập số
 *                        liệu (backfill) → khoá.
 *   3. `admin_force`   — quản lý vượt khoá được bằng cờ `force: true`
 *                        (có ghi log audit).
 *
 * Bao phủ:
 *   - Helper `getDeliveryActualDate` / `daysSince`.
 *   - `checkDeliveryDateLock` / `canEditConfirmed`.
 *   - API `POST /api/sales/update-kegs` (màn Bán hàng) bị chặn.
 *   - API `POST /api/driver/deliveries/:id/kegs` bị chặn.
 *   - Admin vượt khoá được với `force`.
 */

process.env.NODE_ENV = 'test';

const request = require('supertest');
const db = require('../database');
const { hashPassword } = require('../src/utils/password');
const DeliveryService = require('../src/services/DeliveryService');

jest.setTimeout(20000);

// ── Tạo app Express test ───────────────────────────────────────────────────
function buildApp() {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const { requireAuth } = require('../middleware/auth');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.use('/api/driver', requireAuth, require('../routes/api/driver'));
  app.use('/api/admin', requireAuth, require('../routes/api/admin'));
  app.use('/api/sales', requireAuth, require('../routes/api/sales'));

  return app;
}

let app;

// ── Fixtures ───────────────────────────────────────────────────────────────
const TEST_DRIVER = 'test_lock_driver';
const TEST_ADMIN = 'test_lock_admin';
const PASSWORD = 'LockPass123';

let driverToken;
let adminToken;
let testCustomerId;
let testProductId;

function makeSale(customerId, driverUsername, dateStr) {
  const sale = db
    .prepare(
      `INSERT INTO sales (customer_id, total, type, date, created_on, driver_username, archived, deleted)
       VALUES (?, ?, 'sale', ?, ?, ?, 0, 0)`
    )
    .run(customerId, 100000, dateStr, dateStr, driverUsername);
  const saleId = sale.lastInsertRowid;

  db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, quantity, price)
     VALUES (?, ?, 10, 10000)`
  ).run(saleId, testProductId);

  return saleId;
}

/**
 * Tạo phiếu giao với ngày giao cụ thể (offset ngày so với hôm nay).
 * offsetDays = 0 → hôm nay; -1 → hôm qua; -5 → 5 ngày trước.
 */
function makeDelivery(saleId, customerId, driverUsername, offsetDays = 0, status = 'DELIVERED') {
  const date = new Date(Date.now() + offsetDays * 86400000);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const dateStr = `${y}-${m}-${d}`;

  const rec = db
    .prepare(
      `INSERT INTO delivery_records
         (sale_id, customer_id, driver_username, status, scheduled_date, expected_kegs, completed_at)
       VALUES (?, ?, ?, ?, ?, 10, ?)`
    )
    .run(saleId, customerId, driverUsername, status, dateStr, `${dateStr} 10:00:00`);
  const deliveryId = rec.lastInsertRowid;

  db.prepare(
    `INSERT INTO delivery_record_items
       (delivery_id, product_id, product_name, expected_quantity, delivered_quantity)
     VALUES (?, ?, 'Bia Lock Test', 10, 0)`
  ).run(deliveryId, testProductId);

  return deliveryId;
}

function cleanupAll() {
  try {
    db.prepare(
      `DELETE FROM delivery_record_items WHERE delivery_id IN (
         SELECT id FROM delivery_records WHERE driver_username = ? OR customer_id = ?
       )`
    ).run(TEST_DRIVER, testCustomerId);
    db.prepare(
      `DELETE FROM delivery_events WHERE delivery_id IN (
         SELECT id FROM delivery_records WHERE driver_username = ? OR customer_id = ?
       )`
    ).run(TEST_DRIVER, testCustomerId);
    db.prepare(
      `DELETE FROM delivery_records WHERE driver_username = ? OR customer_id = ?`
    ).run(TEST_DRIVER, testCustomerId);
  } catch (_) { /* best-effort */ }
  try {
    db.prepare(
      `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE customer_id = ?)`
    ).run(testCustomerId);
    db.prepare('DELETE FROM sales WHERE customer_id = ?').run(testCustomerId);
  } catch (_) { /* best-effort */ }
}

beforeAll(() => {
  app = buildApp();

  const hash = hashPassword(PASSWORD);
  db.prepare(
    `INSERT OR REPLACE INTO app_users (username, password_hash, role, active, full_name)
     VALUES (?, ?, 'DRIVER', 1, 'Tài xế Lock Test')`
  ).run(TEST_DRIVER, hash);
  db.prepare(
    `INSERT OR REPLACE INTO app_users (username, password_hash, role, active, full_name)
     VALUES (?, ?, 'ADMIN', 1, 'Admin Lock Test')`
  ).run(TEST_ADMIN, hash);

  const cust = db
    .prepare(
      `INSERT INTO customers (name, phone, address, keg_balance, debt, created_at)
       VALUES ('KHÁCH TEST LOCK', '0900000099', 'Địa chỉ lock', 0, 0, datetime('now'))`
    )
    .run();
  testCustomerId = cust.lastInsertRowid;

  const prod = db
    .prepare(
      `INSERT INTO products (slug, name, stock, cost_price, sell_price, type, archived)
       VALUES ('test_lock_sku', 'Bia Lock Test', 1000, 11000, 20000, 'keg', 0)`
    )
    .run();
  testProductId = prod.lastInsertRowid;

  const { login } = require('../middleware/auth');
  driverToken = login(TEST_DRIVER, PASSWORD, { driverOnly: true })?.token;
  adminToken = login(TEST_ADMIN, PASSWORD)?.token;
  if (!adminToken) throw new Error('Không đăng nhập được ADMIN test');
});

afterAll(() => {
  cleanupAll();
  try {
    db.prepare('DELETE FROM products WHERE id = ?').run(testProductId);
    db.prepare('DELETE FROM customers WHERE id = ?').run(testCustomerId);
    db.prepare('DELETE FROM auth_sessions WHERE username IN (?, ?)').run(TEST_DRIVER, TEST_ADMIN);
    db.prepare('DELETE FROM app_users WHERE username IN (?, ?)').run(TEST_DRIVER, TEST_ADMIN);
  } catch (_) { /* best-effort */ }
});

// ═══════════════════════════════════════════════════════════════════════════
describe('A. Helper ngày giao thực tế', () => {
  test('getDeliveryActualDate ưu tiên completed_at', () => {
    const d = DeliveryService.getDeliveryActualDate({
      completed_at: '2026-11-20 15:30:00',
      scheduled_date: '2026-11-21',
      created_at: '2026-11-19 08:00:00',
    });
    expect(d).toBe('2026-11-20');
  });

  test('getDeliveryActualDate fallback sang scheduled_date', () => {
    const d = DeliveryService.getDeliveryActualDate({
      completed_at: null,
      scheduled_date: '2026-11-21',
      created_at: '2026-11-19 08:00:00',
    });
    expect(d).toBe('2026-11-21');
  });

  test('getDeliveryActualDate fallback sang created_at', () => {
    const d = DeliveryService.getDeliveryActualDate({
      completed_at: '',
      scheduled_date: null,
      created_at: '2026-11-19 08:00:00',
    });
    expect(d).toBe('2026-11-19');
  });

  test('getDeliveryActualDate null khi không có dữ liệu', () => {
    expect(DeliveryService.getDeliveryActualDate(null)).toBeNull();
    expect(DeliveryService.getDeliveryActualDate({})).toBeNull();
  });

  test('daysSince tính đúng số ngày', () => {
    expect(DeliveryService.daysSince('2026-11-20', '2026-11-20')).toBe(0);
    expect(DeliveryService.daysSince('2026-11-20', '2026-11-21')).toBe(1);
    expect(DeliveryService.daysSince('2026-11-20', '2026-11-25')).toBe(5);
    // Ngày trong quá khứ so với "hôm nay" → không âm
    expect(DeliveryService.daysSince('2026-11-20', '2026-11-19')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('B. checkDeliveryDateLock — next_day + backfill_lock', () => {
  test('phiếu giao HÔM NAY → tài xế sửa được', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, db.getVietnamDateStr());
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, 0);

    const res = DeliveryService.checkDeliveryDateLock(
      DeliveryService.getRecordById(deliveryId),
      { username: TEST_DRIVER, role: 'DRIVER' }
    );
    expect(res.allowed).toBe(true);
    expect(res.daysPassed).toBe(0);

    cleanupAll();
  });

  test('phiếu giao HÔM QUA → bị khoá (EDIT_LOCKED_PAST_DAY)', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, db.getVietnamDateStr());
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, -1);

    const res = DeliveryService.checkDeliveryDateLock(
      DeliveryService.getRecordById(deliveryId),
      { username: TEST_DRIVER, role: 'DRIVER' }
    );
    expect(res.allowed).toBe(false);
    expect(res.code).toBe('EDIT_LOCKED_PAST_DAY');
    expect(res.daysPassed).toBe(1);
    expect(res.error).toMatch(/không được sửa/i);

    cleanupAll();
  });

  test('phiếu giao 5 NGÀY TRƯỚC → bị khoá', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, db.getVietnamDateStr());
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, -5);

    const res = DeliveryService.checkDeliveryDateLock(
      DeliveryService.getRecordById(deliveryId),
      { username: TEST_DRIVER, role: 'DRIVER' }
    );
    expect(res.allowed).toBe(false);
    expect(res.code).toBe('EDIT_LOCKED_PAST_DAY');
    expect(res.daysPassed).toBe(5);

    cleanupAll();
  });

  test('BACKFILL: phiếu CHƯA nhập số liệu nhưng thuộc hôm qua → vẫn bị khoá', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, db.getVietnamDateStr());
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, -1, 'PENDING');
    // KHÔNG set confirmed_by / reconciled_at → chưa có số liệu xác nhận.
    const rec = DeliveryService.getRecordById(deliveryId);
    expect(DeliveryService.hasConfirmedFigures(rec)).toBe(false);

    // canEditConfirmed phải chặn VÌ LÝ DO NGÀY (không phải vì đã xác nhận).
    const res = DeliveryService.canEditConfirmed(rec, { username: TEST_DRIVER, role: 'DRIVER' });
    expect(res.allowed).toBe(false);
    expect(res.code).toBe('EDIT_LOCKED_PAST_DAY');

    cleanupAll();
  });

  test('admin_force: quản lý vượt khoá được (có ghi log)', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, db.getVietnamDateStr());
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, -3);

    const rec = DeliveryService.getRecordById(deliveryId);

    // Không force → bị chặn
    const noForce = DeliveryService.checkDeliveryDateLock(rec, { username: TEST_ADMIN, role: 'ADMIN' });
    expect(noForce.allowed).toBe(false);
    expect(noForce.code).toBe('EDIT_LOCKED_PAST_DAY');

    // Có force → được phép
    const withForce = DeliveryService.checkDeliveryDateLock(
      rec,
      { username: TEST_ADMIN, role: 'ADMIN' },
      { force: true }
    );
    expect(withForce.allowed).toBe(true);
    expect(withForce.overridden).toBe(true);

    cleanupAll();
  });

  test('force KHÔNG có tác dụng với tài xế', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, db.getVietnamDateStr());
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, -3);

    const rec = DeliveryService.getRecordById(deliveryId);
    const res = DeliveryService.checkDeliveryDateLock(
      rec,
      { username: TEST_DRIVER, role: 'DRIVER' },
      { force: true }
    );
    expect(res.allowed).toBe(false);
    expect(res.code).toBe('EDIT_LOCKED_PAST_DAY');

    cleanupAll();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('C. Service methods bị khoá theo ngày', () => {
  test('confirmDelivery trên phiếu hôm qua → bị chặn', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, db.getVietnamDateStr());
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, -1);

    const result = DeliveryService.confirmDelivery(deliveryId, TEST_DRIVER, {
      items: [],
      collectedKegs: 8,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('EDIT_LOCKED_PAST_DAY');

    cleanupAll();
  });

  test('updateCollectedKegs trên phiếu hôm qua → bị chặn', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, db.getVietnamDateStr());
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, -1);

    const result = DeliveryService.updateCollectedKegs(deliveryId, TEST_DRIVER, 12, {
      user: { username: TEST_DRIVER, role: 'DRIVER' },
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('EDIT_LOCKED_PAST_DAY');

    cleanupAll();
  });

  test('recordDiscrepancy trên phiếu hôm qua → bị chặn', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, db.getVietnamDateStr());
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, -1);

    const result = DeliveryService.recordDiscrepancy(deliveryId, TEST_DRIVER, { missingLiters: 3 });
    expect(result.success).toBe(false);
    expect(result.code).toBe('EDIT_LOCKED_PAST_DAY');

    cleanupAll();
  });

  test('updateStatus trên phiếu hôm qua → bị chặn', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, db.getVietnamDateStr());
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, -1);

    const result = DeliveryService.updateStatus(deliveryId, 'DISCREPANCY', TEST_DRIVER, {
      user: { username: TEST_DRIVER, role: 'DRIVER' },
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('EDIT_LOCKED_PAST_DAY');

    cleanupAll();
  });

  test('phiếu HÔM NAY vẫn xác nhận giao bình thường', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, db.getVietnamDateStr());
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, 0, 'PENDING');

    const result = DeliveryService.confirmDelivery(deliveryId, TEST_DRIVER, {
      items: [],
      collectedKegs: 6,
    });
    expect(result.success).toBe(true);

    cleanupAll();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('D. API — khoá theo ngày', () => {
  test('POST /api/sales/update-kegs trên đơn giao hôm qua → 403', async () => {
    const saleDate = db.getVietnamDateStr();
    const saleId = makeSale(testCustomerId, TEST_DRIVER, saleDate);
    makeDelivery(saleId, testCustomerId, TEST_DRIVER, -1);

    const res = await request(app)
      .post('/api/sales/update-kegs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ saleId, customerId: testCustomerId, deliver: 10, returned: 5 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EDIT_LOCKED_PAST_DAY');
    expect(res.body.daysPassed).toBe(1);

    // Số liệu KHÔNG bị đổi
    const sale = db.prepare('SELECT return_kegs FROM sales WHERE id = ?').get(saleId);
    expect(sale.return_kegs || 0).toBe(0);

    cleanupAll();
  });

  test('POST /api/sales/update-kegs trên đơn giao HÔM NAY → 200', async () => {
    const saleDate = db.getVietnamDateStr();
    const saleId = makeSale(testCustomerId, TEST_DRIVER, saleDate);
    makeDelivery(saleId, testCustomerId, TEST_DRIVER, 0);

    const res = await request(app)
      .post('/api/sales/update-kegs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ saleId, customerId: testCustomerId, deliver: 10, returned: 5 });

    expect(res.status).toBe(200);

    cleanupAll();
  });

  test('POST /api/sales/update-kegs với force=true (quản lý) → 200', async () => {
    const saleDate = db.getVietnamDateStr();
    const saleId = makeSale(testCustomerId, TEST_DRIVER, saleDate);
    makeDelivery(saleId, testCustomerId, TEST_DRIVER, -2);

    const res = await request(app)
      .post('/api/sales/update-kegs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ saleId, customerId: testCustomerId, deliver: 10, returned: 5, force: true });

    expect(res.status).toBe(200);

    cleanupAll();
  });

  test('POST /api/driver/deliveries/:id/kegs trên phiếu hôm qua → 403', async () => {
    const saleDate = db.getVietnamDateStr();
    const saleId = makeSale(testCustomerId, TEST_DRIVER, saleDate);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, -1);

    const res = await request(app)
      .post(`/api/driver/deliveries/${deliveryId}/kegs`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ collectedKegs: 9 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EDIT_LOCKED_PAST_DAY');

    cleanupAll();
  });

  test('PUT /api/admin/deliveries/:id/confirm (force) trên phiếu hôm qua → 200', async () => {
    const saleDate = db.getVietnamDateStr();
    const saleId = makeSale(testCustomerId, TEST_DRIVER, saleDate);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, -1);

    const res = await request(app)
      .put(`/api/admin/deliveries/${deliveryId}/confirm`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [], collectedKegs: 7 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    cleanupAll();
  });

  test('PUT /api/sales/:id (sửa đơn) trên đơn giao hôm qua → 403', async () => {
    const saleDate = db.getVietnamDateStr();
    const saleId = makeSale(testCustomerId, TEST_DRIVER, saleDate);
    makeDelivery(saleId, testCustomerId, TEST_DRIVER, -1);

    const res = await request(app)
      .put(`/api/sales/${saleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customerId: testCustomerId,
        items: [{ productId: testProductId, quantity: 5, price: 10000 }],
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EDIT_LOCKED_PAST_DAY');

    cleanupAll();
  });

  test('PUT /api/sales/:id với force=true → 200', async () => {
    const saleDate = db.getVietnamDateStr();
    const saleId = makeSale(testCustomerId, TEST_DRIVER, saleDate);
    makeDelivery(saleId, testCustomerId, TEST_DRIVER, -1);

    const res = await request(app)
      .put(`/api/sales/${saleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customerId: testCustomerId,
        force: true,
        items: [{ productId: testProductId, quantity: 5, price: 10000 }],
      });

    expect(res.status).toBe(200);

    cleanupAll();
  });
});
