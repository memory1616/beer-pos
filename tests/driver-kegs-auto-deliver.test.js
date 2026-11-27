/**
 * TEST — Auto chuyển "ĐÃ GIAO" khi tài xế thu vỏ (mọi đường ghi vỏ)
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG THỰC TẾ (đơn #1170, 2026-11-27):
 *   Tài xế `giaohang01` thu 91 vỏ cho đơn #1170 lúc 06:17:35 qua
 *   `POST /api/driver/sale/update-kegs` (màn Bán hàng trên iPhone).
 *   Đường này ghi `delivery_records.collected_kegs` bằng RAW SQL →
 *   KHÔNG đi qua `DeliveryService.updateCollectedKegs()` →
 *   auto-transition "PENDING → DELIVERED" KHÔNG chạy →
 *   đơn kẹt ở "Chờ giao" dù đã thu vỏ.
 *
 * → Test này khóa hành vi: MỌI đường ghi `collected_kegs` đều phải tự
 *   chuyển sang ĐÃ GIAO (nếu chưa xác nhận số liệu).
 */
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const db = require('../database');
const DeliveryService = require('../src/services/DeliveryService');

jest.setTimeout(25000);

let seq = 0;
function uniq(prefix) {
  seq += 1;
  return prefix + '_' + Date.now() + '_' + seq;
}

const createdCustomers = [];
const createdSales = [];
const createdDeliveries = [];

function makeCustomer(name, kegBalance) {
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, debt, archived, keg_balance, created_at, updated_at)
       VALUES (?, '', 0, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(name, kegBalance || 0);
  createdCustomers.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function makeSale(customerId, driverUsername, deliverKegs) {
  const info = db
    .prepare(
      `INSERT INTO sales (date, type, customer_id, driver_username, total, profit,
                          deliver_kegs, return_kegs, payment_status, delivery_status,
                          created_at, updated_at)
       VALUES (datetime('now'), 'sale', ?, ?, 1000000, 500000, ?, 0, 'unpaid', 'PENDING',
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(customerId, driverUsername, deliverKegs || 0);
  createdSales.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function makeDelivery(saleId, customerId, driverUsername, expectedKegs) {
  const info = db
    .prepare(
      `INSERT INTO delivery_records (sale_id, customer_id, driver_username, status,
                                     scheduled_date, expected_kegs, collected_kegs,
                                     created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', date('now'), ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(saleId, customerId, driverUsername, expectedKegs);
  createdDeliveries.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

/** App Express với user giả lập (bypass auth middleware). */
function buildApp(role, username) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { username, role };
    next();
  });
  app.use('/api/sales', require('../routes/api/sales'));
  app.use('/api/driver', require('../routes/api/driver'));
  app.use('/api/driver/sale', require('../routes/api/driverSale'));
  return app;
}

afterAll(() => {
  createdDeliveries.forEach((id) => {
    try { db.prepare('DELETE FROM delivery_events WHERE delivery_id = ?').run(id); } catch (_) {}
    try { db.prepare('DELETE FROM driver_cash_collections WHERE delivery_id = ?').run(id); } catch (_) {}
    try { db.prepare('DELETE FROM delivery_records WHERE id = ?').run(id); } catch (_) {}
  });
  createdSales.forEach((id) => {
    try { db.prepare('DELETE FROM sales WHERE id = ?').run(id); } catch (_) {}
  });
  createdCustomers.forEach((id) => {
    try { db.prepare('DELETE FROM customers WHERE id = ?').run(id); } catch (_) {}
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Đường 1: POST /api/sales/update-kegs (màn Bán hàng) — ĐÂY LÀ ĐƯỜNG GÂY BUG
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /api/sales/update-kegs — thu vỏ phải tự chuyển ĐÃ GIAO', () => {
  it('thu vỏ qua màn Bán hàng → đơn chuyển PENDING → DELIVERED', async () => {
    const driver = uniq('__KEGSHTTP_DRV');
    // Khách đang giữ 98 vỏ (đã giao trước) → được thu về tối đa 98 vỏ.
    const customerId = makeCustomer(uniq('__KEGSHTTP_C'), 98);
    const saleId = makeSale(customerId, driver, 0);
    const deliveryId = makeDelivery(saleId, customerId, driver, 98);

    const app = buildApp('DRIVER', driver);

    const res = await request(app)
      .post('/api/sales/update-kegs')
      .send({ saleId, customerId, deliver: 0, returned: 91 });

    expect(res.status).toBe(200);

    // Đơn giao phải chuyển sang ĐÃ GIAO
    const delivery = db
      .prepare('SELECT * FROM delivery_records WHERE id = ?')
      .get(deliveryId);
    expect(delivery.collected_kegs).toBe(91);
    expect(delivery.status).toBe('DELIVERED');
    expect(delivery.completed_at).toBeTruthy();

    // sales.delivery_status cũng phải đồng bộ
    const sale = db
      .prepare('SELECT delivery_status FROM sales WHERE id = ?')
      .get(saleId);
    expect(sale.delivery_status).toBe('DELIVERED');

    // Phải ghi event STATUS_CHANGED để có audit trail
    const evt = db
      .prepare('SELECT * FROM delivery_events WHERE delivery_id = ? ORDER BY id DESC LIMIT 1')
      .get(deliveryId);
    expect(evt.event_type).toBe('STATUS_CHANGED');
    expect(evt.to_status).toBe('DELIVERED');
  });

  it('KHÔNG set confirmed_by → tài xế vẫn sửa được số liệu', async () => {
    const driver = uniq('__KEGSHTTP2_DRV');
    const customerId = makeCustomer(uniq('__KEGSHTTP2_C'), 50);
    const saleId = makeSale(customerId, driver, 0);
    const deliveryId = makeDelivery(saleId, customerId, driver, 50);

    const app = buildApp('DRIVER', driver);

    await request(app)
      .post('/api/sales/update-kegs')
      .send({ saleId, customerId, deliver: 0, returned: 20 });

    const delivery = db
      .prepare('SELECT * FROM delivery_records WHERE id = ?')
      .get(deliveryId);
    expect(delivery.status).toBe('DELIVERED');
    expect(delivery.confirmed_by || '').toBe('');
    expect(delivery.reconciled_at || '').toBe('');
    expect(DeliveryService.hasConfirmedFigures(delivery)).toBe(false);
  });

  it('returned = 0 thì KHÔNG chuyển trạng thái', async () => {
    const driver = uniq('__KEGSHTTP3_DRV');
    const customerId = makeCustomer(uniq('__KEGSHTTP3_C'), 50);
    const saleId = makeSale(customerId, driver, 0);
    const deliveryId = makeDelivery(saleId, customerId, driver, 50);

    const app = buildApp('DRIVER', driver);

    await request(app)
      .post('/api/sales/update-kegs')
      .send({ saleId, customerId, deliver: 0, returned: 0 });

    const delivery = db
      .prepare('SELECT * FROM delivery_records WHERE id = ?')
      .get(deliveryId);
    expect(delivery.status).toBe('PENDING');
  });

  it('phiếu đã xác nhận số liệu → KHÔNG tự chuyển', async () => {
    const driver = uniq('__KEGSHTTP4_DRV');
    const customerId = makeCustomer(uniq('__KEGSHTTP4_C'), 50);
    const saleId = makeSale(customerId, driver, 0);
    const deliveryId = makeDelivery(saleId, customerId, driver, 50);

    db.prepare(
      "UPDATE delivery_records SET status = 'DELIVERED', confirmed_by = ? WHERE id = ?"
    ).run(driver, deliveryId);

    const app = buildApp('DRIVER', driver);

    await request(app)
      .post('/api/sales/update-kegs')
      .send({ saleId, customerId, deliver: 0, returned: 30 });

    const delivery = db
      .prepare('SELECT * FROM delivery_records WHERE id = ?')
      .get(deliveryId);
    // Vẫn DELIVERED, nhưng KHÔNG ghi thêm event STATUS_CHANGED
    expect(delivery.status).toBe('DELIVERED');
    const evt = db
      .prepare("SELECT COUNT(*) c FROM delivery_events WHERE delivery_id = ? AND event_type = 'STATUS_CHANGED'")
      .get(deliveryId);
    expect(evt.c).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Đường 2: POST /api/driver/sale/update-kegs (bản forward của tài xế)
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /api/driver/sale/update-kegs — bản forward của tài xế', () => {
  it('thu vỏ qua forward → đơn chuyển DELIVERED', async () => {
    const driver = uniq('__KEGDRV_DRV');
    const customerId = makeCustomer(uniq('__KEGDRV_C'), 98);
    const saleId = makeSale(customerId, driver, 0);
    const deliveryId = makeDelivery(saleId, customerId, driver, 98);

    const app = buildApp('DRIVER', driver);

    const res = await request(app)
      .post('/api/driver/sale/update-kegs')
      .send({ saleId, customerId, deliver: 0, returned: 91 });

    expect(res.status).toBe(200);

    const delivery = db
      .prepare('SELECT * FROM delivery_records WHERE id = ?')
      .get(deliveryId);
    expect(delivery.collected_kegs).toBe(91);
    expect(delivery.status).toBe('DELIVERED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Đường 3: POST /api/driver/deliveries/:id/kegs (màn Giao hàng)
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /api/driver/deliveries/:id/kegs — màn Giao hàng', () => {
  it('thu vỏ trực tiếp trên phiếu giao → đơn chuyển DELIVERED', async () => {
    const driver = uniq('__KEGDEL_DRV');
    const customerId = makeCustomer(uniq('__KEGDEL_C'));
    const saleId = makeSale(customerId, driver, 98);
    const deliveryId = makeDelivery(saleId, customerId, driver, 98);

    const app = buildApp('DRIVER', driver);

    const res = await request(app)
      .post(`/api/driver/deliveries/${deliveryId}/kegs`)
      .send({ collectedKegs: 91 });

    expect(res.status).toBe(200);

    const delivery = db
      .prepare('SELECT * FROM delivery_records WHERE id = ?')
      .get(deliveryId);
    expect(delivery.collected_kegs).toBe(91);
    expect(delivery.status).toBe('DELIVERED');
  });
});
