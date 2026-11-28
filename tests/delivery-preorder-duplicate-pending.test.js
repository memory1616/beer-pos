/**
 * SỬA 3 VẤN ĐỀ (2026-11-28)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. ĐƠN ĐẶT TRƯỚC: `delivery_records.scheduled_date` phải = ngày GIAO
 *    (`preorder_date`), không phải ngày LẬP ĐƠN (`created_on`).
 *    Sự cố thật: đơn đặt trước giao 28/11 nhưng phiếu giao ghi 27/11.
 *
 * 2. CHẶN ĐƠN TRÙNG: 1 khách / 1 ngày giao = 1 đơn.
 *    Sự cố thật: 3 đơn đặt trước bị xoá nhầm rồi tạo lại đơn thường cùng
 *    khách cùng ngày → tài xế phải giao 2 lần cho 1 khách.
 *
 * 3. ĐƠN ĐÃ DELIVERED → không còn hiện "cần giao".
 *    Sự cố thật: đơn #1180 (Pino, 25 đen + 10 vàng) đã giao lúc 16:10 nhưng
 *    `confirmed_by` rỗng (tài xế bấm nhanh "Xong") → vẫn hiện trong danh
 *    sách "HÀNG CẦN GIAO HÔM NAY".
 */

process.env.NODE_ENV = 'test';

const request = require('supertest');
const db = require('../database');
const { hashPassword } = require('../src/utils/password');
const DeliveryService = require('../src/services/DeliveryService');
const DuplicateSaleCheck = require('../src/services/DuplicateSaleCheck');

jest.setTimeout(20000);

// ── App Express test ──────────────────────────────────────────────────────
function buildApp() {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const { requireAuth } = require('../middleware/auth');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.use('/api/driver', requireAuth, require('../routes/api/driver'));
  app.use('/api/sales', requireAuth, require('../routes/api/sales'));

  return app;
}

let app;

const TEST_DRIVER = 'test_fix3_driver';
const TEST_ADMIN = 'test_fix3_admin';
const PASSWORD = 'Fix3Pass123';

let driverToken;
let adminToken;
let testCustomerId;
let testProductId;

function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeSale(customerId, driverUsername, opts = {}) {
  const dateStr = opts.date || today();
  const createdOn = opts.createdOn || dateStr;
  const sale = db
    .prepare(
      `INSERT INTO sales
         (customer_id, total, type, date, created_on, sale_time, driver_username,
          archived, deleted, preorder_status, preorder_date)
       VALUES (?, ?, 'sale', ?, ?, ?, ?, 0, 0, ?, ?)`
    )
    .run(
      customerId,
      100000,
      dateStr,
      createdOn,
      opts.saleTime || '10:00:00',
      driverUsername,
      opts.preorderStatus || null,
      opts.preorderDate || null
    );
  const saleId = sale.lastInsertRowid;

  db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, quantity, price)
     VALUES (?, ?, 10, 10000)`
  ).run(saleId, testProductId);

  return saleId;
}

function cleanupAll() {
  try {
    db.prepare(
      `DELETE FROM delivery_record_items WHERE delivery_id IN (
         SELECT id FROM delivery_records WHERE customer_id = ?
       )`
    ).run(testCustomerId);
    db.prepare(
      `DELETE FROM delivery_events WHERE delivery_id IN (
         SELECT id FROM delivery_records WHERE customer_id = ?
       )`
    ).run(testCustomerId);
    db.prepare('DELETE FROM delivery_records WHERE customer_id = ?').run(testCustomerId);
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
     VALUES (?, ?, 'DRIVER', 1, 'Tài xế Fix3')`
  ).run(TEST_DRIVER, hash);
  db.prepare(
    `INSERT OR REPLACE INTO app_users (username, password_hash, role, active, full_name)
     VALUES (?, ?, 'ADMIN', 1, 'Admin Fix3')`
  ).run(TEST_ADMIN, hash);

  const cust = db
    .prepare(
      `INSERT INTO customers (name, phone, address, keg_balance, debt, created_at)
       VALUES ('KHÁCH TEST FIX3', '0900000088', 'Địa chỉ fix3', 0, 0, datetime('now'))`
    )
    .run();
  testCustomerId = cust.lastInsertRowid;

  const prod = db
    .prepare(
      `INSERT INTO products (slug, name, stock, cost_price, sell_price, type, archived)
       VALUES ('test_fix3_sku', 'Bia Fix3 Test', 1000, 11000, 20000, 'keg', 0)`
    )
    .run();
  testProductId = prod.lastInsertRowid;

  const { login } = require('../middleware/auth');
  driverToken = login(TEST_DRIVER, PASSWORD, { driverOnly: true })?.token;
  adminToken = login(TEST_ADMIN, PASSWORD)?.token;
  if (!adminToken) throw new Error('Không đăng nhập được ADMIN test');
});

afterEach(() => {
  cleanupAll();
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
describe('1. Đơn đặt trước — scheduled_date = ngày GIAO', () => {
  test('đơn đặt trước RELEASED → scheduled_date = preorder_date (KHÔNG phải created_on)', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, {
      date: today(1),
      createdOn: today(0),
      preorderStatus: 'RELEASED',
      preorderDate: today(1),
    });

    const res = DeliveryService.ensureRecord(saleId, TEST_DRIVER);
    expect(res.success).toBe(true);
    expect(res.created).toBe(true);

    const rec = db
      .prepare('SELECT scheduled_date FROM delivery_records WHERE sale_id = ?')
      .get(saleId);
    // Ngày GIAO (preorder_date) — KHÔNG phải ngày lập đơn.
    expect(rec.scheduled_date).toBe(today(1));
  });

  test('đơn thường → scheduled_date = created_on (giữ nguyên hành vi cũ)', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, {
      date: today(0),
      createdOn: today(0),
    });

    DeliveryService.ensureRecord(saleId, TEST_DRIVER);

    const rec = db
      .prepare('SELECT scheduled_date FROM delivery_records WHERE sale_id = ?')
      .get(saleId);
    expect(rec.scheduled_date).toBe(today(0));
  });

  test('đơn đặt trước CHƯA release (SCHEDULED) → dùng created_on', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, {
      date: today(1),
      createdOn: today(0),
      preorderStatus: 'SCHEDULED',
      preorderDate: today(1),
    });

    DeliveryService.ensureRecord(saleId, TEST_DRIVER);

    const rec = db
      .prepare('SELECT scheduled_date FROM delivery_records WHERE sale_id = ?')
      .get(saleId);
    expect(rec.scheduled_date).toBe(today(0));
  });

  test('getScheduledDateForSale — ưu tiên preorder_date khi RELEASED', () => {
    expect(
      DeliveryService.getScheduledDateForSale({
        preorder_status: 'RELEASED',
        preorder_date: '2026-11-28',
        created_on: '2026-11-27',
        date: '2026-11-28',
      })
    ).toBe('2026-11-28');
  });

  test('getScheduledDateForSale — đơn thường dùng created_on', () => {
    expect(
      DeliveryService.getScheduledDateForSale({
        preorder_status: null,
        created_on: '2026-11-27',
        date: '2026-11-28',
      })
    ).toBe('2026-11-27');
  });

  test('đơn đặt trước giao hôm nay → scheduled_date = hôm nay (khoá sửa đúng ngày)', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, {
      date: today(0),
      createdOn: today(-1),
      preorderStatus: 'RELEASED',
      preorderDate: today(0),
    });

    DeliveryService.ensureRecord(saleId, TEST_DRIVER);

    const rec = db
      .prepare('SELECT * FROM delivery_records WHERE sale_id = ?')
      .get(saleId);
    // Ngày giao = hôm nay → khoá sửa KHÔNG kích hoạt.
    const check = DeliveryService.canEditConfirmed(rec, { username: TEST_DRIVER, role: 'DRIVER' });
    expect(check.allowed).toBe(true);
    expect(check.code).not.toBe('EDIT_LOCKED_PAST_DAY');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('2. Chặn đơn trùng — 1 khách / 1 ngày giao = 1 đơn', () => {
  test('getSaleDeliveryDate — đơn đặt trước dùng preorder_date', () => {
    expect(
      DuplicateSaleCheck.getSaleDeliveryDate({
        preorder_status: 'RELEASED',
        preorder_date: '2026-11-28',
        created_on: '2026-11-27',
      })
    ).toBe('2026-11-28');
  });

  test('getSaleDeliveryDate — đơn thường dùng created_on', () => {
    expect(
      DuplicateSaleCheck.getSaleDeliveryDate({
        preorder_status: null,
        created_on: '2026-11-28',
        date: '2026-11-28',
      })
    ).toBe('2026-11-28');
  });

  test('isRewardSale — nhận diện đơn trả thưởng', () => {
    expect(DuplicateSaleCheck.isRewardSale({ promo_type: 'MONTHLY_BONUS' })).toBe(true);
    expect(DuplicateSaleCheck.isRewardSale({ promo_type: 'NEW_SHOP_BONUS' })).toBe(true);
    expect(DuplicateSaleCheck.isRewardSale({ reward_liters_used: 5 })).toBe(true);
    expect(DuplicateSaleCheck.isRewardSale({ promo_type: null, reward_liters_used: 0 })).toBe(false);
    expect(DuplicateSaleCheck.isRewardSale(null)).toBe(false);
  });

  test('checkDuplicateSale — phát hiện đơn thường trùng trong ngày', () => {
    makeSale(testCustomerId, TEST_DRIVER, { date: today(0), createdOn: today(0) });

    const res = DuplicateSaleCheck.checkDuplicateSale({
      customerId: testCustomerId,
      deliveryDate: today(0),
    });
    expect(res.duplicate).toBe(true);
    expect(res.code).toBe('DUPLICATE_SAME_DAY_SALE');
    expect(res.sale).toBeTruthy();
  });

  test('checkDuplicateSale — phát hiện đơn ĐẶT TRƯỚC trùng với đơn thường', () => {
    // Đơn đặt trước giao NGÀY MAI.
    makeSale(testCustomerId, TEST_DRIVER, {
      date: today(1),
      createdOn: today(0),
      preorderStatus: 'RELEASED',
      preorderDate: today(1),
    });

    // Đơn thường tạo HÔM NAY cho cùng khách, cùng ngày giao mai.
    const res = DuplicateSaleCheck.checkDuplicateSale({
      customerId: testCustomerId,
      deliveryDate: today(1),
    });
    expect(res.duplicate).toBe(true);
  });

  test('checkDuplicateSale — KHÔNG trùng nếu khác ngày giao', () => {
    makeSale(testCustomerId, TEST_DRIVER, { date: today(0), createdOn: today(0) });

    const res = DuplicateSaleCheck.checkDuplicateSale({
      customerId: testCustomerId,
      deliveryDate: today(1),
    });
    expect(res.duplicate).toBe(false);
  });

  test('checkDuplicateSale — đơn trả thưởng KHÔNG bị tính là trùng', () => {
    makeSale(testCustomerId, TEST_DRIVER, { date: today(0), createdOn: today(0) });
    // Đơn trả thưởng 0đ cùng ngày.
    db.prepare(
      `INSERT INTO sales (customer_id, total, type, date, created_on, promo_type, archived, deleted)
       VALUES (?, 0, 'sale', ?, ?, 'MONTHLY_BONUS', 0, 0)`
    ).run(testCustomerId, today(0), today(0));

    // Khách đã có đơn thường + đơn thưởng → vẫn trùng (đơn thường là đơn bán hàng).
    const res = DuplicateSaleCheck.checkDuplicateSale({
      customerId: testCustomerId,
      deliveryDate: today(0),
    });
    expect(res.duplicate).toBe(true);
  });

  test('checkDuplicateSale — force = true vượt khoá', () => {
    makeSale(testCustomerId, TEST_DRIVER, { date: today(0), createdOn: today(0) });

    const res = DuplicateSaleCheck.checkDuplicateSale({
      customerId: testCustomerId,
      deliveryDate: today(0),
      force: true,
      actor: TEST_ADMIN,
    });
    expect(res.duplicate).toBe(false);
    expect(res.force).toBe(true);
  });

  test('API POST /api/sales — chặn tạo đơn trùng (409)', async () => {
    makeSale(testCustomerId, TEST_DRIVER, { date: today(0), createdOn: today(0) });

    const res = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customerId: testCustomerId,
        items: [{ productId: testProductId, quantity: 5 }],
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_SAME_DAY_SALE');
    expect(res.body.duplicateSaleId).toBeTruthy();
  });

  test('API POST /api/sales — force = true tạo được đơn trùng', async () => {
    makeSale(testCustomerId, TEST_DRIVER, { date: today(0), createdOn: today(0) });

    const res = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customerId: testCustomerId,
        items: [{ productId: testProductId, quantity: 5 }],
        force: true,
      });

    expect(res.status).toBe(200);
  });

  test('API POST /api/sales — khác ngày giao → tạo bình thường', async () => {
    const res = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customerId: testCustomerId,
        items: [{ productId: testProductId, quantity: 5 }],
      });

    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('3. Đơn đã DELIVERED → không còn hiện "cần giao"', () => {
  test('phiếu DELIVERED dù chưa confirmed_by → KHÔNG xuất hiện trong danh sách cần giao', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, { date: today(0), createdOn: today(0) });

    const deliveryId = db
      .prepare(
        `INSERT INTO delivery_records
           (sale_id, customer_id, driver_username, status, scheduled_date,
            expected_kegs, collected_kegs, completed_at)
         VALUES (?, ?, ?, 'DELIVERED', ?, 35, 94, ?)`
      )
      .run(saleId, testCustomerId, TEST_DRIVER, today(0), `${today(0)} 16:10:16`).lastInsertRowid;

    // KHÔNG set confirmed_by / reconciled_at (đúng sự cố thật 28/11).
    const rec = db.prepare('SELECT * FROM delivery_records WHERE id = ?').get(deliveryId);
    expect(DeliveryService.hasConfirmedFigures(rec)).toBe(false);

    const rows = DeliveryService.listForDriver(TEST_DRIVER, { date: today(0) });
    const ids = rows.map((r) => r.sale_id || r.id);
    expect(ids).not.toContain(saleId);
  });

  test('phiếu CHƯA DELIVERED (PENDING) → vẫn xuất hiện', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, { date: today(0), createdOn: today(0) });

    db.prepare(
      `INSERT INTO delivery_records
         (sale_id, customer_id, driver_username, status, scheduled_date, expected_kegs)
       VALUES (?, ?, ?, 'PENDING', ?, 35)`
    ).run(saleId, testCustomerId, TEST_DRIVER, today(0));

    const rows = DeliveryService.listForDriver(TEST_DRIVER, { date: today(0) });
    const ids = rows.map((r) => r.sale_id || r.id);
    expect(ids).toContain(saleId);
  });

  test('phiếu FAILED → vẫn xuất hiện (cần giao lại)', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, { date: today(0), createdOn: today(0) });

    db.prepare(
      `INSERT INTO delivery_records
         (sale_id, customer_id, driver_username, status, scheduled_date, expected_kegs)
       VALUES (?, ?, ?, 'FAILED', ?, 35)`
    ).run(saleId, testCustomerId, TEST_DRIVER, today(0));

    const rows = DeliveryService.listForDriver(TEST_DRIVER, { date: today(0) });
    const ids = rows.map((r) => r.sale_id || r.id);
    expect(ids).toContain(saleId);
  });

  test('đơn CHƯA có phiếu giao → vẫn xuất hiện', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER, { date: today(0), createdOn: today(0) });

    const rows = DeliveryService.listForDriver(TEST_DRIVER, { date: today(0) });
    const ids = rows.map((r) => r.sale_id || r.id);
    expect(ids).toContain(saleId);
  });
});
