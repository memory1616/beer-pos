/**
 * CUSTOMER REGIONS & DRIVER TERRITORY AUTHORIZATION — Test suite
 * ─────────────────────────────────────────────────────────────────────────────
 * Kiểm chứng 10 yêu cầu nghiệp vụ:
 *
 *  A. Danh mục 9 khu vực — seed đúng, idempotent, single source of truth.
 *  B. Trường "Khu vực khách hàng" bắt buộc trong form Add/Edit + API.
 *  C. Gán NHIỀU khu vực cho MỘT tài xế (multi-select).
 *  D. Một khu vực chỉ có MỘT tài xế chính đang hoạt động.
 *  E. Tài xế chỉ xem được đơn thuộc khu vực được phân công.
 *  F. Tài xế KHÔNG xem/xử lý được đơn khu vực khác (backend 403).
 *  G. Khi đổi phân công → quyền mới chỉ áp dụng cho đơn CHƯA khoá.
 *  H. Đơn đã hoàn tất giữ nguyên lịch sử tài xế + khu vực.
 *  I. Đơn chưa có tài xế → danh sách chờ điều phối của Admin.
 *  J. Admin điều phối / chuyển đơn giữa các tài xế.
 */
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const db = require('../database');
const { hashPassword } = require('../src/utils/password');
const RegionService = require('../src/services/RegionService');
const { DEFAULT_BUSINESS_REGIONS } = require('../src/constants/businessRegions');
const migration058 = require('../database/migrations/058_business_regions');

jest.setTimeout(30000);

const ADMIN_USER = 'rg_admin';
const DRIVER_A = 'rg_driver_a';
const DRIVER_B = 'rg_driver_b';

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildApp(role, username) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => {
    req.user = { username: username, role: role };
    next();
  });
  a.use('/api/admin/regions', require('../routes/api/regions'));
  a.use('/api/regions', require('../routes/api/regionCatalog'));
  a.use('/api/driver/sale', require('../routes/api/driverSale'));
  return a;
}

function createUser(username, role) {
  const hash = hashPassword('test_pw_123');
  const existing = db.prepare('SELECT id FROM app_users WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE app_users SET password_hash = ?, role = ?, active = 1 WHERE id = ?').run(
      hash,
      role,
      existing.id
    );
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
    .prepare(
      'INSERT INTO customers (name, phone, region_id, deposit, keg_balance) VALUES (?, ?, ?, 0, 0)'
    )
    .run(name, '0900' + Math.floor(1000000 + Math.random() * 8999999), regionId);
  return r.lastInsertRowid;
}

function createSale(customerId, regionId, driverUsername) {
  const today = db.getVietnamDateStr();
  const r = db
    .prepare(
      `INSERT INTO sales (customer_id, date, created_on, sale_time, total, profit, type, driver_username, region_id, region_name)
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

function cleanup() {
  try {
    db.prepare('DELETE FROM delivery_records WHERE sale_id IN (SELECT id FROM sales WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE ?))').run('RG_TEST_%');
    db.prepare('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE ?))').run('RG_TEST_%');
    db.prepare('DELETE FROM sales WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE ?)').run('RG_TEST_%');
    db.prepare('DELETE FROM customers WHERE name LIKE ?').run('RG_TEST_%');
    db.prepare('DELETE FROM region_driver_assignments WHERE driver_username IN (?, ?)').run(DRIVER_A, DRIVER_B);
    db.prepare('DELETE FROM region_assignment_history WHERE driver_username IN (?, ?)').run(DRIVER_A, DRIVER_B);
    db.prepare('DELETE FROM app_users WHERE username IN (?, ?)').run(DRIVER_A, DRIVER_B);
  } catch (_) {
    /* ignore */
  }
}

let adminApp;
let driverAApp;
let driverBApp;
let regionIds = {};

beforeAll(() => {
  migration058.up(db);
  createUser(ADMIN_USER, 'ADMIN');
  createUser(DRIVER_A, 'DRIVER');
  createUser(DRIVER_B, 'DRIVER');

  adminApp = buildApp('ADMIN', ADMIN_USER);
  driverAApp = buildApp('DRIVER', DRIVER_A);
  driverBApp = buildApp('DRIVER', DRIVER_B);

  const rows = db.prepare('SELECT id, code FROM business_regions WHERE active = 1').all();
  rows.forEach((r) => {
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
});

// ═══════════════════════════════════════════════════════════════════════════
// A. DANH MỤC 9 KHU VỰC
// ═══════════════════════════════════════════════════════════════════════════
describe('A. Danh mục 9 khu vực kinh doanh', () => {
  test('migration seed đủ 9 khu vực với mã chuẩn', () => {
    const rows = db.prepare('SELECT name, code FROM business_regions WHERE active = 1').all();
    expect(rows.length).toBe(9);
    const codes = rows.map((r) => r.code).sort();
    expect(codes).toEqual(DEFAULT_BUSINESS_REGIONS.map((r) => r.code).sort());
  });

  test('migration idempotent — chạy lại không nhân bản', () => {
    migration058.up(db);
    migration058.up(db);
    const count = db.prepare('SELECT COUNT(*) AS c FROM business_regions').get().c;
    expect(count).toBe(9);
  });

  test('GET /api/regions trả về danh mục đầy đủ cho form', async () => {
    const res = await request(driverAApp).get('/api/regions');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.regions).toHaveLength(9);
    res.body.regions.forEach((r) => {
      expect(r.id).toBeDefined();
      expect(r.name).toBeTruthy();
      expect(r.code).toBeTruthy();
    });
  });

  test('unique index: 1 khu vực chỉ 1 tài xế active', () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_region_assign_active_unique'")
      .get();
    expect(idx).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C + D. GÁN NHIỀU KHU VỰC / 1 KHU VỰC 1 TÀI XẾ
// ═══════════════════════════════════════════════════════════════════════════
describe('C. Gán nhiều khu vực cho một tài xế', () => {
  test('gán 3 khu vực cho 1 tài xế → cả 3 đều active', () => {
    const r1 = RegionService.assignDriver(regionIds.TP_TAY_NINH, DRIVER_A, { actor: ADMIN_USER });
    const r2 = RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });
    const r3 = RegionService.assignDriver(regionIds.TAN_BIEN, DRIVER_A, { actor: ADMIN_USER });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(true);

    const mine = RegionService.getDriverRegionIds(DRIVER_A).sort();
    expect(mine).toEqual(
      [regionIds.TP_TAY_NINH, regionIds.HOA_THANH, regionIds.TAN_BIEN].sort()
    );
  });

  test('gán thêm khu vực thứ 4 cho cùng tài xế (multi-select mở rộng)', () => {
    RegionService.assignDriver(regionIds.TP_TAY_NINH, DRIVER_A, { actor: ADMIN_USER });
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });
    RegionService.assignDriver(regionIds.TAN_BIEN, DRIVER_A, { actor: ADMIN_USER });
    RegionService.assignDriver(regionIds.TAN_CHAU, DRIVER_A, { actor: ADMIN_USER });
    expect(RegionService.getDriverRegionIds(DRIVER_A)).toHaveLength(4);
  });

  test('GET /api/regions/my trả về đúng danh sách khu vực của tài xế', async () => {
    RegionService.assignDriver(regionIds.TP_TAY_NINH, DRIVER_A, { actor: ADMIN_USER });
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });
    RegionService.assignDriver(regionIds.TAN_BIEN, DRIVER_A, { actor: ADMIN_USER });
    RegionService.assignDriver(regionIds.TAN_CHAU, DRIVER_A, { actor: ADMIN_USER });

    const res = await request(driverAApp).get('/api/regions/my');
    expect(res.status).toBe(200);
    expect(res.body.regions).toHaveLength(4);
  });
});

describe('D. Một khu vực chỉ có một tài xế chính', () => {
  test('gán tài xế B đè tài xế A → A bị deactivate, B thành chính', () => {
    RegionService.assignDriver(regionIds.TP_TAY_NINH, DRIVER_A, { actor: ADMIN_USER });
    const r = RegionService.assignDriver(regionIds.TP_TAY_NINH, DRIVER_B, { actor: ADMIN_USER });
    expect(r.success).toBe(true);

    const active = RegionService.getActiveDriver(regionIds.TP_TAY_NINH);
    expect(active.username).toBe(DRIVER_B);

    const activeRows = db
      .prepare('SELECT COUNT(*) AS c FROM region_driver_assignments WHERE region_id = ? AND active = 1')
      .get(regionIds.TP_TAY_NINH).c;
    expect(activeRows).toBe(1);
  });

  test('tài xế A không còn có quyền ở khu vực đã chuyển cho B', () => {
    RegionService.assignDriver(regionIds.TP_TAY_NINH, DRIVER_B, { actor: ADMIN_USER });
    const ids = RegionService.getDriverRegionIds(DRIVER_A);
    expect(ids).not.toContain(regionIds.TP_TAY_NINH);
  });

  test('ngừng phân công → khu vực không còn tài xế nào', () => {
    RegionService.assignDriver(regionIds.GO_DAU, DRIVER_A, { actor: ADMIN_USER });
    const r = RegionService.unassignDriver(regionIds.GO_DAU, { actor: ADMIN_USER });
    expect(r.success).toBe(true);
    expect(RegionService.getActiveDriver(regionIds.GO_DAU)).toBeNull();
  });

  test('lịch sử phân công được ghi lại', () => {
    RegionService.assignDriver(regionIds.BEN_CAU, DRIVER_A, { actor: ADMIN_USER });
    const hist = RegionService.getHistory(regionIds.BEN_CAU);
    expect(hist.length).toBeGreaterThan(0);
    expect(hist[0].new_driver_username).toBe(DRIVER_A);
    expect(hist[0].action).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E + F. TÀI XẾ CHỈ XỬ LÝ ĐƠN KHU VỰC ĐƯỢC PHÂN CÔNG
// ═══════════════════════════════════════════════════════════════════════════
describe('E/F. Phân quyền đơn hàng theo khu vực (backend)', () => {
  let custInA;
  let custInB;
  let saleInA;
  let saleInB;

  beforeEach(() => {
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });
    RegionService.assignDriver(regionIds.TAN_BIEN, DRIVER_B, { actor: ADMIN_USER });

    custInA = createCustomer('RG_TEST_KhachA', regionIds.HOA_THANH);
    custInB = createCustomer('RG_TEST_KhachB', regionIds.TAN_BIEN);

    saleInA = createSale(custInA, regionIds.HOA_THANH, null);
    saleInB = createSale(custInB, regionIds.TAN_BIEN, null);
  });

  test('tài xế A ĐƯỢC xem đơn thuộc khu vực mình', () => {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleInA);
    const check = RegionService.canDriverAccessSale(sale, DRIVER_A, 'DRIVER');
    expect(check.allowed).toBe(true);
  });

  test('tài xế A KHÔNG được xem đơn khu vực của tài xế B', () => {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleInB);
    const check = RegionService.canDriverAccessSale(sale, DRIVER_A, 'DRIVER');
    expect(check.allowed).toBe(false);
    expect(check.reason).toBeTruthy();
  });

  test('API GET /api/driver/sale/:id → 404 cho đơn ngoài quyền (kể cả khi đổi URL)', async () => {
    const res = await request(driverAApp).get('/api/driver/sale/' + saleInB);
    expect(res.status).toBe(404);
  });

  test('API GET /api/driver/sale/:id → 200 cho đơn trong quyền', async () => {
    const res = await request(driverAApp).get('/api/driver/sale/' + saleInA);
    expect(res.status).toBe(200);
    expect(res.body.sale.id).toBe(saleInA);
  });

  test('tài xế B KHÔNG được thao tác đơn của tài xế A', async () => {
    const res = await request(driverBApp).put('/api/driver/sale/' + saleInA).send({ note: 'hack' });
    expect(res.status).toBe(404);
  });

  test('ADMIN luôn có quyền (override)', () => {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleInB);
    const check = RegionService.canDriverAccessSale(sale, ADMIN_USER, 'ADMIN');
    expect(check.allowed).toBe(true);
  });

  test('đơn đã gán cho CHÍNH tài xế → được phép dù khu vực đã đổi', () => {
    RegionService.assignDriver(regionIds.TAN_BIEN, DRIVER_B, { actor: ADMIN_USER });
    db.prepare('UPDATE sales SET driver_username = ? WHERE id = ?').run(DRIVER_A, saleInB);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleInB);
    const check = RegionService.canDriverAccessSale(sale, DRIVER_A, 'DRIVER');
    expect(check.allowed).toBe(true);
  });

  test('đơn gán cho tài xế KHÁC → bị chặn', () => {
    db.prepare('UPDATE sales SET driver_username = ? WHERE id = ?').run(DRIVER_B, saleInA);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleInA);
    const check = RegionService.canDriverAccessSale(sale, DRIVER_A, 'DRIVER');
    expect(check.allowed).toBe(false);
  });

  test('đơn chưa có khu vực → tài xế không tự xử lý (Admin điều phối)', () => {
    const cust = createCustomer('RG_TEST_NoRegion', null);
    const saleId = createSale(cust, null, null);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    const check = RegionService.canDriverAccessSale(sale, DRIVER_A, 'DRIVER');
    expect(check.allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G + H. ĐỔI PHÂN CÔNG & ĐƠN HOÀN TẤT GIỮ LỊCH SỬ
// ═══════════════════════════════════════════════════════════════════════════
describe('G/H. Đổi phân công & bất biến lịch sử đơn hoàn tất', () => {
  let custA;
  let saleOpen;
  let saleDone;

  beforeEach(() => {
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });
    custA = createCustomer('RG_TEST_KhachA', regionIds.HOA_THANH);

    saleOpen = createSale(custA, regionIds.HOA_THANH, DRIVER_A);
    saleDone = createSale(custA, regionIds.HOA_THANH, DRIVER_A);

    // Đơn "đã hoàn tất" → delivery_records status = DELIVERED
    db.prepare(
      `INSERT INTO delivery_records (sale_id, customer_id, driver_username, status, scheduled_date)
       VALUES (?, ?, ?, 'DELIVERED', ?)`
    ).run(saleDone, custA, DRIVER_A, db.getVietnamDateStr());
  });

  test('đơn chưa khoá → đổi phân công áp dụng quyền mới', () => {
    // Chuyển khu vực sang tài xế B
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_B, { actor: ADMIN_USER });

    const openSale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleOpen);
    const doneSale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleDone);

    // Đơn mở (chưa gán ai sau khi đổi) → B được, A không
    const aOpen = RegionService.canDriverAccessSale(openSale, DRIVER_A, 'DRIVER');
    const bOpen = RegionService.canDriverAccessSale(openSale, DRIVER_B, 'DRIVER');
    expect(aOpen.allowed).toBe(false);
    expect(bOpen.allowed).toBe(true);

    // Đơn đã hoàn tất → giữ nguyên lịch sử tài xế A
    expect(doneSale.driver_username).toBe(DRIVER_A);
    expect(doneSale.region_id).toBe(regionIds.HOA_THANH);
    expect(RegionService.isSaleLocked(saleDone)).toBe(true);
  });

  test('không thể đổi tài xế cho đơn đã hoàn tất', () => {
    const r = RegionService.assignSaleDriver(saleDone, DRIVER_B, { actor: ADMIN_USER });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/hoàn tất/i);
  });

  test('Admin vẫn đổi được tài xế cho đơn CHƯA hoàn tất', () => {
    const r = RegionService.assignSaleDriver(saleOpen, DRIVER_B, { actor: ADMIN_USER });
    expect(r.success).toBe(true);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleOpen);
    expect(sale.driver_username).toBe(DRIVER_B);
  });

  test('lịch sử đơn hoàn tất giữ nguyên region snapshot sau khi đổi phân công', () => {
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_B, { actor: ADMIN_USER });
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleDone);
    expect(sale.region_id).toBe(regionIds.HOA_THANH);
    expect(sale.region_name).toBeTruthy();
    expect(sale.driver_username).toBe(DRIVER_A);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I + J. ĐƠN CHỜ ĐIỀU PHỐI & ADMIN CHUYỂN ĐƠN
// ═══════════════════════════════════════════════════════════════════════════
describe('I/J. Đơn chờ điều phối & Admin điều phối', () => {
  let custA;
  let saleUnassigned;

  beforeEach(() => {
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });
    custA = createCustomer('RG_TEST_KhachA', regionIds.HOA_THANH);
    saleUnassigned = createSale(custA, regionIds.HOA_THANH, null);
  });

  test('đơn chưa có tài xế nằm trong danh sách chờ điều phối', async () => {
    const res = await request(adminApp).get('/api/admin/regions/dispatch/unassigned');
    expect(res.status).toBe(200);
    const ids = res.body.sales.map((s) => s.id);
    expect(ids).toContain(saleUnassigned);
  });

  test('đơn đã gán tài xế KHÔNG nằm trong danh sách chờ', async () => {
    RegionService.assignSaleDriver(saleUnassigned, DRIVER_A, { actor: ADMIN_USER });
    const res = await request(adminApp).get('/api/admin/regions/dispatch/unassigned');
    const ids = res.body.sales.map((s) => s.id);
    expect(ids).not.toContain(saleUnassigned);
  });

  test('Admin gán tài xế cho đơn chờ qua API', async () => {
    const res = await request(adminApp)
      .post('/api/admin/regions/dispatch/' + saleUnassigned + '/assign')
      .send({ driverUsername: DRIVER_A });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleUnassigned);
    expect(sale.driver_username).toBe(DRIVER_A);
  });

  test('Admin CHUYỂN đơn giữa 2 tài xế', async () => {
    RegionService.assignDriver(regionIds.TAN_BIEN, DRIVER_B, { actor: ADMIN_USER });
    RegionService.assignSaleDriver(saleUnassigned, DRIVER_A, { actor: ADMIN_USER });

    const res = await request(adminApp)
      .post('/api/admin/regions/dispatch/' + saleUnassigned + '/assign')
      .send({ driverUsername: DRIVER_B });
    expect(res.status).toBe(200);

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleUnassigned);
    expect(sale.driver_username).toBe(DRIVER_B);
  });

  test('gán tài xế không tồn tại → bị từ chối', async () => {
    const res = await request(adminApp)
      .post('/api/admin/regions/dispatch/' + saleUnassigned + '/assign')
      .send({ driverUsername: 'khong_ton_tai_xyz' });
    expect(res.status).toBe(400);
  });

  test('tài xế KHÔNG gọi được API admin điều phối', async () => {
    const res = await request(driverAApp)
      .post('/api/admin/regions/dispatch/' + saleUnassigned + '/assign')
      .send({ driverUsername: DRIVER_A });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// K. PHẠM VI API DRIVER (customers / sales / deliveries)
// ═══════════════════════════════════════════════════════════════════════════
describe('K. Phạm vi API Driver theo khu vực', () => {
  let driverApp;
  let custInA;
  let custInB;
  let saleInA;
  let saleInB;

  beforeEach(() => {
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });
    RegionService.assignDriver(regionIds.TAN_BIEN, DRIVER_B, { actor: ADMIN_USER });

    custInA = createCustomer('RG_TEST_ApiA', regionIds.HOA_THANH);
    custInB = createCustomer('RG_TEST_ApiB', regionIds.TAN_BIEN);
    saleInA = createSale(custInA, regionIds.HOA_THANH, DRIVER_A);
    saleInB = createSale(custInB, regionIds.TAN_BIEN, DRIVER_B);

    driverApp = express();
    driverApp.use(express.json());
    driverApp.use((req, res, next) => {
      req.user = { username: DRIVER_A, role: 'DRIVER' };
      next();
    });
    driverApp.use('/api/driver', require('../routes/api/driver'));
  });

  test('GET /api/driver/customers chỉ trả khách trong khu vực được phân công', async () => {
    const res = await request(driverApp).get('/api/driver/customers');
    expect(res.status).toBe(200);
    const ids = res.body.customers.map((c) => c.id);
    expect(ids).toContain(custInA);
    expect(ids).not.toContain(custInB);
  });

  test('GET /api/driver/sales chỉ trả đơn trong khu vực được phân công', async () => {
    const res = await request(driverApp).get('/api/driver/sales');
    expect(res.status).toBe(200);
    const ids = res.body.sales.map((s) => s.id);
    expect(ids).toContain(saleInA);
    expect(ids).not.toContain(saleInB);
  });

  test('tài xế KHÔNG tạo được đơn giao cho đơn ngoài khu vực', async () => {
    const res = await request(driverApp).post('/api/driver/deliveries').send({ saleId: saleInB });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const created = db
      .prepare('SELECT COUNT(*) AS c FROM delivery_records WHERE sale_id = ? AND driver_username = ?')
      .get(saleInB, DRIVER_A).c;
    expect(created).toBe(0);
  });

  test('tài xế tạo được đơn giao cho đơn trong khu vực', async () => {
    const res = await request(driverApp).post('/api/driver/deliveries').send({ saleId: saleInA });
    expect(res.status).toBeLessThan(400);
    const created = db
      .prepare('SELECT COUNT(*) AS c FROM delivery_records WHERE sale_id = ? AND driver_username = ?')
      .get(saleInA, DRIVER_A).c;
    expect(created).toBe(1);
  });
});

describe('B. Trường khu vực khách hàng', () => {
  test('POST /api/customers với region_id hợp lệ → lưu đúng', async () => {
    const app = buildApp('ADMIN', ADMIN_USER);
    app.use('/api/customers', require('../routes/api/customers'));
    const res = await request(app)
      .post('/api/customers')
      .send({ name: 'RG_TEST_Add', phone: '0900111222', region_id: regionIds.HOA_THANH });
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT region_id FROM customers WHERE id = ?').get(res.body.id);
    expect(row.region_id).toBe(regionIds.HOA_THANH);
  });

  test('POST /api/customers với region_id KHÔNG hợp lệ → 400', async () => {
    const app = buildApp('ADMIN', ADMIN_USER);
    app.use('/api/customers', require('../routes/api/customers'));
    const res = await request(app)
      .post('/api/customers')
      .send({ name: 'RG_TEST_Bad', phone: '0900111333', region_id: 999999 });
    expect(res.status).toBe(400);
  });

  test('PUT /api/customers/:id đổi được khu vực', async () => {
    const app = buildApp('ADMIN', ADMIN_USER);
    app.use('/api/customers', require('../routes/api/customers'));
    const id = createCustomer('RG_TEST_Edit', regionIds.HOA_THANH);
    const res = await request(app).put('/api/customers/' + id).send({ region_id: regionIds.TAN_BIEN });
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT region_id FROM customers WHERE id = ?').get(id);
    expect(row.region_id).toBe(regionIds.TAN_BIEN);
  });

  test('khách hàng legacy (không khu vực) → region_id NULL, không lỗi', () => {
    const id = createCustomer('RG_TEST_Legacy', null);
    const row = db.prepare('SELECT region_id FROM customers WHERE id = ?').get(id);
    expect(row.region_id).toBeNull();
  });

  test('GET /api/customers/:id trả về thông tin khu vực + tài xế phụ trách', async () => {
    RegionService.assignDriver(regionIds.TAN_CHAU, DRIVER_A, { actor: ADMIN_USER });
    const app = buildApp('ADMIN', ADMIN_USER);
    app.use('/api/customers', require('../routes/api/customers'));
    const id = createCustomer('RG_TEST_Detail', regionIds.TAN_CHAU);
    const res = await request(app).get('/api/customers/' + id);
    expect(res.status).toBe(200);
    expect(res.body.region).toBeTruthy();
    expect(res.body.region.id).toBe(regionIds.TAN_CHAU);
    expect(res.body.region.driverUsername).toBe(DRIVER_A);
  });

  test('filter /customers/data theo regionId', async () => {
    const app = buildApp('ADMIN', ADMIN_USER);
    app.use('/customers', require('../routes/customers'));
    const idA = createCustomer('RG_TEST_F_A', regionIds.HOA_THANH);
    createCustomer('RG_TEST_F_B', regionIds.TAN_BIEN);
    const res = await request(app).get('/customers/data?regionId=' + regionIds.HOA_THANH);
    expect(res.status).toBe(200);
    const ids = res.body.customers.map((c) => c.id);
    expect(ids).toContain(idA);
    expect(ids).not.toContain(
      db.prepare("SELECT id FROM customers WHERE name = 'RG_TEST_F_B'").get().id
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L. CHẶN RÒ RỈ KHÁCH HÀNG / GIÁ / CÔNG NỢ QUA API DRIVER
//    (Rule 4: tài xế tự gọi API hoặc đổi tham số URL cũng bị chặn)
// ═══════════════════════════════════════════════════════════════════════════
describe('L. API Driver không lộ dữ liệu ngoài lãnh thổ', () => {
  let driverApp;
  let custInA;
  let custInB;

  beforeEach(() => {
    RegionService.assignDriver(regionIds.HOA_THANH, DRIVER_A, { actor: ADMIN_USER });
    RegionService.assignDriver(regionIds.TAN_BIEN, DRIVER_B, { actor: ADMIN_USER });

    custInA = createCustomer('RG_TEST_LockA', regionIds.HOA_THANH);
    custInB = createCustomer('RG_TEST_LockB', regionIds.TAN_BIEN);

    // Giá riêng cho 2 khách để kiểm tra priceMap bị lọc
    const prod = db.prepare("SELECT id FROM products WHERE archived = 0 LIMIT 1").get();
    if (prod) {
      db.prepare(
        'INSERT OR REPLACE INTO prices (customer_id, product_id, product_slug, price) VALUES (?, ?, ?, ?)'
      ).run(custInA, prod.id, 'rgtest', 11111);
      db.prepare(
        'INSERT OR REPLACE INTO prices (customer_id, product_id, product_slug, price) VALUES (?, ?, ?, ?)'
      ).run(custInB, prod.id, 'rgtest', 99999);
    }

    driverApp = express();
    driverApp.use(express.json());
    driverApp.use((req, res, next) => {
      req.user = { username: DRIVER_A, role: 'DRIVER' };
      next();
    });
    driverApp.use('/api/driver', require('../routes/api/driver'));
    driverApp.use('/api/driver/sale', require('../routes/api/driverSale'));
  });

  test('GET /api/driver/sale/data chỉ trả khách TRONG khu vực phụ trách', async () => {
    const res = await request(driverApp).get('/api/driver/sale/data');
    expect(res.status).toBe(200);
    const ids = res.body.customers.map((c) => c.id);
    expect(ids).toContain(custInA);
    expect(ids).not.toContain(custInB);
  });

  test('GET /api/driver/sale/data KHÔNG lộ priceMap của khách ngoài lãnh thổ', async () => {
    const res = await request(driverApp).get('/api/driver/sale/data');
    expect(res.status).toBe(200);
    expect(res.body.priceMap[custInB]).toBeUndefined();
    expect(res.body.priceMap[custInA]).toBeDefined();
  });

  test('GET /api/driver/sale/history chỉ trả đơn TRONG khu vực phụ trách', async () => {
    const saleInA = createSale(custInA, regionIds.HOA_THANH, DRIVER_A);
    const saleInB = createSale(custInB, regionIds.TAN_BIEN, DRIVER_B);
    const res = await request(driverApp).get('/api/driver/sale/history?limit=100');
    expect(res.status).toBe(200);
    const ids = res.body.sales.map((s) => s.id);
    expect(ids).toContain(saleInA);
    expect(ids).not.toContain(saleInB);
  });

  test('GET /api/driver/customers/:id ngoài lãnh thổ → 403', async () => {
    const res = await request(driverApp).get('/api/driver/customers/' + custInB);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DRIVER_REGION_FORBIDDEN');
  });

  test('GET /api/driver/customers/:id trong lãnh thổ → 200', async () => {
    const res = await request(driverApp).get('/api/driver/customers/' + custInA);
    expect(res.status).toBe(200);
  });

  test('GET /api/driver/prices của khách ngoài lãnh thổ → 403', async () => {
    const res = await request(driverApp).get('/api/driver/prices?customerId=' + custInB);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DRIVER_REGION_FORBIDDEN');
  });

  test('GET /api/driver/debts/:id của khách ngoài lãnh thổ → 403', async () => {
    const res = await request(driverApp).get('/api/driver/debts/' + custInB);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DRIVER_REGION_FORBIDDEN');
  });

  test('GET /api/driver/promotions/overview/:id ngoài lãnh thổ → 403', async () => {
    const res = await request(driverApp).get('/api/driver/promotions/overview/' + custInB);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DRIVER_REGION_FORBIDDEN');
  });

  test('POST /api/driver/customers tạo khách ở khu vực mình → region_id tự gán', async () => {
    const res = await request(driverApp)
      .post('/api/driver/customers')
      .send({ name: 'RG_TEST_CreatedByDriver', phone: '0900555666' });
    expect(res.status).toBe(201);
    const row = db.prepare('SELECT region_id FROM customers WHERE id = ?').get(res.body.id);
    expect(row.region_id).toBe(regionIds.HOA_THANH);
  });

  test('POST /api/driver/customers với regionId ngoài lãnh thổ → 403', async () => {
    const res = await request(driverApp)
      .post('/api/driver/customers')
      .send({ name: 'RG_TEST_CreatedBad', phone: '0900777888', regionId: regionIds.TAN_BIEN });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DRIVER_REGION_FORBIDDEN');
  });

  test('POST /api/driver/payments cho khách ngoài lãnh thổ → 403', async () => {
    const res = await request(driverApp)
      .post('/api/driver/payments')
      .send({ customerId: custInB, amount: 1000 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DRIVER_REGION_FORBIDDEN');
  });

  test('POST /api/driver/replacement cho khách ngoài lãnh thổ → 403', async () => {
    const prod = db.prepare('SELECT id FROM products WHERE archived = 0 LIMIT 1').get();
    const res = await request(driverApp)
      .post('/api/driver/replacement')
      .send({ customer_id: custInB, product_id: prod.id, quantity: 1 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DRIVER_REGION_FORBIDDEN');
  });

  test('GET /api/driver/sales/:id cho đơn gán tài xế KHÁC → 403 DRIVER_SCOPE', async () => {
    const saleInB = createSale(custInB, regionIds.TAN_BIEN, DRIVER_B);
    const res = await request(driverApp).get('/api/driver/sales/' + saleInB);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DRIVER_SCOPE');
  });

  test('GET /api/driver/sales/:id cho đơn CHƯA gán tài xế, ngoài khu vực → 403 DRIVER_REGION_FORBIDDEN', async () => {
    const saleInB = createSale(custInB, regionIds.TAN_BIEN, null);
    const res = await request(driverApp).get('/api/driver/sales/' + saleInB);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DRIVER_REGION_FORBIDDEN');
  });
});
