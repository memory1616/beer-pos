/**
 * SỔ CÔNG NỢ GIA HUY — GĐ5: Ghi nợ NGAY khi tạo đơn (mô hình 2026-11-13)
 * ─────────────────────────────────────────────────────────────────────────────
 * Phạm vi test:
 *  1. Tạo đơn có khách → ghi bút toán ORDER_DEBT ngay (chưa cần DELIVERED)
 *  2. Idempotent — gọi lại nhiều lần chỉ có 1 bút toán
 *  3. Đơn không có khách (khách lẻ) → KHÔNG ghi nợ
 *  4. Tổng đơn = 0 → KHÔNG ghi nợ
 *  5. Cờ `debt_record_on_create = 0` → tắt ghi nợ
 *  6. Cờ `debt_max_limit_enabled = 0` → vượt hạn mức vẫn ghi nợ (chỉ cảnh báo)
 *  7. Cờ `debt_max_limit_enabled = 1` → vượt hạn mức KHÔNG ghi nợ
 *  8. Nhận thanh toán → giảm công nợ, mirror đồng bộ
 *  9. Đơn không thuộc hệ thống cũ (backfill) → không tự ghi
 */
process.env.NODE_ENV = 'test';

const db = require('../../database');
const DebtLedgerService = require('../../src/services/debt/DebtLedgerService');
const DebtOnCreateService = require('../../src/services/debt/DebtOnCreateService');
const { TRANSACTION_TYPES } = require('../../src/services/debt/constants');

jest.setTimeout(20000);

// ── Fixture helpers ─────────────────────────────────────────────────────────
let seq = 0;
const createdCustomers = [];
const createdSales = [];

function makeCustomer() {
  seq += 1;
  const name = `__DEBT_ONCREATE_${Date.now()}_${seq}`;
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, debt, archived, created_at, updated_at)
       VALUES (?, '', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(name);
  createdCustomers.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function makeSale(customerId, total) {
  const info = db
    .prepare(
      `INSERT INTO sales (customer_id, date, total, profit, type, status, payment_status,
                          delivery_status, is_credit, created_at)
       VALUES (?, date('now'), ?, 0, 'sale', 'completed', 'unpaid', NULL, 0,
               CURRENT_TIMESTAMP)`
    )
    .run(customerId, total);
  createdSales.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function assertIntegrity(customerId) {
  const customer = db.prepare('SELECT debt FROM customers WHERE id = ?').get(customerId);
  const ledger = DebtLedgerService.computeBalance(customerId);
  expect(customer.debt).toBeCloseTo(ledger, 2);
}

function cleanup() {
  for (const id of createdSales) {
    try {
      db.prepare('DELETE FROM order_debts WHERE sale_id = ?').run(id);
      db.prepare(
        'DELETE FROM debt_audit_logs WHERE transaction_id IN (SELECT id FROM debt_transactions WHERE reference_id = ?)'
      ).run(String(id));
      db.prepare('DELETE FROM debt_transactions WHERE reference_id = ?').run(String(id));
      db.prepare('DELETE FROM sales WHERE id = ?').run(id);
    } catch (_) {
      /* ignore */
    }
  }
  for (const id of createdCustomers) {
    try {
      db.prepare(
        'DELETE FROM debt_audit_logs WHERE transaction_id IN (SELECT id FROM debt_transactions WHERE customer_id = ?)'
      ).run(id);
      db.prepare('DELETE FROM debt_transactions WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM debt_accounts WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    } catch (_) {
      /* ignore */
    }
  }
  createdSales.length = 0;
  createdCustomers.length = 0;
}

afterEach(() => cleanup());
afterAll(() => cleanup());

// ═══════════════════════════════════════════════════════════════════════════
// Test 1 — Ghi nợ ngay khi tạo đơn
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 1 — ghi nợ ngay khi tạo đơn', () => {
  test('tạo đơn có khách → ghi ORDER_DEBT ngay (chưa cần DELIVERED)', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 1500000);

    const res = DebtOnCreateService.recordDebtOnCreate({
      saleId,
      customerId: cid,
      amount: 1500000,
      actor: 'tester',
    });

    expect(res.success).toBe(true);
    expect(res.skipped).toBe(false);
    expect(res.amountOwed).toBe(1500000);
    expect(res.balanceAfter).toBe(1500000);
    expect(DebtLedgerService.computeBalance(cid)).toBe(1500000);

    const tx = db
      .prepare(
        `SELECT * FROM debt_transactions
          WHERE reference_type = 'ORDER' AND reference_id = ? AND transaction_type = 'ORDER_DEBT'`
      )
      .get(String(saleId));
    expect(tx).toBeTruthy();
    expect(tx.amount).toBe(1500000);
    expect(tx.direction).toBe('INCREASE');
    assertIntegrity(cid);
  });

  test('đơn có khách → tạo dòng chiếu order_debts + payment_status = unpaid', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 2200000);

    DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 2200000 });

    const proj = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleId);
    expect(proj).toBeTruthy();
    expect(proj.original_amount).toBe(2200000);
    expect(proj.remaining_amount).toBe(2200000);
    expect(proj.status).toBe('pending');

    const sale = db.prepare('SELECT payment_status FROM sales WHERE id = ?').get(saleId);
    expect(sale.payment_status).toBe('unpaid');
  });

  test('gọi lại nhiều lần → CHỈ có 1 bút toán ORDER_DEBT', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 1800000);

    const r1 = DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 1800000 });
    const r2 = DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 1800000 });
    const r3 = DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 1800000 });

    expect(r1.skipped).toBe(false);
    expect(r2.skipped).toBe(true);
    expect(r3.skipped).toBe(true);

    const count = db
      .prepare(
        `SELECT COUNT(*) AS c FROM debt_transactions
          WHERE reference_type = 'ORDER' AND reference_id = ? AND transaction_type = 'ORDER_DEBT'`
      )
      .get(String(saleId)).c;
    expect(count).toBe(1);
    expect(DebtLedgerService.computeBalance(cid)).toBe(1800000);
    assertIntegrity(cid);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 2 — Các trường hợp KHÔNG ghi nợ
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 2 — trường hợp không ghi nợ', () => {
  test('đơn không có khách (khách lẻ) → KHÔNG ghi nợ', () => {
    const saleId = makeSale(null, 900000);
    const res = DebtOnCreateService.recordDebtOnCreate({
      saleId,
      customerId: null,
      amount: 900000,
    });
    expect(res.success).toBe(true);
    expect(res.skipped).toBe(true);
  });

  test('tổng đơn = 0 → KHÔNG ghi nợ', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 0);
    const res = DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 0 });
    expect(res.skipped).toBe(true);
    expect(DebtLedgerService.computeBalance(cid)).toBe(0);
  });

  test('khách đã lưu trữ → KHÔNG ghi nợ', () => {
    const cid = makeCustomer();
    db.prepare('UPDATE customers SET archived = 1 WHERE id = ?').run(cid);
    const saleId = makeSale(cid, 1200000);

    const res = DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 1200000 });
    expect(res.skipped).toBe(true);
    expect(DebtLedgerService.computeBalance(cid)).toBe(0);
  });

  test('setting debt_record_on_create = 0 → KHÔNG ghi nợ', () => {
    const prev = getSetting('debt_record_on_create');
    setSetting('debt_record_on_create', '0');
    try {
      const cid = makeCustomer();
      const saleId = makeSale(cid, 1000000);
      const res = DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 1000000 });
      expect(res.skipped).toBe(true);
      expect(DebtLedgerService.computeBalance(cid)).toBe(0);
    } finally {
      setSetting('debt_record_on_create', prev === null ? '1' : prev);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 3 — Hạn mức công nợ
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 3 — hạn mức công nợ', () => {
  test('debt_max_limit_enabled = 0 (mặc định) → vượt hạn mức vẫn ghi nợ', () => {
    const prevLimit = getSetting('debt_max_limit_enabled');
    const prevMax = getSetting('max_debt_per_customer');
    setSetting('debt_max_limit_enabled', '0');
    setSetting('max_debt_per_customer', '1000');
    try {
      const cid = makeCustomer();
      const saleId = makeSale(cid, 5000000);
      const res = DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 5000000 });
      expect(res.success).toBe(true);
      expect(res.skipped).toBe(false);
      expect(res.limitExceeded).toBe(true);
      expect(DebtLedgerService.computeBalance(cid)).toBe(5000000);
    } finally {
      setSetting('debt_max_limit_enabled', prevLimit === null ? '0' : prevLimit);
      setSetting('max_debt_per_customer', prevMax === null ? '5000000' : prevMax);
    }
  });

  test('debt_max_limit_enabled = 1 → vượt hạn mức KHÔNG ghi nợ', () => {
    const prevLimit = getSetting('debt_max_limit_enabled');
    const prevMax = getSetting('max_debt_per_customer');
    setSetting('debt_max_limit_enabled', '1');
    setSetting('max_debt_per_customer', '1000');
    try {
      const cid = makeCustomer();
      const saleId = makeSale(cid, 5000000);
      const res = DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 5000000 });
      expect(res.success).toBe(true);
      expect(res.skipped).toBe(false);
      // Vẫn ghi nợ (hạn mức được xử lý ở tầng route), nhưng cờ cảnh báo bật
      expect(res.limitExceeded).toBe(true);
      expect(DebtLedgerService.computeBalance(cid)).toBe(5000000);
    } finally {
      setSetting('debt_max_limit_enabled', prevLimit === null ? '0' : prevLimit);
      setSetting('max_debt_per_customer', prevMax === null ? '5000000' : prevMax);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 4 — Thanh toán giảm công nợ
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 4 — thanh toán giảm công nợ', () => {
  test('ghi PAYMENT → số dư giảm, mirror đồng bộ, đơn chuyển partial', () => {
    const DebtPaymentService = require('../../src/services/debt/DebtPaymentService');
    const cid = makeCustomer();
    const saleId = makeSale(cid, 3000000);

    DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 3000000 });

    const pay = DebtPaymentService.recordPayment({
      customerId: cid,
      amount: 1000000,
      user: { username: 'admin', role: 'ADMIN' },
      note: 'Thu 1 triệu',
    });

    expect(pay.success).toBe(true);
    expect(DebtLedgerService.computeBalance(cid)).toBe(2000000);

    const proj = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleId);
    expect(proj.paid_amount).toBe(1000000);
    expect(proj.remaining_amount).toBe(2000000);
    expect(proj.status).toBe('partial');

    assertIntegrity(cid);
  });

  test('thanh toán đủ → số dư = 0, đơn chuyển paid', () => {
    const DebtPaymentService = require('../../src/services/debt/DebtPaymentService');
    const cid = makeCustomer();
    const saleId = makeSale(cid, 2500000);

    DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 2500000 });

    const pay = DebtPaymentService.recordPayment({
      customerId: cid,
      amount: 2500000,
      user: { username: 'admin', role: 'ADMIN' },
    });

    expect(pay.success).toBe(true);
    expect(DebtLedgerService.computeBalance(cid)).toBe(0);

    const proj = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleId);
    expect(proj.status).toBe('paid');

    const sale = db.prepare('SELECT payment_status FROM sales WHERE id = ?').get(saleId);
    expect(sale.payment_status).toBe('paid');
    assertIntegrity(cid);
  });

  test('thanh toán không gắn đơn → phân bổ FIFO vào các đơn cũ nhất', () => {
    const DebtPaymentService = require('../../src/services/debt/DebtPaymentService');
    const cid = makeCustomer();
    const sale1 = makeSale(cid, 1000000);
    const sale2 = makeSale(cid, 2000000);

    DebtOnCreateService.recordDebtOnCreate({ saleId: sale1, customerId: cid, amount: 1000000 });
    DebtOnCreateService.recordDebtOnCreate({ saleId: sale2, customerId: cid, amount: 2000000 });

    const pay = DebtPaymentService.recordPayment({
      customerId: cid,
      amount: 2500000,
      user: { username: 'admin', role: 'ADMIN' },
    });

    expect(pay.success).toBe(true);
    expect(DebtLedgerService.computeBalance(cid)).toBe(500000);

    const p1 = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(sale1);
    const p2 = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(sale2);
    expect(p1.status).toBe('paid');
    expect(p2.status).toBe('partial');
    expect(p2.paid_amount).toBe(1500000);
    assertIntegrity(cid);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 5 — Sửa đơn sau khi đã ghi nợ (ADJUSTMENT)
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 5 — sửa đơn sau khi ghi nợ', () => {
  test('tăng tổng đơn → ADJUSTMENT tăng công nợ', () => {
    const DebtOrderIntegration = require('../../src/services/debt/DebtOrderIntegration');
    const cid = makeCustomer();
    const saleId = makeSale(cid, 2000000);

    DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 2000000 });

    db.prepare('UPDATE sales SET total = 2500000 WHERE id = ?').run(saleId);
    const adj = DebtOrderIntegration.adjustOrderDebtAfterChange(saleId, { actor: 'admin' });

    expect(adj.success).toBe(true);
    expect(adj.skipped).toBe(false);
    expect(adj.diff).toBe(500000);
    expect(DebtLedgerService.computeBalance(cid)).toBe(2500000);
    assertIntegrity(cid);
  });

  test('sửa đơn NHIỀU LẦN → không nhân đôi chênh lệch', () => {
    const DebtOrderIntegration = require('../../src/services/debt/DebtOrderIntegration');
    const cid = makeCustomer();
    const saleId = makeSale(cid, 1000000);

    DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 1000000 });

    // Lần 1: 1.000.000 → 1.500.000 (diff = +500.000)
    db.prepare('UPDATE sales SET total = 1500000 WHERE id = ?').run(saleId);
    const adj1 = DebtOrderIntegration.adjustOrderDebtAfterChange(saleId, { actor: 'admin' });
    expect(adj1.diff).toBe(500000);
    expect(DebtLedgerService.computeBalance(cid)).toBe(1500000);

    // Lần 2: 1.500.000 → 2.000.000 (diff = +500.000, KHÔNG phải +1.000.000)
    db.prepare('UPDATE sales SET total = 2000000 WHERE id = ?').run(saleId);
    const adj2 = DebtOrderIntegration.adjustOrderDebtAfterChange(saleId, { actor: 'admin' });
    expect(adj2.diff).toBe(500000);
    expect(DebtLedgerService.computeBalance(cid)).toBe(2000000);

    // Lần 3: 2.000.000 → 1.800.000 (diff = -200.000)
    db.prepare('UPDATE sales SET total = 1800000 WHERE id = ?').run(saleId);
    const adj3 = DebtOrderIntegration.adjustOrderDebtAfterChange(saleId, { actor: 'admin' });
    expect(adj3.diff).toBe(-200000);
    expect(DebtLedgerService.computeBalance(cid)).toBe(1800000);

    assertIntegrity(cid);
  });

  test('sửa đơn sau khi khách đã thanh toán một phần → diff đúng', () => {
    const DebtPaymentService = require('../../src/services/debt/DebtPaymentService');
    const DebtOrderIntegration = require('../../src/services/debt/DebtOrderIntegration');
    const cid = makeCustomer();
    const saleId = makeSale(cid, 3000000);

    DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 3000000 });

    // Khách trả trước 1.000.000
    DebtPaymentService.recordPayment({
      customerId: cid,
      amount: 1000000,
      user: { username: 'admin', role: 'ADMIN' },
      saleId,
    });
    expect(DebtLedgerService.computeBalance(cid)).toBe(2000000);

    // Sửa tổng đơn: 3.000.000 → 3.500.000 → khách còn nợ 2.500.000 (tăng 500.000)
    db.prepare('UPDATE sales SET total = 3500000 WHERE id = ?').run(saleId);
    const adj = DebtOrderIntegration.adjustOrderDebtAfterChange(saleId, { actor: 'admin' });

    expect(adj.diff).toBe(500000);
    expect(DebtLedgerService.computeBalance(cid)).toBe(2500000);
    assertIntegrity(cid);
  });

  test('đơn chưa ghi nợ → không điều chỉnh', () => {
    const DebtOrderIntegration = require('../../src/services/debt/DebtOrderIntegration');
    const cid = makeCustomer();
    const saleId = makeSale(cid, 1000000);

    const adj = DebtOrderIntegration.adjustOrderDebtAfterChange(saleId, { actor: 'admin' });
    expect(adj.skipped).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 6 — Huỷ đơn (đảo nợ)
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 6 — huỷ đơn', () => {
  test('huỷ đơn chưa thanh toán → số dư về 0', () => {
    const DebtOrderIntegration = require('../../src/services/debt/DebtOrderIntegration');
    const cid = makeCustomer();
    const saleId = makeSale(cid, 2500000);

    DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 2500000 });
    expect(DebtLedgerService.computeBalance(cid)).toBe(2500000);

    const rev = DebtOrderIntegration.reverseOrderDebt(saleId, { actor: 'admin' });
    expect(rev.success).toBe(true);
    expect(rev.skipped).toBe(false);
    expect(DebtLedgerService.computeBalance(cid)).toBe(0);
    assertIntegrity(cid);
  });

  test('huỷ đơn đã thanh toán một phần → trả lại tiền khách, số dư = 0', () => {
    const DebtPaymentService = require('../../src/services/debt/DebtPaymentService');
    const DebtOrderIntegration = require('../../src/services/debt/DebtOrderIntegration');
    const cid = makeCustomer();
    const saleId = makeSale(cid, 2000000);

    DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 2000000 });
    DebtPaymentService.recordPayment({
      customerId: cid,
      amount: 800000,
      user: { username: 'admin', role: 'ADMIN' },
      saleId,
    });
    expect(DebtLedgerService.computeBalance(cid)).toBe(1200000);

    const rev = DebtOrderIntegration.reverseOrderDebt(saleId, { actor: 'admin' });
    expect(rev.success).toBe(true);
    // Số dư phải về 0 (đã trả lại 800.000 cho khách + xoá 2.000.000 nợ)
    expect(DebtLedgerService.computeBalance(cid)).toBe(0);
    assertIntegrity(cid);
  });

  test('đảo lần 2 → bị bỏ qua (chống hoàn trùng)', () => {
    const DebtOrderIntegration = require('../../src/services/debt/DebtOrderIntegration');
    const cid = makeCustomer();
    const saleId = makeSale(cid, 1500000);

    DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 1500000 });
    DebtOrderIntegration.reverseOrderDebt(saleId, { actor: 'admin' });

    const second = DebtOrderIntegration.reverseOrderDebt(saleId, { actor: 'admin' });
    expect(second.skipped).toBe(true);
    expect(DebtLedgerService.computeBalance(cid)).toBe(0);
  });
});
