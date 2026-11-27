/**
 * TEST — Thu tiền mặt của tài xế tại điểm giao (070)
 * ─────────────────────────────────────────────────────────────────────────────
 * Phạm vi:
 *  1. Migration 070: bảng `driver_cash_collections` + settings.
 *  2. DeliveryService.updateCollectedKegs: có thu vỏ → tự chuyển "ĐÃ GIAO".
 *  3. DriverCashService.recordCollection: gạch nợ / trả vượt (CREDIT).
 *  4. Báo cáo tiền mặt đã thu trong ngày (tài xế + quản lý).
 */
process.env.NODE_ENV = 'test';

const db = require('../database');
const DeliveryService = require('../src/services/DeliveryService');
const DriverCashService = require('../src/services/DriverCashService');
const DebtLedgerService = require('../src/services/debt/DebtLedgerService');

jest.setTimeout(20000);

let seq = 0;
const createdCustomers = [];
const createdSales = [];
const createdDeliveries = [];
const createdUsers = [];

function uniq(prefix) {
  seq += 1;
  return prefix + '_' + Date.now() + '_' + seq;
}

function makeCustomer(name) {
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, debt, archived, created_at, updated_at)
       VALUES (?, '', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(name);
  createdCustomers.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function makeDriver(username) {
  const uname = uniq(username);
  db.prepare(
    `INSERT INTO app_users (username, password_hash, full_name, role, active)
     VALUES (?, 'x', ?, 'DRIVER', 1)`
  ).run(uname, uname);
  createdUsers.push(uname);
  return uname;
}

function makeSale(customerId, driverUsername, total) {
  const info = db
    .prepare(
      `INSERT INTO sales (date, type, customer_id, driver_username, total,
                          payment_status, delivery_status, created_at)
       VALUES (datetime('now'), 'sale', ?, ?, ?, 'unpaid', 'PENDING', CURRENT_TIMESTAMP)`
    )
    .run(customerId, driverUsername, total);
  createdSales.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function makeDelivery(saleId, customerId, driverUsername) {
  const info = db
    .prepare(
      `INSERT INTO delivery_records (sale_id, customer_id, driver_username, status,
                                     scheduled_date, expected_kegs, created_at, updated_at)
       VALUES (?, ?, ?, 'PENDING', date('now'), 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(saleId, customerId, driverUsername);
  createdDeliveries.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function addDebt(customerId, amount) {
  DebtLedgerService.recordTransaction({
    customerId,
    transactionType: 'ORDER_DEBT',
    amount,
    direction: 'INCREASE',
    createdBy: 'test',
    source: 'POS',
  });
}

afterAll(() => {
  createdDeliveries.forEach((id) => {
    try { db.prepare('DELETE FROM delivery_events WHERE delivery_id = ?').run(id); } catch (_) {}
    try { db.prepare('DELETE FROM driver_cash_collections WHERE delivery_id = ?').run(id); } catch (_) {}
    try { db.prepare('DELETE FROM delivery_records WHERE id = ?').run(id); } catch (_) {}
  });
  createdSales.forEach((id) => {
    try {
      db.prepare(
        'DELETE FROM debt_transactions WHERE reference_type = ? AND reference_id = ?'
      ).run('ORDER', String(id));
    } catch (_) {}
    try { db.prepare('DELETE FROM order_debts WHERE sale_id = ?').run(id); } catch (_) {}
    try { db.prepare('DELETE FROM sales WHERE id = ?').run(id); } catch (_) {}
  });
  createdCustomers.forEach((id) => {
    try { db.prepare('DELETE FROM debt_transactions WHERE customer_id = ?').run(id); } catch (_) {}
    try { db.prepare('DELETE FROM driver_cash_collections WHERE customer_id = ?').run(id); } catch (_) {}
    try { db.prepare('DELETE FROM customers WHERE id = ?').run(id); } catch (_) {}
  });
  createdUsers.forEach((u) => {
    try { db.prepare('DELETE FROM driver_cash_collections WHERE driver_username = ?').run(u); } catch (_) {}
    try { db.prepare('DELETE FROM app_users WHERE username = ?').run(u); } catch (_) {}
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Migration 070
// ═══════════════════════════════════════════════════════════════════════════
describe('Migration 070 — bảng thu tiền mặt tài xế', () => {
  it('tạo bảng driver_cash_collections', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='driver_cash_collections'")
      .get();
    expect(row).toBeTruthy();
  });

  it('có index theo tài xế + ngày nghiệp vụ', () => {
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index'
          AND name='idx_driver_cash_collections_driver_date'`
      )
      .get();
    expect(row).toBeTruthy();
  });

  it('seed settings tiền mặt', () => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('driver_cash_collection_enabled');
    expect(row).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Auto "ĐÃ GIAO" khi có thu vỏ
// ═══════════════════════════════════════════════════════════════════════════
describe('DeliveryService — thu vỏ tự chuyển ĐÃ GIAO', () => {
  it('collected_kegs > 0 thì status chuyển PENDING → DELIVERED', () => {
    const customerId = makeCustomer(uniq('__CASHAUTO_C'));
    const driver = makeDriver('__CASHAUTO_DRV');
    const saleId = makeSale(customerId, driver, 100000);
    const deliveryId = makeDelivery(saleId, customerId, driver);

    const res = DeliveryService.updateCollectedKegs(deliveryId, driver, 3, {
      user: { username: driver, role: 'DRIVER' },
    });

    expect(res.success).toBe(true);
    expect(res.autoDelivered).toBe(true);
    expect(res.delivery.status).toBe('DELIVERED');
  });

  it('KHÔNG set confirmed_by (tài xế vẫn sửa được số liệu)', () => {
    const customerId = makeCustomer(uniq('__CASHAUTO2_C'));
    const driver = makeDriver('__CASHAUTO2_DRV');
    const saleId = makeSale(customerId, driver, 100000);
    const deliveryId = makeDelivery(saleId, customerId, driver);

    const res = DeliveryService.updateCollectedKegs(deliveryId, driver, 2, {
      user: { username: driver, role: 'DRIVER' },
    });

    expect(res.success).toBe(true);
    expect(res.delivery.confirmed_by || '').toBe('');
    expect(res.delivery.reconciled_at || '').toBe('');
    expect(DeliveryService.hasConfirmedFigures(res.delivery)).toBe(false);
  });

  it('collected_kegs = 0 thì KHÔNG chuyển trạng thái', () => {
    const customerId = makeCustomer(uniq('__CASHAUTO3_C'));
    const driver = makeDriver('__CASHAUTO3_DRV');
    const saleId = makeSale(customerId, driver, 100000);
    const deliveryId = makeDelivery(saleId, customerId, driver);

    const res = DeliveryService.updateCollectedKegs(deliveryId, driver, 0, {
      user: { username: driver, role: 'DRIVER' },
    });

    expect(res.success).toBe(true);
    expect(res.autoDelivered).toBe(false);
    expect(res.delivery.status).toBe('PENDING');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Ghi nhận tiền mặt vào sổ công nợ
// ═══════════════════════════════════════════════════════════════════════════
describe('DriverCashService.recordCollection', () => {
  it('gạch nợ khi khách trả bằng số dư nợ', () => {
    const customerId = makeCustomer(uniq('__CASH1_C'));
    const driver = makeDriver('__CASH1_DRV');
    addDebt(customerId, 200000);

    expect(DebtLedgerService.computeBalance(customerId)).toBe(200000);

    const res = DriverCashService.recordCollection({
      customerId,
      amount: 150000,
      driverUsername: driver,
      note: 'Thu tiền mặt',
      user: { username: driver, role: 'DRIVER' },
    });

    expect(res.success).toBe(true);
    expect(res.appliedAmount).toBe(150000);
    expect(res.creditAmount).toBe(0);
    expect(res.balanceAfter).toBe(50000);
    expect(res.collection.collection_no).toMatch(/^TT-\d{8}-\d{4}$/);
  });

  it('khách trả vượt → phần dư ghi bút toán CREDIT (nộp trước)', () => {
    const customerId = makeCustomer(uniq('__CASH2_C'));
    const driver = makeDriver('__CASH2_DRV');
    addDebt(customerId, 100000);

    const res = DriverCashService.recordCollection({
      customerId,
      amount: 150000,
      driverUsername: driver,
      user: { username: driver, role: 'DRIVER' },
    });

    expect(res.success).toBe(true);
    expect(res.appliedAmount).toBe(100000);
    expect(res.creditAmount).toBe(50000);
    expect(res.balanceAfter).toBe(-50000);

    const creditTx = db
      .prepare(
        `SELECT * FROM debt_transactions
          WHERE customer_id = ? AND transaction_type = 'CREDIT'`
      )
      .get(customerId);
    expect(creditTx).toBeTruthy();
    expect(creditTx.amount).toBe(50000);
  });

  it('không có công nợ → toàn bộ là CREDIT', () => {
    const customerId = makeCustomer(uniq('__CASH3_C'));
    const driver = makeDriver('__CASH3_DRV');

    const res = DriverCashService.recordCollection({
      customerId,
      amount: 50000,
      driverUsername: driver,
      user: { username: driver, role: 'DRIVER' },
    });

    expect(res.success).toBe(true);
    expect(res.appliedAmount).toBe(0);
    expect(res.creditAmount).toBe(50000);
  });

  it('từ chối số tiền không hợp lệ', () => {
    const driver = makeDriver('__CASH4_DRV');
    const res = DriverCashService.recordCollection({
      customerId: 999999999,
      amount: 0,
      driverUsername: driver,
      user: { username: driver, role: 'DRIVER' },
    });
    expect(res.success).toBe(false);
  });

  it('idempotency: gọi lại với cùng key không ghi trùng', () => {
    const customerId = makeCustomer(uniq('__CASH5_C'));
    const driver = makeDriver('__CASH5_DRV');
    const key = 'test-idem-' + Date.now();
    addDebt(customerId, 100000);

    const first = DriverCashService.recordCollection({
      customerId,
      amount: 50000,
      driverUsername: driver,
      idempotencyKey: key,
      user: { username: driver, role: 'DRIVER' },
    });
    const second = DriverCashService.recordCollection({
      customerId,
      amount: 50000,
      driverUsername: driver,
      idempotencyKey: key,
      user: { username: driver, role: 'DRIVER' },
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.duplicate).toBe(true);

    const count = db
      .prepare('SELECT COUNT(*) AS c FROM driver_cash_collections WHERE idempotency_key = ?')
      .get(key);
    expect(count.c).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Báo cáo tiền mặt đã thu
// ═══════════════════════════════════════════════════════════════════════════
describe('DriverCashService — báo cáo tiền mặt', () => {
  it('tổng hợp tiền mặt đã thu trong ngày', () => {
    const customerId = makeCustomer(uniq('__REPORT1_C'));
    const driver = makeDriver('__REPORT1_DRV');
    const date = db.getBusinessDateStr();
    addDebt(customerId, 100000);

    DriverCashService.recordCollection({
      customerId,
      amount: 40000,
      driverUsername: driver,
      user: { username: driver, role: 'DRIVER' },
    });

    const summary = DriverCashService.getDailySummary(driver, date);
    expect(summary.success).toBe(true);
    expect(summary.totalAmount).toBe(40000);
    expect(summary.appliedAmount).toBe(40000);
    expect(summary.collectionCount).toBe(1);
    expect(summary.collections).toHaveLength(1);
  });

  it('tổng hợp quản lý trong ngày', () => {
    const customerId = makeCustomer(uniq('__REPORT2_C'));
    const driver = makeDriver('__REPORT2_DRV');
    const date = db.getBusinessDateStr();
    addDebt(customerId, 100000);

    DriverCashService.recordCollection({
      customerId,
      amount: 60000,
      driverUsername: driver,
      user: { username: driver, role: 'DRIVER' },
    });

    const overview = DriverCashService.getAdminDailyOverview(date);
    expect(overview.success).toBe(true);
    const row = overview.drivers.find((d) => d.driverUsername === driver);
    expect(row).toBeTruthy();
    expect(row.totalAmount).toBe(60000);
    expect(row.collectionCount).toBe(1);
  });

  it('ngày không có thu tiền mặt → tổng = 0', () => {
    const driver = makeDriver('__REPORT3_DRV');
    const summary = DriverCashService.getDailySummary(driver, '2000-01-01');
    expect(summary.success).toBe(true);
    expect(summary.totalAmount).toBe(0);
    expect(summary.collectionCount).toBe(0);
  });
});
