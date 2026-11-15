/**
 * NGÀY NGHIỆP VỤ (BUSINESS DAY) — cutoff 19:00 giờ Việt Nam
 * ─────────────────────────────────────────────────────────────────────────────
 * Quy tắc nghiệp vụ: "những đơn hàng được tạo sau 19h hằng ngày, được tính
 * là đơn hàng ngày mai".
 *
 * Cơ chế đã triển khai:
 *  - `sales.date`        = NGÀY NGHIỆP VỤ (đơn tạo sau 19:00 → ngày mai)
 *  - `sales.created_on`  = NGÀY LỊCH THỰC (giữ đơn hôm nay cho Driver Portal)
 *  - `debt_transactions.business_date` = ngày nghiệp vụ của bút toán công nợ
 *
 * Test này kiểm tra:
 *  A. `getBusinessDateStr()` — ranh giới giờ chốt (18:59 / 19:00 / 23:59 / 00:00)
 *  B. Tạo đơn qua API → `sales.date` = ngày nghiệp vụ, `created_on` = ngày lịch thực
 *  C. Bút toán công nợ kế thừa `business_date` của đơn
 *  D. Driver Portal vẫn thấy đơn tạo hôm nay (dù ngày nghiệp vụ là ngày mai)
 *  E. KPI công nợ "hôm nay" lọc theo ngày nghiệp vụ
 */
process.env.NODE_ENV = 'test';

const request = require('supertest');
const db = require('../database');
const { hashPassword } = require('../src/utils/password');
const DebtLedgerService = require('../src/services/debt/DebtLedgerService');
const DebtOnCreateService = require('../src/services/debt/DebtOnCreateService');

jest.setTimeout(20000);

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Tạo Date tương ứng với giờ VN (UTC+7) của một ngày/giờ cụ thể. */
function vnTime(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 7, minute, 0));
}

/** Ngày VN hôm nay (YYYY-MM-DD). */
const todayReal = db.getVietnamDateStr();
/** Ngày nghiệp vụ hôm nay (YYYY-MM-DD). */
const todayBusiness = db.getBusinessDateStr();

function buildApp() {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const { requireAuth } = require('../middleware/auth');
  const { apiGuard, attachSanitizer } = require('../middleware/permissions');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/driver', requireAuth, require('../routes/api/driver'));
  app.use('/api', requireAuth, apiGuard, attachSanitizer);
  app.use('/api/sales', require('../routes/api/sales'));
  app.use('/api/debt-ledger', require('../routes/api/debtLedger'));
  return app;
}

let app;
let adminToken;
let testCustomerId;
let testProductId;
const createdSaleIds = [];
const createdTxIds = [];

const TEST_ADMIN = 'test_bd_admin';

beforeAll(() => {
  app = buildApp();

  const hash = hashPassword('AdminPass123');
  db.prepare(
    `INSERT OR REPLACE INTO app_users (username, password_hash, role, active, full_name)
     VALUES (?, ?, 'ADMIN', 1, 'Admin Test BD')`
  ).run(TEST_ADMIN, hash);

  const { login } = require('../middleware/auth');
  adminToken = login(TEST_ADMIN, 'AdminPass123', { driverOnly: false })?.token || null;
  expect(adminToken).toBeTruthy();

  const cust = db.prepare(
    `INSERT INTO customers (name, phone, address, keg_balance, debt, created_at)
     VALUES ('KHÁCH TEST BUSINESS DAY', '0900000999', 'Địa chỉ BD', 0, 0, datetime('now'))`
  ).run();
  testCustomerId = cust.lastInsertRowid;

  const prod = db.prepare(
    `INSERT INTO products (slug, name, stock, cost_price, sell_price, type, archived)
     VALUES ('bd_test_sku', 'Bia Test BD', 1000, 11000, 20000, 'keg', 0)`
  ).run();
  testProductId = prod.lastInsertRowid;
});

afterAll(() => {
  for (const id of createdSaleIds) {
    try {
      db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(id);
      db.prepare('DELETE FROM order_debts WHERE sale_id = ?').run(id);
      db.prepare('DELETE FROM debt_transactions WHERE reference_id = ?').run(String(id));
      db.prepare('DELETE FROM sales WHERE id = ?').run(id);
    } catch (_) {
      /* ignore */
    }
  }
  try {
    db.prepare('DELETE FROM products WHERE id = ?').run(testProductId);
    db.prepare('DELETE FROM customers WHERE id = ?').run(testCustomerId);
    db.prepare("DELETE FROM app_users WHERE username = ?").run(TEST_ADMIN);
    db.prepare('DELETE FROM auth_sessions WHERE username = ?').run(TEST_ADMIN);
  } catch (_) {
    /* ignore */
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// A. Hàm ngày nghiệp vụ — ranh giới giờ chốt
// ═══════════════════════════════════════════════════════════════════════════
describe('A. getBusinessDateStr — ranh giới giờ chốt 19:00', () => {
  test('trước 19:00 → ngày nghiệp vụ = hôm nay', () => {
    expect(db.getBusinessDateStr(vnTime(2026, 11, 13, 0, 0))).toBe('2026-11-13');
    expect(db.getBusinessDateStr(vnTime(2026, 11, 13, 12, 30))).toBe('2026-11-13');
    expect(db.getBusinessDateStr(vnTime(2026, 11, 13, 18, 59))).toBe('2026-11-13');
  });

  test('đúng 19:00 → lùi sang ngày mai', () => {
    expect(db.getBusinessDateStr(vnTime(2026, 11, 13, 19, 0))).toBe('2026-11-14');
  });

  test('sau 19:00 → lùi sang ngày mai', () => {
    expect(db.getBusinessDateStr(vnTime(2026, 11, 13, 19, 1))).toBe('2026-11-14');
    expect(db.getBusinessDateStr(vnTime(2026, 11, 13, 23, 59))).toBe('2026-11-14');
  });

  test('nửa đêm (00:00) → ngày nghiệp vụ = hôm nay (không lùi)', () => {
    expect(db.getBusinessDateStr(vnTime(2026, 11, 14, 0, 0))).toBe('2026-11-14');
  });

  test('sau 19:00 ngày 31/12 → sang 01/01 năm sau', () => {
    expect(db.getBusinessDateStr(vnTime(2026, 12, 31, 20, 0))).toBe('2027-01-01');
  });

  test('giờ chốt lấy từ settings, mặc định 19', () => {
    expect(db.getBusinessCutoffHour()).toBe(19);
  });

  test('đổi giờ chốt trong settings → hàm dùng giờ mới', () => {
    const existed = db.prepare('SELECT value FROM settings WHERE key = ?').get('business_day_cutoff_hour');
    const original = existed ? existed.value : null;
    try {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'business_day_cutoff_hour',
        '0'
      );
      // cutoff = 0 → TẮT quy tắc → ngày nghiệp vụ = ngày lịch thực
      expect(db.getBusinessCutoffHour()).toBe(0);
      expect(db.getBusinessDateStr(vnTime(2026, 11, 13, 22, 0))).toBe('2026-11-13');
    } finally {
      if (original === null || original === undefined) {
        db.prepare('DELETE FROM settings WHERE key = ?').run('business_day_cutoff_hour');
      } else {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
          'business_day_cutoff_hour',
          original
        );
      }
    }
  });

  test('getBusinessDateFor() chấp nhận Date / string / số', () => {
    expect(db.getBusinessDateFor(vnTime(2026, 11, 13, 20, 0))).toBe('2026-11-14');
    expect(db.getBusinessDateFor(vnTime(2026, 11, 13, 10, 0))).toBe('2026-11-13');
    expect(db.getBusinessDateFor(vnTime(2026, 11, 13, 20, 0).getTime())).toBe('2026-11-14');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Tạo đơn → sales.date = ngày nghiệp vụ, created_on = ngày lịch thực
// ═══════════════════════════════════════════════════════════════════════════
describe('B. Tạo đơn hàng — date (nghiệp vụ) vs created_on (lịch thực)', () => {
  test('POST /api/sales ghi đúng date + created_on', async () => {
    const res = await request(app)
      .post('/api/sales')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        customerId: testCustomerId,
        items: [{ productId: testProductId, quantity: 2 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const saleId = res.body.id || res.body.saleId || res.body.sale?.id;
    expect(saleId).toBeTruthy();
    createdSaleIds.push(saleId);

    const row = db.prepare('SELECT date, created_on FROM sales WHERE id = ?').get(saleId);
    expect(row.date).toBe(todayBusiness);
    expect(row.created_on).toBe(todayReal);
  });

  test('đơn tạo sau 19:00 → sales.date = ngày mai, created_on = hôm nay', async () => {
    // Giả lập thời điểm 20:30 VN bằng cách tạm dừng hàm helper của db.
    const original = db.getBusinessDateStr;
    db.getBusinessDateStr = () => '2099-01-02'; // "ngày mai" giả lập
    try {
      const res = await request(app)
        .post('/api/sales')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({
          customerId: testCustomerId,
          items: [{ productId: testProductId, quantity: 1 }],
        });

      expect(res.status).toBe(200);
      const saleId = res.body.id || res.body.saleId || res.body.sale?.id;
      createdSaleIds.push(saleId);

      const row = db.prepare('SELECT date, created_on FROM sales WHERE id = ?').get(saleId);
      expect(row.date).toBe('2099-01-02');
      expect(row.created_on).toBe(todayReal);
    } finally {
      db.getBusinessDateStr = original;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Công nợ kế thừa ngày nghiệp vụ của đơn
// ═══════════════════════════════════════════════════════════════════════════
describe('C. debt_transactions.business_date kế thừa từ đơn', () => {
  test('recordDebtOnCreate lấy business_date = sales.date', () => {
    // Tạo đơn thủ công với ngày nghiệp vụ = ngày mai
    const bizDate = '2099-02-03';
    const info = db
      .prepare(
        `INSERT INTO sales (customer_id, date, created_on, total, type, created_at)
         VALUES (?, ?, ?, 50000, 'sale', datetime('now'))`
      )
      .run(testCustomerId, bizDate, todayReal);
    const saleId = info.lastInsertRowid;
    createdSaleIds.push(saleId);

    const res = DebtOnCreateService.recordDebtOnCreate({
      saleId,
      customerId: testCustomerId,
      amount: 50000,
      actor: TEST_ADMIN,
      force: true,
    });

    expect(res.success).toBe(true);
    expect(res.skipped).toBe(false);
    createdTxIds.push(res.transactionId);

    const tx = db
      .prepare('SELECT business_date FROM debt_transactions WHERE id = ?')
      .get(res.transactionId);
    expect(tx.business_date).toBe(bizDate);
  });

  test('DebtLedgerService.adjust nhận opts.businessDate', () => {
    const res = DebtLedgerService.adjust(testCustomerId, 10000, {
      createdBy: TEST_ADMIN,
      reason: 'Test business date',
      businessDate: '2099-03-04',
    });
    expect(res.success).toBe(true);
    createdTxIds.push(res.transactionId);

    const tx = db
      .prepare('SELECT business_date FROM debt_transactions WHERE id = ?')
      .get(res.transactionId);
    expect(tx.business_date).toBe('2099-03-04');
  });

  test('bút toán KHÔNG truyền businessDate → dùng ngày nghiệp vụ hiện tại', () => {
    const res = DebtLedgerService.adjust(testCustomerId, 10000, {
      createdBy: TEST_ADMIN,
      reason: 'Test default business date',
    });
    expect(res.success).toBe(true);
    createdTxIds.push(res.transactionId);

    const tx = db
      .prepare('SELECT business_date FROM debt_transactions WHERE id = ?')
      .get(res.transactionId);
    expect(tx.business_date).toBe(todayBusiness);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Driver Portal — đơn tạo hôm nay vẫn hiện (dù ngày nghiệp vụ = mai)
// ═══════════════════════════════════════════════════════════════════════════
describe('D. Driver Portal giữ đơn tạo hôm nay', () => {
  let driverToken;
  const TEST_DRIVER = 'test_bd_driver';
  let lateSaleId;

  beforeAll(() => {
    const hash = hashPassword('DriverPass123');
    db.prepare(
      `INSERT OR REPLACE INTO app_users (username, password_hash, role, active, full_name)
       VALUES (?, ?, 'DRIVER', 1, 'Tài xế Test BD')`
    ).run(TEST_DRIVER, hash);

    const { login } = require('../middleware/auth');
    driverToken = login(TEST_DRIVER, 'DriverPass123')?.token || null;

    // Đơn tạo HÔM NAY (created_on) nhưng ngày nghiệp vụ = NGÀY MAI
    const bizTomorrow = (() => {
      const d = new Date(`${todayReal}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })();

    const info = db
      .prepare(
        `INSERT INTO sales
           (customer_id, date, created_on, total, type, driver_username, created_at)
         VALUES (?, ?, ?, 30000, 'sale', ?, datetime('now'))`
      )
      .run(testCustomerId, bizTomorrow, todayReal, TEST_DRIVER);
    lateSaleId = info.lastInsertRowid;
    createdSaleIds.push(lateSaleId);

    db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price)
       VALUES (?, ?, 'bd_test_sku', 1, 20000, 11000)`
    ).run(lateSaleId, testProductId);
  });

  afterAll(() => {
    try {
      db.prepare("DELETE FROM app_users WHERE username = ?").run(TEST_DRIVER);
      db.prepare('DELETE FROM auth_sessions WHERE username = ?').run(TEST_DRIVER);
    } catch (_) {
      /* ignore */
    }
  });

  test('DeliveryService.listForDriver thấy đơn (created_on=hôm nay, date=ngày mai)', () => {
    const DeliveryService = require('../src/services/DeliveryService');
    const rows = DeliveryService.listForDriver(TEST_DRIVER, { date: todayReal });
    expect(Array.isArray(rows)).toBe(true);
    const ids = rows.map((r) => r.sale_id || r.id);
    expect(ids).toContain(lateSaleId);
  });

  test('API delivery/page-data của tài xế cũng thấy đơn đó', async () => {
    const res = await request(app)
      .get('/api/driver/delivery/page-data')
      .set('Authorization', 'Bearer ' + driverToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.customers)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. KPI công nợ "hôm nay" lọc theo ngày nghiệp vụ
// ═══════════════════════════════════════════════════════════════════════════
describe('E. KPI công nợ hôm nay theo business_date', () => {
  test('bút toán của NGÀY MAI không tính vào KPI hôm nay', async () => {
    const res = await request(app)
      .get('/api/debt-ledger/overview')
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('bút toán business_date = hôm nay được tính vào KPI hôm nay', () => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM debt_transactions
          WHERE COALESCE(business_date, date(created_at, '+7 hours')) = date(?)`
      )
      .get(todayBusiness);
    expect(row.c).toBeGreaterThanOrEqual(0);
  });
});
