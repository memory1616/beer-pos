/**
 * DISPATCH QUEUE — Vòng đời "đơn chờ điều phố" (Regression suite)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bug gốc (user report):
 *   "Tôi vừa uncheck khu vực Trảng Bàng của giaohang01, nhưng 2 đơn Trảng
 *    Bàng đó không quay lại 🚚 Đơn chờ điều phố."
 *
 * Nguyên nhân:
 *   1. `sales.region_id` NULL (đơn tạo trước khi khách được gán khu vực)
 *      → truy vấn "đơn thuộc khu vực" không match → không giải phóng.
 *   2. `sales.dispatch_status` NULL → không khớp bộ lọc 'UNASSIGNED'.
 *
 * Yêu cầu nghiệp vụ kiểm chứng:
 *   P1. Bỏ phân công tài xế khu vực → đơn chưa giao của khu vực về hàng đợi.
 *   P2. Đơn đã hoàn tất → giữ nguyên lịch sử (KHÔNG về hàng đợi).
 *   P3. Tài xế đảm nhận đơn chờ → đơn đó + các đơn chờ cùng khu vực (chưa
 *       giao) chuyển cho tài xế đó.
 *   P4. Đơn legacy (trước kỷ nguyên điều phố) KHÔNG tràn hàng đợi.
 *   P5. Gán lại tài xế cho khu vực → đơn chờ của khu vực chuyển lại tài xế.
 */
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const db = require('../database');
const { hashPassword } = require('../src/utils/password');
const RegionService = require('../src/services/RegionService');
const migration058 = require('../database/migrations/058_business_regions');

jest.setTimeout(30000);

const ADMIN_USER = 'dq_admin';
const DRIVER_A = 'dq_driver_a';
const DRIVER_B = 'dq_driver_b';

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildApp(role, username) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => {
    req.user = { username, role };
    next();
  });
  a.use('/api/admin/regions', require('../routes/api/regions'));
  a.use('/api/driver', require('../routes/api/driver'));
  return a;
}

function createUser(username, role) {
  const hash = hashPassword('test_pw_123');
  const existing = db.prepare('SELECT id FROM app_users WHERE username = ?').get(username);
  if (existing) {
    db
      .prepare('UPDATE app_users SET password_hash = ?, role = ?, active = 1 WHERE id = ?')
      .run(hash, role, existing.id);
    return existing.id;
  }
  const r = db
    .prepare(
      "INSERT INTO app_users (username, password_hash, full_name, role, active) VALUES (?, ?, ?, ?, 1)"
    )
    .run(username, hash, username, role);
  return r.lastInsertRowid;
}

function createCustomer(name, regionId) {
  const r = db
    .prepare('INSERT INTO customers (name, phone, region_id, deposit, keg_balance) VALUES (?, ?, ?, 0, 0)')
    .run(name, '0900' + Math.floor(1000000 + Math.random() * 8999999), regionId);
  return r.lastInsertRowid;
}

/**
 * Tạo đơn hàng trực tiếp bằng SQL.
 * @param {object} o - { customerId, regionId, driver, dispatchStatus, snapshotRegion }
 *   snapshotRegion: false → đơn KHÔNG có snapshot khu vực (mô phỏng bug gốc).
 */
function createSale(o) {
  const today = db.getVietnamDateStr();
  const r = db
    .prepare(
      `INSERT INTO sales (customer_id, date, created_on, sale_time, total, profit, type,
                          driver_username, region_id, region_name, dispatch_status)
       VALUES (?, ?, ?, ?, 100000, 50000, 'sale', ?, ?, ?, ?)`
    )
    .run(
      o.customerId,
      today,
      today,
      db.getVietnamTimeStr(),
      o.driver || null,
      o.snapshotRegion === false ? null : o.regionId || null,
      o.snapshotRegion === false ? null : o.regionId ? 'R' + o.regionId : null,
      o.dispatchStatus !== undefined ? o.dispatchStatus : o.driver ? 'MANUAL' : 'UNASSIGNED'
    );
  return r.lastInsertRowid;
}

function markDelivered(saleId, customerId, driver) {
  db.prepare(
    `INSERT INTO delivery_records (sale_id, customer_id, driver_username, status, scheduled_date)
     VALUES (?, ?, ?, 'DELIVERED', ?)`
  ).run(saleId, customerId, driver, db.getVietnamDateStr());
}

function cleanup() {
  try {
    db.prepare(
      `DELETE FROM delivery_records WHERE sale_id IN (SELECT id FROM sales WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE ?))`
    ).run('DQ_TEST_%');
    db.prepare(
      `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE ?))`
    ).run('DQ_TEST_%');
    db.prepare(
      `DELETE FROM sales WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE ?)]`
    ).run('DQ_TEST_%');
    db.prepare('DELETE FROM customers WHERE name LIKE ?').run('DQ_TEST_%');
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
  driverBApp = buildApp('DRIVER', DRIVER_B);

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

async function getUnassignedIds() {
  const res = await request(adminApp).get('/api/admin/regions/dispatch/unassigned');
  expect(res.status).toBe(200);
  return res.body.sales.map((s) => s.id);
}

// ═══════════════════════════════════════════════════════════════════════════
// P. VÒNG ĐỜI ĐƠN CHỜ ĐIỀU PHỐ
// ═══════════════════════════════════════════════════════════════════════════
describe('P. Bỏ phân công → đơn về hàng đợi chờ điều phố', () => {
  let cust;

  beforeEach(() => {
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });
    cust = createCustomer('DQ_TEST_Khach', regionIds.HOA_THANH);
  });

  test('P1a. Bỏ phân công → đơn chưa giao của khu vực quay lại hàng đợi', async () => {
    const saleId = createSale({ customerId: cust, regionId: regionIds.HOA_THANH, driver: DRIVER_A });

    const r = RegionService.unassignDriver(regionIds.HOA_THANH, { actor: ADMIN_USER });
    expect(r.success).toBe(true);

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(sale.driver_username).toBeNull();
    expect(sale.dispatch_status).toBe('UNASSIGNED');

    const ids = await getUnassignedIds();
    expect(ids).toContain(saleId);
  });

  test('P1b. BUG GỐC: đơn KHÔNG có snapshot khu vực (region_id NULL) vẫn về hàng đợi', async () => {
    // Đơn tạo trước khi khách được gán khu vực → sales.region_id = NULL.
    const saleId = createSale({
      customerId: cust,
      regionId: regionIds.HOA_THANH,
      driver: DRIVER_A,
      snapshotRegion: false,
    });

    const r = RegionService.unassignDriver(regionIds.HOA_THANH, { actor: ADMIN_USER });
    expect(r.success).toBe(true);

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(sale.driver_username).toBeNull();
    expect(sale.dispatch_status).toBe('UNASSIGNED');
    // Snapshot khu vực được bù lại từ khách hàng.
    expect(sale.region_id).toBe(regionIds.HOA_THANH);

    const ids = await getUnassignedIds();
    expect(ids).toContain(saleId);
  });

  test('P1c. Bỏ phân công → đơn của khu vực KHÁC không bị đụng', async () => {
    const otherCust = createCustomer('DQ_TEST_KhachKhac', regionIds.TAN_BIEN);
    RegionService.assignDriver(regionIds.TAN_BIEN, DRIVER_B, { actor: ADMIN_USER });
    const otherSale = createSale({
      customerId: otherCust,
      regionId: regionIds.TAN_BIEN,
      driver: DRIVER_B,
    });

    RegionService.unassignDriver(regionIds.HOA_THANH, { actor: ADMIN_USER });

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(otherSale);
    expect(sale.driver_username).toBe(DRIVER_B);
  });

  test('P2. Đơn đã hoàn tất → giữ nguyên lịch sử, KHÔNG về hàng đợi', async () => {
    const saleId = createSale({ customerId: cust, regionId: regionIds.HOA_THANH, driver: DRIVER_A });
    markDelivered(saleId, cust, DRIVER_A);

    RegionService.unassignDriver(regionIds.HOA_THANH, { actor: ADMIN_USER });

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(sale.driver_username).toBe(DRIVER_A);
    expect(sale.dispatch_status).not.toBe('UNASSIGNED');

    const ids = await getUnassignedIds();
    expect(ids).not.toContain(saleId);
  });

  test('P5. Gán lại tài xế cho khu vực → đơn chờ chuyển về tài xế đó', async () => {
    const saleId = createSale({ customerId: cust, regionId: regionIds.HOA_THANH, driver: DRIVER_A });

    RegionService.unassignDriver(regionIds.HOA_THANH, { actor: ADMIN_USER });
    expect(db.prepare('SELECT driver_username FROM sales WHERE id = ?').get(saleId).driver_username).toBeNull();

    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(sale.driver_username).toBe(DRIVER_A);
    expect(sale.dispatch_status).toBe('AUTO');

    const ids = await getUnassignedIds();
    expect(ids).not.toContain(saleId);
  });

  test('P4. Đơn legacy (dispatch_status NULL, trước kỷ nguyên) KHÔNG tràn hàng đợi', async () => {
    // Đơn rất cũ, không có cờ điều phố.
    const saleId = createSale({
      customerId: cust,
      regionId: regionIds.HOA_THANH,
      driver: null,
      dispatchStatus: null,
    });

    const ids = await getUnassignedIds();
    expect(ids).not.toContain(saleId);
  });

  test('P6. Admin bấm "Lưu" LẠI cùng tài xế → đơn chờ vẫn được đồng bộ về tài xế', async () => {
    // Đơn chờ điều phố (khu vực đã có tài xế nhưng đơn bị bỏ sót).
    const saleId = createSale({
      customerId: cust,
      regionId: regionIds.HOA_THANH,
      driver: null,
      dispatchStatus: 'UNASSIGNED',
    });

    // Gán LẠI đúng tài xế đang phụ trách → `changed = false` (không đổi).
    const r = RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });
    expect(r.success).toBe(true);
    expect(r.changed).toBe(false);

    // → Đơn phải được đồng bộ về tài xế (không kẹt vĩnh viễn trong hàng đợi).
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(sale.driver_username).toBe(DRIVER_A);
    expect(sale.dispatch_status).toBe('AUTO');

    const ids = await getUnassignedIds();
    expect(ids).not.toContain(saleId);
  });

  test('P7. Bỏ phân công rồi gán lại → đơn chờ về hàng đợi rồi chuyển lại tài xế', async () => {
    const saleId = createSale({ customerId: cust, regionId: regionIds.HOA_THANH, driver: DRIVER_A });

    // Bỏ phân công → đơn về hàng đợi.
    RegionService.unassignDriver(regionIds.HOA_THANH, { actor: ADMIN_USER });
    expect(await getUnassignedIds()).toContain(saleId);

    // Gán lại → đơn rời hàng đợi, về tài xế.
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(sale.driver_username).toBe(DRIVER_A);
    expect(await getUnassignedIds()).not.toContain(saleId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Q. TÀI XẾ ĐẢM NHẬN → CHUYỂN ĐƠN CÙNG KHU VỰC
// ═══════════════════════════════════════════════════════════════════════════
describe('Q. Tài xế đảm nhận đơn chờ điều phố', () => {
  let cust;

  beforeEach(() => {
    cust = createCustomer('DQ_TEST_Q_Khach', regionIds.HOA_THANH);
    // Khu vực CHƯA có tài xế → đơn nằm hàng đợi chờ điều phố.
    const s1 = createSale({ customerId: cust, regionId: regionIds.HOA_THANH, driver: null });
    const s2 = createSale({ customerId: cust, regionId: regionIds.HOA_THANH, driver: null });
    // Đơn đã giao → không được chuyển.
    const s3 = createSale({ customerId: cust, regionId: regionIds.HOA_THANH, driver: null });
    markDelivered(s3, cust, DRIVER_A);
    global.__dq = { s1, s2, s3 };
  });

  test('Q1. Tài xế đảm nhận → đơn đó được gán + dispatch_status = MANUAL', async () => {
    const { s1 } = global.__dq;
    const res = await request(driverAApp)
      .post('/api/driver/deliveries')
      .send({ saleId: s1 });
    expect(res.status).toBe(201);

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(s1);
    expect(sale.driver_username).toBe(DRIVER_A);
    expect(sale.dispatch_status).toBe('MANUAL');
    expect(sale.region_id).toBe(regionIds.HOA_THANH);
  });

  test('Q2. Tài xế đảm nhận → các đơn chờ CÙNG KHU VỰC (chưa giao) chuyển cho tài xế', async () => {
    const { s1, s2, s3 } = global.__dq;

    await request(driverAApp).post('/api/driver/deliveries').send({ saleId: s1 });

    const s2row = db.prepare('SELECT * FROM sales WHERE id = ?').get(s2);
    expect(s2row.driver_username).toBe(DRIVER_A);
    expect(s2row.dispatch_status).toBe('MANUAL');

    // Đơn đã giao → giữ nguyên lịch sử.
    const s3row = db.prepare('SELECT * FROM sales WHERE id = ?').get(s3);
    expect(s3row.driver_username).toBeNull();

    // Không còn đơn nào trong hàng đợi.
    const ids = await getUnassignedIds();
    expect(ids).not.toContain(s1);
    expect(ids).not.toContain(s2);
  });

  test('Q3. Tài xế đảm nhận → đơn về hàng đợi trước đó KHÔNG còn nằm trong hàng đợi', async () => {
    const { s1 } = global.__dq;
    expect(await getUnassignedIds()).toContain(s1);

    await request(driverAApp).post('/api/driver/deliveries').send({ saleId: s1 });

    expect(await getUnassignedIds()).not.toContain(s1);
  });

  test('Q4. Tài xế KHÔNG được đảm nhận đơn của khu vực mình không phụ trách', async () => {
    RegionService.assignDriver(regionIds.TAN_BIEN, DRIVER_B, { actor: ADMIN_USER });
    const otherCust = createCustomer('DQ_TEST_Q_KhachKhac', regionIds.TAN_BIEN);
    const otherSale = createSale({
      customerId: otherCust,
      regionId: regionIds.TAN_BIEN,
      driver: null,
    });

    const res = await request(driverAApp)
      .post('/api/driver/deliveries')
      .send({ saleId: otherSale });

    // API driver chặn trước (đơn chưa gán) → nhưng service phải từ chối gán.
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(otherSale);
    expect(sale.driver_username).toBeNull();
    expect(res.status).toBeGreaterThanOrEqual(200);
  });
});
