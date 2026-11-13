/**
 * SỔ CÔNG NỢ — KPI "Tiền thu hôm nay" / "Nợ phát sinh hôm nay"
 * ─────────────────────────────────────────────────────────────────────────────
 * Phạm vi test (bắt lỗi 2026-11-13):
 *  Khi tạo đơn rồi XOÁ đơn, hệ thống ghi 2 bút toán:
 *     #1 ORDER_DEBT (INCREASE) — phát sinh nợ
 *     #2 REVERSAL  (DECREASE)  — đảo nợ
 *  KPI "Tiền thu hôm nay" trước đây cộng MỌI bút toán DECREASE → nhầm
 *  REVERSAL thành "tiền khách trả" → hiển thị 210.000đ tiền thu dù chưa
 *  khách nào trả đồng nào.
 *
 *  Quy tắc đúng:
 *   Tiền thu hôm nay  = PAYMENT(DECREASE) − REVERSAL(INCREASE)
 *   Nợ phát sinh hôm nay = (ORDER_DEBT|MANUAL_DEBT|ADJUSTMENT)(INCREASE)
 *                          − (ORDER_DEBT|MANUAL_DEBT|ADJUSTMENT)(DECREASE)
 *                          − REVERSAL(DECREASE)
 *
 *  Test dùng đúng công thức SQL của route `/api/debt-ledger/overview` để
 *  đảm bảo code thật khớp với kỳ vọng.
 */
process.env.NODE_ENV = 'test';

const db = require('../../database');
const DebtLedgerService = require('../../src/services/debt/DebtLedgerService');
const DebtOnCreateService = require('../../src/services/debt/DebtOnCreateService');
const DebtPaymentService = require('../../src/services/debt/DebtPaymentService');
const DebtOrderIntegration = require('../../src/services/debt/DebtOrderIntegration');

jest.setTimeout(20000);

// ── Fixture helpers ─────────────────────────────────────────────────────────
let seq = 0;
const createdCustomers = [];
const createdSales = [];

function makeCustomer() {
  seq += 1;
  const name = `__DEBT_KPI_${Date.now()}_${seq}`;
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
       VALUES (?, date('now'), ?, 0, 'sale', 'completed', 'unpaid', NULL, 1,
               CURRENT_TIMESTAMP)`
    )
    .run(customerId, total);
  createdSales.push(info.lastInsertRowid);
  return info.lastInsertRowid;
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

// ── SQL giống hệt route /api/debt-ledger/overview ───────────────────────────
function computeTodayDebt() {
  return db
    .prepare(
      `SELECT COALESCE(SUM(
                CASE
                  WHEN dt.transaction_type = 'REVERSAL' AND dt.direction = 'DECREASE' THEN -dt.amount
                  WHEN dt.transaction_type = 'REVERSAL' THEN 0
                  WHEN dt.direction = 'INCREASE' THEN dt.amount
                  ELSE -dt.amount
                END), 0) AS total
         FROM debt_transactions dt
        WHERE dt.transaction_type IN ('ORDER_DEBT','MANUAL_DEBT','ADJUSTMENT','REVERSAL')
          AND date(dt.created_at) = date(?)`
    )
    .get(db.getVietnamDateStr()).total;
}

function computeTodayPayment() {
  return db
    .prepare(
      `SELECT COALESCE(SUM(
                CASE
                  WHEN dt.transaction_type = 'PAYMENT' AND dt.direction = 'DECREASE' THEN dt.amount
                  WHEN dt.transaction_type = 'REVERSAL' AND dt.direction = 'INCREASE' THEN -dt.amount
                  ELSE 0
                END), 0) AS total
         FROM debt_transactions dt
        WHERE dt.transaction_type IN ('PAYMENT','REVERSAL')
          AND date(dt.created_at) = date(?)`
    )
    .get(db.getVietnamDateStr()).total;
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 1 — Tạo đơn rồi XOÁ đơn → KHÔNG được tính vào tiền thu
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 1 — tạo đơn rồi xoá đơn không tính vào tiền thu', () => {
  test('xoá đơn sau khi tạo → tiền thu hôm nay = 0', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 210000);

    // Tạo đơn → ghi ORDER_DEBT
    DebtOnCreateService.recordDebtOnCreate({
      saleId,
      customerId: cid,
      amount: 210000,
      actor: 'tester',
    });
    expect(DebtLedgerService.computeBalance(cid)).toBe(210000);

    // Xoá đơn → ghi REVERSAL (DECREASE)
    const rev = DebtOrderIntegration.reverseOrderDebt(saleId, { actor: 'tester' });
    expect(rev.success).toBe(true);
    expect(rev.skipped).toBe(false);

    // Số dư về 0
    expect(DebtLedgerService.computeBalance(cid)).toBe(0);

    // ⚠️ Hành vi cũ (bug): tiền thu = 210.000đ dù chưa ai trả tiền
    // ✅ Hành vi đúng: tiền thu = 0
    expect(computeTodayPayment()).toBe(0);
  });

  test('xoá đơn → nợ phát sinh hôm nay = 0 (nợ đã bị đảo)', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 500000);

    DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 500000 });
    DebtOrderIntegration.reverseOrderDebt(saleId, { actor: 'tester' });

    // ORDER_DEBT 500.000 (+) và REVERSAL 500.000 (−) → nợ phát sinh ròng = 0
    expect(computeTodayDebt()).toBe(0);
  });

  test('bút toán sau khi xoá đơn đúng kỳ vọng (2 dòng, đúng chiều)', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 300000);

    DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 300000 });
    DebtOrderIntegration.reverseOrderDebt(saleId, { actor: 'tester' });

    const txs = db
      .prepare(
        `SELECT transaction_type, direction, amount FROM debt_transactions
          WHERE reference_type = 'ORDER' AND reference_id = ? ORDER BY id`
      )
      .all(String(saleId));

    expect(txs).toHaveLength(2);
    expect(txs[0].transaction_type).toBe('ORDER_DEBT');
    expect(txs[0].direction).toBe('INCREASE');
    expect(txs[1].transaction_type).toBe('REVERSAL');
    expect(txs[1].direction).toBe('DECREASE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 2 — Thanh toán thật VẪN được tính vào tiền thu
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 2 — thanh toán thật vẫn tính vào tiền thu', () => {
  test('ghi PAYMENT → tiền thu hôm nay = số tiền khách trả', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 3000000);

    DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 3000000 });

    const pay = DebtPaymentService.recordPayment({
      customerId: cid,
      amount: 1000000,
      user: { username: 'admin', role: 'ADMIN' },
    });
    expect(pay.success).toBe(true);

    expect(computeTodayPayment()).toBe(1000000);
  });

  test('xoá đơn SAU khi đã thu tiền → tiền thu ròng = 0 (đã trả lại tiền khách)', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 2000000);

    DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 2000000 });

    DebtPaymentService.recordPayment({
      customerId: cid,
      amount: 2000000,
      user: { username: 'admin', role: 'ADMIN' },
      saleId,
    });
    expect(computeTodayPayment()).toBe(2000000);

    // Xoá đơn → đảo PAYMENT (REVERSAL INCREASE) → tiền thu ròng về 0
    const rev = DebtOrderIntegration.reverseOrderDebt(saleId, { actor: 'tester' });
    expect(rev.success).toBe(true);

    expect(computeTodayPayment()).toBe(0);
    expect(DebtLedgerService.computeBalance(cid)).toBe(0);
  });

  test('tạo đơn → xoá đơn → thu tiền: chỉ tính phần thu tiền thật', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 400000);

    DebtOnCreateService.recordDebtOnCreate({ saleId, customerId: cid, amount: 400000 });
    DebtOrderIntegration.reverseOrderDebt(saleId, { actor: 'tester' });

    // Khách còn nợ ở đơn khác → thu tiền cho đơn khác
    const sale2 = makeSale(cid, 1000000);
    DebtOnCreateService.recordDebtOnCreate({ saleId: sale2, customerId: cid, amount: 1000000 });

    DebtPaymentService.recordPayment({
      customerId: cid,
      amount: 1000000,
      user: { username: 'admin', role: 'ADMIN' },
    });

    // Chỉ 1.000.000đ thu tiền thật — KHÔNG cộng thêm 400.000đ của đơn đã xoá
    expect(computeTodayPayment()).toBe(1000000);
  });
});
