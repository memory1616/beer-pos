/**
 * SỔ CÔNG NỢ — Đối soát (DebtReconciliationService)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu: bảo vệ luật "KHÔNG BAO GIỜ XOÁ MẤT CÔNG NỢ" khi chạy đối soát
 * có `apply: true`.
 *
 * Nền tảng của test:
 *  - `customers.debt` (mirror) là CACHE.
 *  - `debt_transactions` (ledger) là SỐ SỰ THẬT.
 *  - Khách CHƯA có bút toán nào → ledger = 0, nhưng mirror có thể là công nợ
 *    THẬT chưa được migrate → tuyệt đối KHÔNG được set mirror về 0.
 */
process.env.NODE_ENV = 'test';

const db = require('../../database');
const DebtLedgerService = require('../../src/services/debt/DebtLedgerService');
const DebtAccountService = require('../../src/services/debt/DebtAccountService');
const DebtReconciliationService = require('../../src/services/debt/DebtReconciliationService');
const { TRANSACTION_TYPES } = require('../../src/services/debt/constants');

jest.setTimeout(20000);

// ── Fixture helpers ─────────────────────────────────────────────────────────
let seq = 0;
const createdCustomers = [];

function makeCustomer(nameSuffix, debt = 0, archived = 0) {
  seq += 1;
  const name = `__RECON_TEST_${nameSuffix}_${Date.now()}_${seq}`;
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, debt, archived, created_at, updated_at)
       VALUES (?, '', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(name, debt, archived);
  createdCustomers.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function mirrorOf(customerId) {
  return db.prepare('SELECT debt FROM customers WHERE id = ?').get(customerId).debt;
}

function cleanup() {
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
  createdCustomers.length = 0;
}

afterEach(() => cleanup());
afterAll(() => cleanup());

describe('DebtReconciliationService — an toàn khi apply', () => {
  test('dry-run KHÔNG ghi gì vào DB', () => {
    const cid = makeCustomer('DRYRUN', 500000);
    const before = mirrorOf(cid);

    const report = DebtReconciliationService.run({ apply: false, actor: 'test' });

    expect(mirrorOf(cid)).toBe(before);
    expect(report.summary.applied).toBe(false);
    expect(report.fixed).toHaveLength(0);
  });

  test('khách CHƯA có bút toán → GIỮ NGUYÊN mirror (KHÔNG set về 0)', () => {
    // Mirror = 2.000.000đ công nợ thật, ledger = 0 (chưa migrate)
    const cid = makeCustomer('NO_LEDGER', 2000000);

    expect(DebtLedgerService.computeBalance(cid)).toBe(0);
    expect(DebtLedgerService.countTransactions(cid)).toBe(0);

    DebtReconciliationService.run({ apply: true, actor: 'test' });

    // Sau khi apply: phải có bút toán OPENING_BALANCE (migrate) VÀ mirror không đổi
    expect(DebtLedgerService.countTransactions(cid)).toBeGreaterThan(0);
    expect(DebtLedgerService.computeBalance(cid)).toBeCloseTo(2000000, 2);
    expect(mirrorOf(cid)).toBeCloseTo(2000000, 2);
  });

  test('khách archive CHƯA có bút toán → vẫn migrate, không mất tiền', () => {
    const cid = makeCustomer('ARCHIVED', 950000, 1);

    DebtReconciliationService.run({ apply: true, actor: 'test' });

    expect(DebtLedgerService.computeBalance(cid)).toBeCloseTo(950000, 2);
    expect(mirrorOf(cid)).toBeCloseTo(950000, 2);
  });

  test('mirror LỆCH ledger ở khách ĐÃ có bút toán → đồng bộ mirror theo ledger', () => {
    const cid = makeCustomer('MISMATCH', 1000000);

    // Tạo bút toán → ledger = 1.000.000, mirror = 1.000.000
    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 1000000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
    });
    expect(mirrorOf(cid)).toBeCloseTo(1000000, 2);

    // Cố tình làm lệch mirror (giả lập legacy code ghi trực tiếp)
    db.prepare('UPDATE customers SET debt = 1234000 WHERE id = ?').run(cid);

    DebtReconciliationService.run({ apply: true, actor: 'test' });

    // Mirror phải được sửa về đúng ledger
    expect(mirrorOf(cid)).toBeCloseTo(DebtLedgerService.computeBalance(cid), 2);
    expect(mirrorOf(cid)).toBeCloseTo(1000000, 2);
  });

  test('apply nhiều lần → idempotent (không nhân bản bút toán)', () => {
    const cid = makeCustomer('IDEMPOTENT', 777000);

    DebtReconciliationService.run({ apply: true, actor: 'test' });
    const after1 = DebtLedgerService.countTransactions(cid);

    DebtReconciliationService.run({ apply: true, actor: 'test' });
    const after2 = DebtLedgerService.countTransactions(cid);

    expect(after2).toBe(after1);
    expect(DebtLedgerService.computeBalance(cid)).toBeCloseTo(777000, 2);
  });

  test('migrateOpeningBalances bỏ qua khách đã có bút toán', () => {
    const cid = makeCustomer('SKIP_MIGRATE', 600000);

    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.MANUAL_DEBT,
      amount: 300000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
    });

    const summary = DebtAccountService.migrateOpeningBalances({ dryRun: true });

    const hasOpening = db
      .prepare(
        `SELECT COUNT(*) c FROM debt_transactions
          WHERE customer_id = ? AND transaction_type = 'OPENING_BALANCE'`
      )
      .get(cid).c;
    expect(hasOpening).toBe(0);
    expect(summary.ok).toBe(true);
  });
});
