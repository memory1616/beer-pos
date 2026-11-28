/**
 * AUTO-DISPATCH — Tự động điều phố đơn về tài xế phụ trách khu vực
 * ─────────────────────────────────────────────────────────────────────────────
 * Yêu cầu nghiệp vụ:
 *   "Đơn sẽ được tự động điều phố về khu vực của tài xế quản lý"
 *
 * Luồng kiểm chứng:
 *  K1. Tài xế phụ trách khu vực R; khách hàng C thuộc R.
 *      → Tạo đơn cho C → đơn TỰ ĐỘNG gán cho tài xế của R.
 *  K2. Admin chỉ định tài xế tay → giữ nguyên lựa chọn (ghi đè).
 *  K3. Khu vực chưa có tài xế → đơn KHÔNG gán → chờ điều phố của Admin.
 *  K4. Khách chưa có khu vực → đơn KHÔNG gán → chờ điều phố.
 *  K5. Snapshot khu vực được lưu đúng trên đơn (region_id/name/driver).
 *  K6. Tài xế bị khoá → không tự gán.
 *  K7. Đơn LAN sync cũng được tự điều phố.
 *  K8. Đơn đổi bia lỗi cũng được tự điều phố.
 *  K9. Tài xế tạo đơn cho khách của khu vực MÌNH → gán chính mình.
 *  K10. Đơn tự điều phố xuất hiện ở Driver Portal của tài xế nhận.
 */
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const db = require('../database');
const { hashPassword } = require('../src/utils/password');
const RegionService = require('../src/services/RegionService');
const migration058 = require('../database/migrations/058_business_regions');

jest.setTimeout(30000);

const ADMIN_USER = 'ad_admin';
const DRIVER_A = 'ad_driver_a';
const DRIVER_B = 'ad_driver_b';

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildApp(role, username) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => {
    req.user = { username, role };
    next();
  });
  a.use('/api/sales', require('../routes/api/sales'));
  a.use('/api/driver', require('../routes/api/driver'));
  a.use('/api/driver/sale', require('../routes/api/driverSale'));
  return a;
}

function createUser(username, role, active = 1) {
  const hash = hashPassword('test_pw_123');
  const existing = db.prepare('SELECT id FROM app_users WHERE username = ?').get(username);
  if (existing) {
    db
      .prepare('UPDATE app_users SET password_hash = ?, role = ?, active = ? WHERE id = ?')
      .run(hash, role, active, existing.id);
    return existing.id;
  }
  const r = db
    .prepare(
      "INSERT INTO app_users (username, password_hash, full_name, role, active) VALUES (?, ?, ?, ?, ?)"
    )
    .run(username, hash, username, role, active);
  return r.lastInsertRowid;
}

function createCustomer(name, regionId) {
  const r = db
    .prepare('INSERT INTO customers (name, phone, region_id, deposit, keg_balance) VALUES (?, ?, ?, 0, 0)')
    .run(name, '0900' + Math.floor(1000000 + Math.random() * 8999999), regionId);
  return r.lastInsertRowid;
}

function getProduct() {
  return db.prepare("SELECT id, cost_price, sell_price FROM products WHERE archived = 0 LIMIT 1").get();
}

function cleanup() {
  try {
    db.prepare(
      `DELETE FROM delivery_records WHERE sale_id IN
        (SELECT id FROM sales WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE ?))`
    ).run('AD_TEST_%');
    db.prepare(
      `DELETE FROM sale_items WHERE sale_id IN
        (SELECT id FROM sales WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE ?))`
    ).run('AD_TEST_%');
    db.prepare(
      `DELETE FROM sales WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE ?)`
    ).run('AD_TEST_%');
    db.prepare('DELETE FROM customers WHERE name LIKE ?').run('AD_TEST_%');
    db.prepare('DELETE FROM region_driver_assignments WHERE driver_username IN (?, ?)').run(
      DRIVER_A,
      DRIVER_B
    );
    db.prepare('DELETE FROM region_assignment_history WHERE driver_username IN (?, ?)').run(
      DRIVER_A,
      DRIVER_B
    );
    db.prepare('DELETE FROM app_users WHERE username IN (?, ?)').run(DRIVER_A, DRIVER_B);
  } catch (_) {
    /* ignore */
  }
}

let adminApp;
let driverAApp;
const regionIds = {};

beforeAll(() => {
  migration058.up(db);
  createUser(ADMIN_USER, 'ADMIN');
  createUser(DRIVER_A, 'DRIVER');
  createUser(DRIVER_B, 'DRIVER');

  adminApp = buildApp('ADMIN', ADMIN_USER);
  driverAApp = buildApp('DRIVER', DRIVER_A);

  db.prepare('SELECT id, code FROM business_regions WHERE active = 1').all().forEach((r) => {
    regionIds[r.code] = r.id;
  });
});

afterAll(() => {
  cleanup();
  try {
    db.prepare('DELETE FROM app_users WHERE username = ?').run(ADMIN_USER);
    db.close();
  } catch (_) {
    /* ignore */
  }
});

beforeEach(() => {
  cleanup();
  createUser(DRIVER_A, 'DRIVER');
  createUser(DRIVER_B, 'DRIVER');
});

// ═══════════════════════════════════════════════════════════════════════════
// K. TỰ ĐỘNG ĐIỀU PHỐ THEO KHU VỰC
// ═══════════════════════════════════════════════════════════════════════════
describe('K. Đơn tự động điều phố về tài xế phụ trách khu vực', () => {
  let custInA;
  let prod;

  beforeEach(() => {
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });
    custInA = createCustomer('AD_TEST_KhachA', regionIds.HOA_THANH);
    prod = getProduct();
  });

  test('K1. Admin tạo đơn → tự động gán tài xế phụ trách khu vực', async () => {
    const res = await request(adminApp)
      .post('/api/sales')
      .send({
        customerId: custInA,
        items: [{ productId: prod.id, quantity: 1, price: prod.sell_price }],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(res.body.id);
    expect(sale.driver_username).toBe(DRIVER_A);
  });

  test('K2. Admin chỉ định tài xế tay → giữ nguyên (ghi đè tự động)', async () => {
    const res = await request(adminApp)
      .post('/api/sales')
      .send({
        customerId: custInA,
        items: [{ productId: prod.id, quantity: 1, price: prod.sell_price }],
        driverUsername: DRIVER_B,
      });

    expect(res.status).toBe(200);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(res.body.id);
    expect(sale.driver_username).toBe(DRIVER_B);
  });

  test('K3. Khu vực chưa có tài xế → đơn KHÔNG gán (chờ điều phố Admin)', async () => {
    const custNoDriver = createCustomer('AD_TEST_NoDriver', regionIds.TAN_BIEN);

    const res = await request(adminApp)
      .post('/api/sales')
      .send({
        customerId: custNoDriver,
        items: [{ productId: prod.id, quantity: 1, price: prod.sell_price }],
      });

    expect(res.status).toBe(200);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(res.body.id);
    expect(sale.driver_username).toBeNull();

    // Đơn phải xuất hiện trong hàng đợi chờ điều phố của Admin.
    const unassigned = RegionService.listUnassignedSales({ limit: 500 });
    expect(unassigned.map((s) => s.id)).toContain(res.body.id);
  });

  test('K4. Khách chưa có khu vực → đơn KHÔNG gán', async () => {
    const custLegacy = createCustomer('AD_TEST_Legacy', null);

    const res = await request(adminApp)
      .post('/api/sales')
      .send({
        customerId: custLegacy,
        items: [{ productId: prod.id, quantity: 1, price: prod.sell_price }],
      });

    expect(res.status).toBe(200);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(res.body.id);
    expect(sale.driver_username).toBeNull();
    expect(sale.region_id).toBeNull();
  });

  test('K5. Snapshot khu vực được lưu đúng trên đơn', async () => {
    const res = await request(adminApp)
      .post('/api/sales')
      .send({
        customerId: custInA,
        items: [{ productId: prod.id, quantity: 1, price: prod.sell_price }],
      });

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(res.body.id);
    expect(sale.region_id).toBe(regionIds.HOA_THANH);
    expect(sale.region_name).toBe('Hòa Thành');
    expect(sale.region_driver_username).toBe(DRIVER_A);
  });

  test('K6. Tài xế phụ trách bị khoá → không tự gán', async () => {
    db.prepare('UPDATE app_users SET active = 0 WHERE username = ?').run(DRIVER_A);

    const res = await request(adminApp)
      .post('/api/sales')
      .send({
        customerId: custInA,
        items: [{ productId: prod.id, quantity: 1, price: prod.sell_price }],
      });

    expect(res.status).toBe(200);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(res.body.id);
    expect(sale.driver_username).toBeNull();
    // Vẫn snapshot khu vực để Admin biết đơn thuộc khu vực nào.
    expect(sale.region_id).toBe(regionIds.HOA_THANH);
  });

  test('K9. Tài xế tạo đơn cho khách của khu vực MÌNH → gán chính mình', async () => {
    const res = await request(driverAApp)
      .post('/api/sales')
      .send({
        customerId: custInA,
        items: [{ productId: prod.id, quantity: 1, price: prod.sell_price }],
      });

    expect(res.status).toBe(200);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(res.body.id);
    expect(sale.driver_username).toBe(DRIVER_A);
  });

  test('K10. Đơn tự điều phố xuất hiện ở Driver Portal của tài xế nhận', async () => {
    const res = await request(adminApp)
      .post('/api/sales')
      .send({
        customerId: custInA,
        items: [{ productId: prod.id, quantity: 1, price: prod.sell_price }],
      });

    const drv = await request(driverAApp).get('/api/driver/deliveries');
    expect(drv.status).toBe(200);
    const ids = drv.body.deliveries.map((d) => d.sale_id);
    expect(ids).toContain(res.body.id);

    const row = drv.body.deliveries.find((d) => d.sale_id === res.body.id);
    expect(row.region_id).toBe(regionIds.HOA_THANH);
    expect(row.region_name).toBe('Hòa Thành');
  });

  test('K11. Đổi phân công → đơn MỚI về tài xế mới, đơn CŨ giữ lịch sử', async () => {
    // Tạo đơn khi A còn phụ trách.
    const first = await request(adminApp)
      .post('/api/sales')
      .send({
        customerId: custInA,
        items: [{ productId: prod.id, quantity: 1, price: prod.sell_price }],
      });
    expect(db.prepare('SELECT driver_username FROM sales WHERE id = ?').get(first.body.id).driver_username).toBe(DRIVER_A);

    // Chuyển khu vực sang tài xế B (xác nhận thu hồi khu vực của A).
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_B, {
      actor: ADMIN_USER,
      confirmTakeover: true,
    });

    // Đơn MỚI → về B.
    // force: true — khách đã có 1 đơn trong ngày (quy tắc 1 khách / 1 ngày
    // giao = 1 đơn). Test này kiểm tra ĐIỀU PHỐ, không kiểm tra chặn trùng.
    const second = await request(adminApp)
      .post('/api/sales')
      .send({
        customerId: custInA,
        items: [{ productId: prod.id, quantity: 1, price: prod.sell_price }],
        force: true,
      });
    expect(db.prepare('SELECT driver_username FROM sales WHERE id = ?').get(second.body.id).driver_username).toBe(DRIVER_B);

    // Đơn CŨ → tái phân công theo quy tắc "chưa khoá" → về B.
    expect(db.prepare('SELECT driver_username FROM sales WHERE id = ?').get(first.body.id).driver_username).toBe(DRIVER_B);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L. TỰ ĐỘNG ĐIỀU PHỐ Ở CÁC LUỒNG TẠO ĐƠN KHÁC
// ═══════════════════════════════════════════════════════════════════════════
describe('L. Tự động điều phố ở các luồng tạo đơn khác', () => {
  let custInA;
  let prod;

  beforeEach(() => {
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });
    custInA = createCustomer('AD_TEST_L_KhachA', regionIds.HOA_THANH);
    prod = getProduct();
  });

  test('K7. Đơn đồng bộ từ LAN (POST /api/sync/batch) cũng được tự điều phố', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/sync', require('../routes/api/sync'));

    const res = await request(app).post('/api/sync/batch').send({
      deviceId: 'ad-test-device',
      items: [
        {
          syncId: 'ad-test-sync-1',
          entity: 'sale',
          action: 'create',
          data: {
            id: 987654,
            customer_id: custInA,
            date: db.getBusinessDateStr(),
            total: 100000,
            profit: 50000,
            type: 'sale',
            items: [{ product_id: prod.id, quantity: 1, price: prod.sell_price }],
          },
        },
      ],
    });

    expect(res.status).toBe(200);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(987654);
    expect(sale).toBeTruthy();
    expect(sale.driver_username).toBe(DRIVER_A);
    expect(sale.region_id).toBe(regionIds.HOA_THANH);

    db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(987654);
    db.prepare('DELETE FROM sales WHERE id = ?').run(987654);
  });

  test('K8. Đơn đổi bia lỗi (replacement) cũng được tự điều phố', async () => {
    const res = await request(adminApp)
      .post('/api/sales/replacement')
      .send({
        customer_id: custInA,
        product_id: prod.id,
        quantity: 1,
        reason: 'AD_TEST đổi bia lỗi',
      });

    expect(res.status).toBe(200);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(res.body.id);
    expect(sale.driver_username).toBe(DRIVER_A);
    expect(sale.region_id).toBe(regionIds.HOA_THANH);
  });

  test('K12. Đơn đồng bộ qua POST /api/orders cũng được tự điều phố', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/orders', require('../routes/api/orders'));

    const res = await request(app).post('/api/orders').send({
      customerId: custInA,
      total: 100000,
      profit: 50000,
      items: [{ productId: prod.id, quantity: 1, price: prod.sell_price }],
    });

    expect(res.status).toBe(201);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(res.body.id);
    expect(sale.driver_username).toBe(DRIVER_A);
    expect(sale.region_id).toBe(regionIds.HOA_THANH);
    expect(sale.region_name).toBe('Hòa Thành');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M. TÁI ĐIỀU PHỐ KHI KHÁCH HÀNG ĐỔI KHU VỰC
// ═══════════════════════════════════════════════════════════════════════════
describe('M. Đổi khu vực khách hàng → tái điều phố đơn chưa hoàn tất', () => {
  let cust;
  let prod;

  function customersApp() {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { username: ADMIN_USER, role: 'ADMIN' };
      next();
    });
    app.use('/api/customers', require('../routes/api/customers'));
    return app;
  }

  function createSaleFor(customerId, regionId, driverUsername) {
    const today = db.getVietnamDateStr();
    const r = db
      .prepare(
        `INSERT INTO sales (customer_id, date, created_on, sale_time, total, profit, type,
                            driver_username, region_id, region_name)
         VALUES (?, ?, ?, ?, 100000, 50000, 'sale', ?, ?, ?)`
      )
      .run(
        customerId,
        today,
        today,
        db.getVietnamTimeStr(),
        driverUsername || null,
        regionId || null,
        regionId ? 'R' + regionId : null
      );
    return r.lastInsertRowid;
  }

  beforeEach(() => {
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });
    RegionService.assignDriver(regionIds.TAN_BIEN, DRIVER_B, { actor: ADMIN_USER });
    cust = createCustomer('AD_TEST_M_Khach', regionIds.HOA_THANH);
    prod = getProduct();
  });

  test('M1. Đổi khu vực → đơn chưa hoàn tất chuyển sang tài xế khu vực mới', async () => {
    const saleId = createSaleFor(cust, regionIds.HOA_THANH, DRIVER_A);

    const res = await request(customersApp())
      .put('/api/customers/' + cust)
      .send({ region_id: regionIds.TAN_BIEN });

    expect(res.status).toBe(200);
    expect(res.body.redispatch.reassigned).toBe(1);

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(sale.driver_username).toBe(DRIVER_B);
    expect(sale.region_id).toBe(regionIds.TAN_BIEN);
  });

  test('M2. Đơn đã hoàn tất → GIỮ NGUYÊN lịch sử tài xế + khu vực', async () => {
    const saleDone = createSaleFor(cust, regionIds.HOA_THANH, DRIVER_A);
    // Đánh dấu đã giao → khoá
    db.prepare(
      `INSERT INTO delivery_records (sale_id, customer_id, driver_username, status, scheduled_date)
       VALUES (?, ?, ?, 'DELIVERED', ?)`
    ).run(saleDone, cust, DRIVER_A, db.getVietnamDateStr());

    const res = await request(customersApp())
      .put('/api/customers/' + cust)
      .send({ region_id: regionIds.TAN_BIEN });

    expect(res.status).toBe(200);
    expect(res.body.redispatch.preserved).toBe(1);
    expect(res.body.redispatch.reassigned).toBe(0);

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleDone);
    expect(sale.driver_username).toBe(DRIVER_A);
    expect(sale.region_id).toBe(regionIds.HOA_THANH);
  });

  test('M3. Đổi sang khu vực CHƯA có tài xế → đơn bỏ gán (về hàng đợi chờ điều phố)', async () => {
    const saleId = createSaleFor(cust, regionIds.HOA_THANH, DRIVER_A);

    const res = await request(customersApp())
      .put('/api/customers/' + cust)
      .send({ region_id: regionIds.GO_DAU });

    expect(res.status).toBe(200);
    expect(res.body.redispatch.unassigned).toBe(1);

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(sale.driver_username).toBeNull();
    expect(sale.region_id).toBe(regionIds.GO_DAU);
  });

  test('M4. Bỏ khu vực của khách → đơn chưa hoàn tất bỏ gán tài xế', async () => {
    const saleId = createSaleFor(cust, regionIds.HOA_THANH, DRIVER_A);

    const res = await request(customersApp())
      .put('/api/customers/' + cust)
      .send({ region_id: null });

    expect(res.status).toBe(200);
    expect(res.body.redispatch.unassigned).toBe(1);

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(sale.driver_username).toBeNull();
    expect(sale.region_id).toBeNull();
  });

  test('M5. KHÔNG đổi khu vực → không tái điều phố (đơn giữ nguyên)', async () => {
    const saleId = createSaleFor(cust, regionIds.HOA_THANH, DRIVER_A);

    const res = await request(customersApp())
      .put('/api/customers/' + cust)
      .send({ name: 'AD_TEST_M_Khach đổi tên' });

    expect(res.status).toBe(200);
    expect(res.body.redispatch).toBeUndefined();

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(sale.driver_username).toBe(DRIVER_A);
  });

  test('M6. Đổi khu vực → đơn MỚI tạo sau đó về tài xế khu vực mới', async () => {
    await request(customersApp())
      .put('/api/customers/' + cust)
      .send({ region_id: regionIds.TAN_BIEN });

    const res = await request(adminApp)
      .post('/api/sales')
      .send({
        customerId: cust,
        items: [{ productId: prod.id, quantity: 1, price: prod.sell_price }],
      });

    expect(res.status).toBe(200);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(res.body.id);
    expect(sale.driver_username).toBe(DRIVER_B);
  });

  test('M7. Đổi khu vực → phiếu giao (delivery_records) chuyển sang tài xế mới', async () => {
    const saleId = createSaleFor(cust, regionIds.HOA_THANH, DRIVER_A);
    // Tạo phiếu giao cho tài xế A
    const DeliveryService = require('../src/services/DeliveryService');
    const r = DeliveryService.ensureRecord(saleId, DRIVER_A);
    expect(r.success).toBe(true);

    await request(customersApp())
      .put('/api/customers/' + cust)
      .send({ region_id: regionIds.TAN_BIEN });

    // Phiếu giao cũ của A không còn active → đã chuyển sang B
    const oldRec = db
      .prepare("SELECT * FROM delivery_records WHERE sale_id = ? AND driver_username = ?")
      .get(saleId, DRIVER_A);
    expect(oldRec).toBeFalsy();

    const newRec = db
      .prepare("SELECT * FROM delivery_records WHERE sale_id = ? AND driver_username = ?")
      .get(saleId, DRIVER_B);
    expect(newRec).toBeTruthy();
    expect(newRec.status).toBe('PENDING');
  });

  test('M8. Đổi sang khu vực chưa có tài xế → giải phóng phiếu giao (đơn về hàng đợi)', async () => {
    const saleId = createSaleFor(cust, regionIds.HOA_THANH, DRIVER_A);
    const DeliveryService = require('../src/services/DeliveryService');
    DeliveryService.ensureRecord(saleId, DRIVER_A);

    await request(customersApp())
      .put('/api/customers/' + cust)
      .send({ region_id: regionIds.GO_DAU });

    const rec = db
      .prepare("SELECT * FROM delivery_records WHERE sale_id = ? AND status IN ('PENDING','IN_PROGRESS')")
      .get(saleId);
    expect(rec).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// N. ĐỔI TÀI XẾ KHU VỰC → TÁI PHÂN CÔNG ĐƠN + ĐỒNG BỘ PHIẾU GIAO
// ═══════════════════════════════════════════════════════════════════════════
describe('N. Đổi tài xế phụ trách khu vực → đơn & phiếu giao đi theo', () => {
  let cust;

  function createSaleFor(customerId, regionId, driverUsername) {
    const today = db.getVietnamDateStr();
    const r = db
      .prepare(
        `INSERT INTO sales (customer_id, date, created_on, sale_time, total, profit, type,
                            driver_username, region_id, region_name)
         VALUES (?, ?, ?, ?, 100000, 50000, 'sale', ?, ?, ?)`
      )
      .run(
        customerId,
        today,
        today,
        db.getVietnamTimeStr(),
        driverUsername || null,
        regionId || null,
        regionId ? 'R' + regionId : null
      );
    return r.lastInsertRowid;
  }

  beforeEach(() => {
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });
    cust = createCustomer('AD_TEST_N_Khach', regionIds.HOA_THANH);
    prod = getProduct();
  });

  test('N1. Đổi tài xế khu vực → đơn chưa hoàn tất chuyển sang tài xế mới', () => {
    const saleId = createSaleFor(cust, regionIds.HOA_THANH, DRIVER_A);

    const r = RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_B, {
      actor: ADMIN_USER,
      confirmTakeover: true,
    });
    expect(r.success).toBe(true);

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(sale.driver_username).toBe(DRIVER_B);
  });

  test('N2. Đổi tài xế khu vực → phiếu giao chuyển sang tài xế mới', () => {
    const saleId = createSaleFor(cust, regionIds.HOA_THANH, DRIVER_A);
    const DeliveryService = require('../src/services/DeliveryService');
    DeliveryService.ensureRecord(saleId, DRIVER_A);

    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_B, {
      actor: ADMIN_USER,
      confirmTakeover: true,
    });

    const oldRec = db
      .prepare('SELECT * FROM delivery_records WHERE sale_id = ? AND driver_username = ?')
      .get(saleId, DRIVER_A);
    expect(oldRec).toBeFalsy();

    const newRec = db
      .prepare('SELECT * FROM delivery_records WHERE sale_id = ? AND driver_username = ?')
      .get(saleId, DRIVER_B);
    expect(newRec).toBeTruthy();
    expect(newRec.status).toBe('PENDING');
  });

  test('N3. Đổi tài xế khu vực → đơn đã hoàn tất GIỮ NGUYÊN lịch sử', () => {
    const saleId = createSaleFor(cust, regionIds.HOA_THANH, DRIVER_A);
    db.prepare(
      `INSERT INTO delivery_records (sale_id, customer_id, driver_username, status, scheduled_date)
       VALUES (?, ?, ?, 'DELIVERED', ?)`
    ).run(saleId, cust, DRIVER_A, db.getVietnamDateStr());

    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_B, {
      actor: ADMIN_USER,
      confirmTakeover: true,
    });

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(sale.driver_username).toBe(DRIVER_A);
  });

  test('N4. Ngừng phân công tài xế → đơn chưa hoàn tất về hàng đợi chờ điều phố', () => {
    const saleId = createSaleFor(cust, regionIds.HOA_THANH, DRIVER_A);
    const DeliveryService = require('../src/services/DeliveryService');
    DeliveryService.ensureRecord(saleId, DRIVER_A);

    RegionService.unassignDriver(regionIds.HOA_THANH, { actor: ADMIN_USER });

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(sale.driver_username).toBeNull();

    const rec = db
      .prepare("SELECT * FROM delivery_records WHERE sale_id = ? AND status IN ('PENDING','IN_PROGRESS')")
      .get(saleId);
    expect(rec).toBeFalsy();
  });
});
