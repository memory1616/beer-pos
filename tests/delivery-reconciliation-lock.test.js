/**
 * Đối soát phiếu giao hàng 1 lần + khoá số liệu đã xác nhận
 * ─────────────────────────────────────────────────────────────────────────────
 * Nghiệp vụ (2026-11-23):
 *  1. "Mỗi hóa đơn giao hàng chỉ được đối soát một lần."
 *  2. "Không cho sửa số liệu đã xác nhận nếu không có quyền quản lý."
 *
 * Kiểm tra:
 *  - Migration 068 tạo cột `reconciled_at` / `reconciled_by` / `confirmed_by`.
 *  - `confirmDelivery` lần 2 bị chặn (ALREADY_RECONCILED).
 *  - Tài xế KHÔNG sửa được số liệu đã xác nhận (MANAGEMENT_REQUIRED).
 *  - Admin/Manager ĐƯỢC sửa (có `force`).
 *  - `recordDiscrepancy` / `updateCollectedKegs` cũng bị khoá.
 *  - API trả 403 cho tài xế, 409 cho phiếu đã đối soát.
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
  // Server.js mount /api/admin SAU `app.use('/api', optionalAuth, apiGuard, ...)`
  // → req.user được gán từ Authorization header. Test mô phỏng bằng requireAuth.
  app.use('/api/admin', requireAuth, require('../routes/api/admin'));

  return app;
}

let app;

// ── Fixtures ───────────────────────────────────────────────────────────────
const TEST_DRIVER = 'test_recon_driver';
const TEST_ADMIN = 'test_recon_admin';
let driverToken;
let adminToken;
let testCustomerId;
let testProductId;

const PASSWORD = 'ReconPass123';

function makeSale(customerId, driverUsername, total = 100000) {
  const sale = db
    .prepare(
      `INSERT INTO sales (customer_id, total, type, date, created_on, driver_username, archived, deleted)
       VALUES (?, ?, 'sale', date('now'), date('now'), ?, 0, 0)`
    )
    .run(customerId, total, driverUsername);
  const saleId = sale.lastInsertRowid;

  db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, quantity, price)
     VALUES (?, ?, 10, 10000)`
  ).run(saleId, testProductId);

  return saleId;
}

function makeDelivery(saleId, customerId, driverUsername, status = 'PENDING') {
  const rec = db
    .prepare(
      `INSERT INTO delivery_records
         (sale_id, customer_id, driver_username, status, scheduled_date, expected_kegs)
       VALUES (?, ?, ?, ?, date('now'), 10)`
    )
    .run(saleId, customerId, driverUsername, status);
  const deliveryId = rec.lastInsertRowid;

  db.prepare(
    `INSERT INTO delivery_record_items
       (delivery_id, product_id, product_name, expected_quantity, delivered_quantity)
     VALUES (?, ?, 'Bia Test', 10, 0)`
  ).run(deliveryId, testProductId);

  return deliveryId;
}

function cleanupDelivery(deliveryId) {
  try {
    db.prepare('DELETE FROM delivery_record_items WHERE delivery_id = ?').run(deliveryId);
    db.prepare('DELETE FROM delivery_events WHERE delivery_id = ?').run(deliveryId);
    db.prepare('DELETE FROM delivery_records WHERE id = ?').run(deliveryId);
  } catch (_) {
    // best-effort dọn dẹp fixture
  }
}

beforeAll(() => {
  app = buildApp();

  const hash = hashPassword(PASSWORD);
  db.prepare(
    `INSERT OR REPLACE INTO app_users (username, password_hash, role, active, full_name)
     VALUES (?, ?, 'DRIVER', 1, 'Tài xế Recon Test')`
  ).run(TEST_DRIVER, hash);
  db.prepare(
    `INSERT OR REPLACE INTO app_users (username, password_hash, role, active, full_name)
     VALUES (?, ?, 'ADMIN', 1, 'Admin Recon Test')`
  ).run(TEST_ADMIN, hash);

  const cust = db
    .prepare(
      `INSERT INTO customers (name, phone, address, keg_balance, debt, created_at)
       VALUES ('KHÁCH TEST RECON', '0900000011', 'Địa chỉ recon', 0, 0, datetime('now'))`
    )
    .run();
  testCustomerId = cust.lastInsertRowid;

  const prod = db
    .prepare(
      `INSERT INTO products (slug, name, stock, cost_price, sell_price, type, archived)
       VALUES ('test_recon_sku', 'Bia Recon Test', 1000, 11000, 20000, 'keg', 0)`
    )
    .run();
  testProductId = prod.lastInsertRowid;

  const { login } = require('../middleware/auth');
  driverToken = login(TEST_DRIVER, PASSWORD, { driverOnly: true })?.token;
  adminToken = login(TEST_ADMIN, PASSWORD)?.token;
  if (!adminToken) {
    throw new Error(
      'Không đăng nhập được tài khoản ADMIN test — kiểm tra app_users.role'
    );
  }
});

afterAll(() => {
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
  } catch (_) {
    // best-effort dọn dẹp fixture
  }
  try {
    db.prepare(
      `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE customer_id = ?)`
    ).run(testCustomerId);
    db.prepare('DELETE FROM sales WHERE customer_id = ?').run(testCustomerId);
  } catch (_) {
    // best-effort dọn dẹp fixture
  }
  try {
    db.prepare('DELETE FROM products WHERE id = ?').run(testProductId);
    db.prepare('DELETE FROM customers WHERE id = ?').run(testCustomerId);
    db.prepare('DELETE FROM auth_sessions WHERE username IN (?, ?)').run(TEST_DRIVER, TEST_ADMIN);
    db.prepare('DELETE FROM app_users WHERE username IN (?, ?)').run(TEST_DRIVER, TEST_ADMIN);
  } catch (_) {
    // best-effort dọn dẹp fixture
  }
});

// ═══════════════════════════════════════════════════════════════════════════
describe('A. Migration 068 — cột khoá đối soát', () => {
  test('delivery_records có cột reconciled_at / reconciled_by / confirmed_by', () => {
    const cols = db.prepare('PRAGMA table_info(delivery_records)').all().map((c) => c.name);
    expect(cols).toContain('reconciled_at');
    expect(cols).toContain('reconciled_by');
    expect(cols).toContain('confirmed_by');
  });

  test('migration chạy lại không lỗi (idempotent)', () => {
    const migration = require('../database/migrations/068_delivery_reconciliation_lock');
    expect(() => migration.up(db)).not.toThrow();
    expect(() => migration.up(db)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('B. Đối soát mỗi phiếu CHỈ 1 LẦN', () => {
  test('confirmDelivery lần 1 thành công + đánh dấu reconciled_at', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER);

    const result = DeliveryService.confirmDelivery(
      deliveryId,
      TEST_DRIVER,
      { items: [], collectedKegs: 8 }
    );

    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();

    const state = DeliveryService.getReconciliationState(deliveryId);
    expect(state.reconciled).toBe(true);
    expect(state.reconciledAt).toBeTruthy();
    expect(state.reconciledBy).toBe(TEST_DRIVER);

    cleanupDelivery(deliveryId);
  });

  test('confirmDelivery lần 2 bị chặn (ALREADY_RECONCILED)', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER);

    const first = DeliveryService.confirmDelivery(deliveryId, TEST_DRIVER, {
      items: [],
      collectedKegs: 8,
    });
    expect(first.success).toBe(true);

    const second = DeliveryService.confirmDelivery(deliveryId, TEST_DRIVER, {
      items: [],
      collectedKegs: 99, // cố ghi đè số liệu
    });
    expect(second.success).toBe(false);
    expect(second.code).toBe('ALREADY_RECONCILED');
    expect(second.error).toMatch(/đối soát/i);

    // Số liệu KHÔNG bị đổi
    const rec = db.prepare('SELECT collected_kegs FROM delivery_records WHERE id = ?').get(deliveryId);
    expect(rec.collected_kegs).toBe(8);

    cleanupDelivery(deliveryId);
  });

  test('markReconciled là idempotent — giữ dấu vết lần đầu', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER);

    const r1 = DeliveryService.markReconciled(deliveryId, TEST_DRIVER);
    expect(r1.success).toBe(true);
    expect(r1.alreadyReconciled).toBe(false);

    const r2 = DeliveryService.markReconciled(deliveryId, 'someone_else');
    expect(r2.success).toBe(true);
    expect(r2.alreadyReconciled).toBe(true);
    expect(r2.reconciledAt).toBe(r1.reconciledAt);
    expect(r2.reconciledBy).toBe(TEST_DRIVER);

    cleanupDelivery(deliveryId);
  });

  test('recordDiscrepancy bị chặn khi phiếu đã đối soát', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER);

    DeliveryService.markReconciled(deliveryId, TEST_DRIVER);

    const result = DeliveryService.recordDiscrepancy(deliveryId, TEST_DRIVER, {
      missingLiters: 5,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('ALREADY_RECONCILED');

    cleanupDelivery(deliveryId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('C. Khoá số liệu đã xác nhận — cần quyền quản lý', () => {
  // Helper: đánh dấu phiếu đã có số liệu xác nhận (giống hệ thống khi
  // tài xế bấm "Xác nhận giao" → ghi `confirmed_by`).
  function markConfirmed(deliveryId, by = TEST_DRIVER) {
    db.prepare(`UPDATE delivery_records SET confirmed_by = ? WHERE id = ?`).run(by, deliveryId);
  }

  test('tài xế KHÔNG sửa được phiếu đã xác nhận số liệu', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, 'DELIVERED');
    markConfirmed(deliveryId);

    const result = DeliveryService.confirmDelivery(deliveryId, TEST_DRIVER, {
      items: [],
      collectedKegs: 12,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('MANAGEMENT_REQUIRED');

    cleanupDelivery(deliveryId);
  });

  test('tài xế KHÔNG sửa được phiếu đã đối soát', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, 'DISCREPANCY');
    DeliveryService.markReconciled(deliveryId, TEST_DRIVER);

    const result = DeliveryService.confirmDelivery(deliveryId, TEST_DRIVER, {
      items: [],
      collectedKegs: 3,
    });
    expect(result.success).toBe(false);
    // Đã đối soát → thông báo "đối soát 1 lần" (có tính rõ hơn).
    expect(result.code).toBe('ALREADY_RECONCILED');

    cleanupDelivery(deliveryId);
  });

  test('phiếu CHƯA xác nhận số liệu (chỉ bấm Xong) → tài xế ghi sai lệch được', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, 'DELIVERED');
    // KHÔNG có confirmed_by / reconciled_at → chưa có số liệu xác nhận.

    const result = DeliveryService.recordDiscrepancy(
      deliveryId,
      TEST_DRIVER,
      { missingLiters: 5 },
      { user: { username: TEST_DRIVER, role: 'DRIVER' } }
    );
    expect(result.success).toBe(true);
    expect(result.delivery.status).toBe('DISCREPANCY');

    cleanupDelivery(deliveryId);
  });

  test('tài xế KHÔNG đổi được trạng thái phiếu đã có số liệu xác nhận', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, 'DELIVERED');
    markConfirmed(deliveryId);

    const result = DeliveryService.updateStatus(deliveryId, 'DISCREPANCY', TEST_DRIVER, {
      user: { username: TEST_DRIVER, role: 'DRIVER' },
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('MANAGEMENT_REQUIRED');

    cleanupDelivery(deliveryId);
  });

  test('tài xế KHÔNG sửa được số vỏ thu của phiếu đã xác nhận', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, 'DELIVERED');
    markConfirmed(deliveryId);

    const result = DeliveryService.updateCollectedKegs(deliveryId, TEST_DRIVER, 20, {
      user: { username: TEST_DRIVER, role: 'DRIVER' },
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('MANAGEMENT_REQUIRED');

    cleanupDelivery(deliveryId);
  });

  test('phiếu CHƯA xác nhận → tài xế sửa được bình thường', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, 'IN_PROGRESS');

    const result = DeliveryService.confirmDelivery(
      deliveryId,
      TEST_DRIVER,
      { items: [], collectedKegs: 4 },
      { user: { username: TEST_DRIVER, role: 'DRIVER' } }
    );
    expect(result.success).toBe(true);

    cleanupDelivery(deliveryId);
  });

  test('quản lý (ADMIN) ĐƯỢC sửa số liệu đã xác nhận', () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, 'DELIVERED');
    markConfirmed(deliveryId);

    const result = DeliveryService.confirmDelivery(
      deliveryId,
      TEST_DRIVER,
      { items: [], collectedKegs: 15 },
      { user: { username: TEST_ADMIN, role: 'ADMIN' }, force: true }
    );
    expect(result.success).toBe(true);

    const rec = db.prepare('SELECT collected_kegs FROM delivery_records WHERE id = ?').get(deliveryId);
    expect(rec.collected_kegs).toBe(15);

    cleanupDelivery(deliveryId);
  });

  test('hasManagementRole nhận diện đúng ADMIN / MANAGER / DRIVER', () => {
    expect(DeliveryService.hasManagementRole({ role: 'ADMIN' })).toBe(true);
    expect(DeliveryService.hasManagementRole({ role: 'MANAGER' })).toBe(true);
    expect(DeliveryService.hasManagementRole({ role: 'DRIVER' })).toBe(false);
    expect(DeliveryService.hasManagementRole({ role: 'STAFF' })).toBe(false);
    expect(DeliveryService.hasManagementRole(null)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('D. API — mã lỗi & phân quyền', () => {
  test('POST /api/driver/deliveries/:id/confirm lần 2 → 409', async () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER);

    const first = await request(app)
      .post(`/api/driver/deliveries/${deliveryId}/confirm`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ items: [], collectedKegs: 6 });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/driver/deliveries/${deliveryId}/confirm`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ items: [], collectedKegs: 20 });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ALREADY_RECONCILED');

    cleanupDelivery(deliveryId);
  });

  test('POST /api/driver/deliveries/:id/confirm trên phiếu đã xác nhận số liệu → 403', async () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, 'DELIVERED');
    // Đánh dấu đã có số liệu xác nhận (giống hệ thống khi tài xế bấm
    // "Xác nhận giao" → ghi `confirmed_by`).
    db.prepare(`UPDATE delivery_records SET confirmed_by = ? WHERE id = ?`).run(
      TEST_DRIVER,
      deliveryId
    );

    const res = await request(app)
      .post(`/api/driver/deliveries/${deliveryId}/confirm`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ items: [], collectedKegs: 7 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MANAGEMENT_REQUIRED');

    cleanupDelivery(deliveryId);
  });

  test('PUT /api/admin/deliveries/:id/confirm — admin sửa được phiếu đã xác nhận', async () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER, 'DELIVERED');
    db.prepare(`UPDATE delivery_records SET confirmed_by = ? WHERE id = ?`).run(
      TEST_DRIVER,
      deliveryId
    );

    const res = await request(app)
      .put(`/api/admin/deliveries/${deliveryId}/confirm`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [], collectedKegs: 11 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const rec = db.prepare('SELECT collected_kegs FROM delivery_records WHERE id = ?').get(deliveryId);
    expect(rec.collected_kegs).toBe(11);

    cleanupDelivery(deliveryId);
  });

  test('GET /api/admin/deliveries/reconciliation — admin xem được danh sách', async () => {
    const saleId = makeSale(testCustomerId, TEST_DRIVER);
    const deliveryId = makeDelivery(saleId, testCustomerId, TEST_DRIVER);
    DeliveryService.markReconciled(deliveryId, TEST_DRIVER);

    const res = await request(app)
      .get('/api/admin/deliveries/reconciliation')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.deliveries)).toBe(true);

    cleanupDelivery(deliveryId);
  });

  test('API admin bị từ chối khi không đăng nhập → 401', async () => {
    const res = await request(app).get('/api/admin/deliveries/reconciliation');
    expect(res.status).toBe(401);
  });
});
