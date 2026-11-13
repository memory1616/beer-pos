/**
 * SỔ CÔNG NỢ GIA HUY — GĐ1: Ledger (unit + integration)
 * ─────────────────────────────────────────────────────────────────────────────
 * Phạm vi test:
 *  - Migration 053: 7 bảng `debt_*` + setting
 *  - DebtLedgerService:
 *      • Ghi bút toán (tăng/giảm) + cập nhật mirror `customers.debt`
 *      • Idempotency key (ghi trùng → không tạo bản ghi mới)
 *      • Chặn thanh toán vượt số dư (quyết định đã chốt)
 *      • Đảo giao dịch (REVERSAL, không xoá bản ghi gốc)
 *      • Điều chỉnh công nợ (ADJUSTMENT)
 *      • Tính balance & breakdown theo công thức
 *  - DebtAccountService:
 *      • Migrate số dư cũ → OPENING_BALANCE (idempotent)
 *  - Toàn vẹn dữ liệu sau mỗi test (mirror == ledger, sum balance == sum tx)
 */
process.env.NODE_ENV = 'test';

const db = require('../../database');
const DebtLedgerService = require('../../src/services/debt/DebtLedgerService');
const DebtAccountService = require('../../src/services/debt/DebtAccountService');
const DebtAuditService = require('../../src/services/debt/DebtAuditService');
const { TRANSACTION_TYPES, SOURCES, REFERENCE_TYPES } = require('../../src/services/debt/constants');

jest.setTimeout(20000);

// ── Fixture helpers ─────────────────────────────────────────────────────────
let custSeq = 0;
const createdCustomers = [];
const createdSales = [];

function makeCustomer(nameSuffix, debt = 0) {
  custSeq += 1;
  const name = `__DEBT_TEST_${nameSuffix}_${Date.now()}_${custSeq}`;
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, debt, archived, created_at, updated_at)
       VALUES (?, '', ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(name, debt);
  createdCustomers.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function makeSale(customerId, total) {
  const info = db
    .prepare(
      `INSERT INTO sales (customer_id, date, total, profit, type, status, payment_status, created_at)
       VALUES (?, date('now'), ?, 0, 'sale', 'completed', 'unpaid', CURRENT_TIMESTAMP)`
    )
    .run(customerId, total);
  createdSales.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

/** Kiểm tra toàn vẹn: mirror `customers.debt` phải khớp ledger. */
function assertIntegrity(customerId) {
  const customer = db.prepare('SELECT debt FROM customers WHERE id = ?').get(customerId);
  const ledger = DebtLedgerService.computeBalance(customerId);
  expect(customer.debt).toBeCloseTo(ledger, 2);

  // Tổng balance từ ledger phải bằng tổng signed của từng bút toán
  const sum = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction='INCREASE' THEN amount ELSE -amount END), 0) s
         FROM debt_transactions WHERE customer_id = ?`
    )
    .get(customerId).s;
  expect(sum).toBeCloseTo(ledger, 2);
}

/** Dọn dữ liệu test (cascade xoá debt_transactions theo customer). */
function cleanup() {
  for (const id of createdSales) {
    try {
      db.prepare('DELETE FROM sales WHERE id = ?').run(id);
    } catch (_) {
      /* ignore */
    }
  }
  for (const id of createdCustomers) {
    try {
      db.prepare('DELETE FROM debt_audit_logs WHERE transaction_id IN (SELECT id FROM debt_transactions WHERE customer_id = ?)').run(id);
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

afterEach(() => {
  cleanup();
});

afterAll(() => {
  cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════
// Migration 053
// ═══════════════════════════════════════════════════════════════════════════
describe('Migration 053 — bảng debt_*', () => {
  test('đủ 7 bảng mới', () => {
    const names = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (
           'debt_accounts','debt_transactions','debt_customer_groups',
           'debt_staff_permissions','debt_audit_logs','debt_processed_events',
           'debt_bridge_events')`
      )
      .all()
      .map((r) => r.name);
    expect(names).toHaveLength(7);
  });

  test('debt_transactions có cột ledger đầy đủ', () => {
    const cols = db.prepare('PRAGMA table_info(debt_transactions)').all().map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'customer_id', 'transaction_type', 'amount', 'direction',
        'balance_before', 'balance_after', 'reference_type', 'reference_id',
        'description', 'created_by', 'source', 'idempotency_key', 'created_at',
      ])
    );
  });

  test('idempotency_key là UNIQUE', () => {
    // UNIQUE khai báo trong CREATE TABLE → sqlite tạo autoindex (sql = null)
    const tableSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='debt_transactions'")
      .get().sql;
    expect(tableSql).toMatch(/idempotency_key\s+TEXT\s+UNIQUE/i);

    const autoIdx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='debt_transactions' AND sql IS NULL"
      )
      .all()
      .map((i) => i.name);
    expect(autoIdx.length).toBeGreaterThan(0);
  });

  test('bảng cũ order_debts / customers / sales / payments KHÔNG bị đụng', () => {
    for (const t of ['order_debts', 'customers', 'sales', 'payments']) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(t);
      expect(row).toBeTruthy();
    }
  });

  test('seed setting cho module sổ công nợ', () => {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'debt_%'").all();
    const keys = rows.map((r) => r.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'debt_command_unit',
        'debt_command_max_amount',
        'debt_partial_delivery_policy',
        'debt_allow_overpayment',
        'debt_zalo_bridge_status',
      ])
    );
    expect(rows.find((r) => r.key === 'debt_command_unit').value).toBe('1000');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DebtLedgerService — ghi bút toán
// ═══════════════════════════════════════════════════════════════════════════
describe('DebtLedgerService — ghi bút toán', () => {
  test('ghi ORDER_DEBT tăng công nợ và mirror customers.debt', () => {
    const cid = makeCustomer('ORDER_DEBT', 0);
    const res = DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 1500000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
      referenceType: REFERENCE_TYPES.ORDER,
      referenceId: '123',
      description: 'Nợ đơn #123',
      createdBy: 'tester',
      source: SOURCES.POS,
      idempotencyKey: 'order_debt:sale:123',
    });

    expect(res.success).toBe(true);
    expect(res.balanceBefore).toBe(0);
    expect(res.balanceAfter).toBe(1500000);
    expect(DebtLedgerService.computeBalance(cid)).toBe(1500000);
    expect(db.prepare('SELECT debt FROM customers WHERE id = ?').get(cid).debt).toBe(1500000);
    assertIntegrity(cid);
  });

  test('ghi PAYMENT giảm công nợ', () => {
    const cid = makeCustomer('PAYMENT', 0);
    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 3000000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
    });
    const pay = DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.PAYMENT,
      amount: 1000000,
      direction: DebtLedgerService.DIRECTION.DECREASE,
      description: 'Thu 1.000.000đ',
    });
    expect(pay.success).toBe(true);
    expect(pay.balanceAfter).toBe(2000000);
    assertIntegrity(cid);
  });

  test('CHẶN thanh toán vượt số dư (quyết định: block overpayment)', () => {
    const cid = makeCustomer('OVERPAY', 0);
    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 1000000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
    });
    const res = DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.PAYMENT,
      amount: 1500000,
      direction: DebtLedgerService.DIRECTION.DECREASE,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/vượt quá công nợ/i);
    expect(DebtLedgerService.computeBalance(cid)).toBe(1000000);
    assertIntegrity(cid);
  });

  test('idempotency: ghi trùng key KHÔNG tạo bản ghi mới', () => {
    const cid = makeCustomer('IDEMPOTENT', 0);
    const opts = {
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 500000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
      idempotencyKey: 'order_debt:sale:999',
    };
    const first = DebtLedgerService.recordTransaction(opts);
    const second = DebtLedgerService.recordTransaction(opts);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(
      db.prepare('SELECT COUNT(*) c FROM debt_transactions WHERE customer_id = ?').get(cid).c
    ).toBe(1);
    expect(DebtLedgerService.computeBalance(cid)).toBe(500000);
    assertIntegrity(cid);
  });

  test('từ chối customerId không tồn tại', () => {
    const res = DebtLedgerService.recordTransaction({
      customerId: 99999999,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 1000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
    });
    expect(res.success).toBe(false);
  });

  test('từ chối amount <= 0', () => {
    const cid = makeCustomer('ZERO', 0);
    const res = DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 0,
      direction: DebtLedgerService.DIRECTION.INCREASE,
    });
    expect(res.success).toBe(false);
  });

  test('từ chối transaction_type không hợp lệ', () => {
    const cid = makeCustomer('BADTYPE', 0);
    const res = DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: 'HACK',
      amount: 1000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
    });
    expect(res.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DebtLedgerService — đảo & điều chỉnh
// ═══════════════════════════════════════════════════════════════════════════
describe('DebtLedgerService — đảo giao dịch & điều chỉnh', () => {
  test('đảo bút toán tăng → tạo REVERSAL, KHÔNG xoá bản ghi gốc', () => {
    const cid = makeCustomer('REVERSE', 0);
    const tx = DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 2000000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
      description: 'Nợ đơn #1',
    });

    const rev = DebtLedgerService.reverseTransaction(tx.transactionId, {
      createdBy: 'admin',
      reason: 'Hủy đơn #1',
    });
    expect(rev.success).toBe(true);
    expect(rev.balanceAfter).toBe(0);

    // Bản ghi gốc vẫn còn
    const rows = db
      .prepare('SELECT transaction_type FROM debt_transactions WHERE customer_id = ?')
      .all(cid)
      .map((r) => r.transaction_type);
    expect(rows).toContain(TRANSACTION_TYPES.ORDER_DEBT);
    expect(rows).toContain(TRANSACTION_TYPES.REVERSAL);
    expect(DebtLedgerService.computeBalance(cid)).toBe(0);
    assertIntegrity(cid);
  });

  test('đảo bút toán giảm → tăng lại công nợ', () => {
    const cid = makeCustomer('REVERSE_PAY', 0);
    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 1000000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
    });
    const pay = DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.PAYMENT,
      amount: 400000,
      direction: DebtLedgerService.DIRECTION.DECREASE,
    });

    const rev = DebtLedgerService.reverseTransaction(pay.transactionId, { createdBy: 'admin' });
    expect(rev.success).toBe(true);
    expect(DebtLedgerService.computeBalance(cid)).toBe(1000000);
    assertIntegrity(cid);
  });

  test('điều chỉnh công nợ tạo bút toán ADJUSTMENT mới', () => {
    const cid = makeCustomer('ADJUST', 0);
    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 1000000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
    });

    const adj = DebtLedgerService.adjust(cid, 250000, {
      createdBy: 'admin',
      reason: 'Sửa chênh lệch',
    });
    expect(adj.success).toBe(true);
    expect(adj.balanceAfter).toBe(1250000);
    expect(
      db.prepare('SELECT COUNT(*) c FROM debt_transactions WHERE customer_id = ?').get(cid).c
    ).toBe(2);
    assertIntegrity(cid);
  });

  test('điều chỉnh âm (giảm nợ) được phép', () => {
    const cid = makeCustomer('ADJUST_NEG', 0);
    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 1000000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
    });
    const adj = DebtLedgerService.adjust(cid, -300000, { createdBy: 'admin' });
    expect(adj.success).toBe(true);
    expect(DebtLedgerService.computeBalance(cid)).toBe(700000);
    assertIntegrity(cid);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Công thức & breakdown
// ═══════════════════════════════════════════════════════════════════════════
describe('DebtLedgerService — công thức balance', () => {
  test('Balance = Opening + ORDER_DEBT + MANUAL_DEBT - PAYMENT + ADJUSTMENTS', () => {
    const cid = makeCustomer('FORMULA', 0);

    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.OPENING_BALANCE,
      amount: 500000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
    });
    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 1000000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
    });
    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.MANUAL_DEBT,
      amount: 250000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
    });
    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.PAYMENT,
      amount: 700000,
      direction: DebtLedgerService.DIRECTION.DECREASE,
    });
    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ADJUSTMENT,
      amount: 50000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
    });

    // 500.000 + 1.000.000 + 250.000 - 700.000 + 50.000 = 1.100.000
    expect(DebtLedgerService.computeBalance(cid)).toBe(1100000);

    const bd = DebtLedgerService.getBalanceBreakdown(cid);
    expect(bd.openingBalance).toBe(500000);
    expect(bd.orderDebt).toBe(1000000);
    expect(bd.manualDebt).toBe(250000);
    expect(bd.payment).toBe(-700000);
    expect(bd.adjustment).toBe(50000);
    expect(bd.balance).toBe(1100000);
    assertIntegrity(cid);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Audit log
// ═══════════════════════════════════════════════════════════════════════════
describe('DebtAuditService — audit log', () => {
  test('mỗi bút toán đều có audit log', () => {
    const cid = makeCustomer('AUDIT', 0);
    const tx = DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 750000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
      createdBy: 'staff_a',
    });

    const logs = db
      .prepare('SELECT * FROM debt_audit_logs WHERE transaction_id = ?')
      .all(tx.transactionId);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].actor_id).toBe('staff_a');
  });

  test('audit log che field nhạy cảm (token/password)', () => {
    const id = DebtAuditService.record({
      action: 'TEST_SENSITIVE',
      actorId: 'x',
      afterData: { token: 'abc', password: 'xyz', amount: 100 },
    });
    const row = db.prepare('SELECT after_data FROM debt_audit_logs WHERE id = ?').get(id);
    expect(row.after_data).toContain('[REDACTED]');
    expect(row.after_data).not.toContain('abc');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DebtAccountService — migrate số dư đầu kỳ
// ═══════════════════════════════════════════════════════════════════════════
describe('DebtAccountService — migrate công nợ đầu kỳ', () => {
  test('migrate customers.debt → OPENING_BALANCE, giữ nguyên customers.debt', () => {
    const cid = makeCustomer('OPENING', 2500000);
    expect(db.prepare('SELECT debt FROM customers WHERE id = ?').get(cid).debt).toBe(2500000);

    const res = DebtAccountService.setOpeningBalance(cid, 2500000, {
      createdBy: 'system:migrate',
      source: SOURCES.MIGRATION,
    });
    expect(res.success).toBe(true);
    expect(res.balanceAfter).toBe(2500000);
    expect(db.prepare('SELECT debt FROM customers WHERE id = ?').get(cid).debt).toBe(2500000);
    assertIntegrity(cid);
  });

  test('migrate CHẠY LẠI không tạo bút toán trùng (idempotent)', () => {
    const cid = makeCustomer('OPENING_IDEM', 1000000);
    DebtAccountService.setOpeningBalance(cid, 1000000, { idempotencyKey: `opening_balance:${cid}` });
    const second = DebtAccountService.setOpeningBalance(cid, 1000000, {
      idempotencyKey: `opening_balance:${cid}`,
    });
    expect(second.duplicate).toBe(true);
    expect(
      db.prepare('SELECT COUNT(*) c FROM debt_transactions WHERE customer_id = ?').get(cid).c
    ).toBe(1);
    expect(DebtLedgerService.computeBalance(cid)).toBe(1000000);
  });

  test('migrateOpeningBalances bỏ qua khách đã có bút toán trong ledger', () => {
    const cid = makeCustomer('MIGRATE_SKIP', 700000);
    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 700000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
    });

    const summary = DebtAccountService.migrateOpeningBalances({ dryRun: true });
    expect(summary.ok).toBe(true);
    // Khách test này KHÔNG được migrate (đã có ledger)
    const hasOpening = db
      .prepare(
        `SELECT COUNT(*) c FROM debt_transactions
          WHERE customer_id = ? AND transaction_type = 'OPENING_BALANCE'`
      )
      .get(cid).c;
    expect(hasOpening).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Idempotency event (webhook lặp / server restart)
// ═══════════════════════════════════════════════════════════════════════════
describe('DebtLedgerService — processed events', () => {
  test('markEventProcessed chỉ trả true 1 lần cho cùng event', () => {
    const eventId = `evt_${Date.now()}`;
    expect(DebtLedgerService.markEventProcessed('ORDER_DELIVERED', eventId)).toBe(true);
    expect(DebtLedgerService.markEventProcessed('ORDER_DELIVERED', eventId)).toBe(false);
    expect(DebtLedgerService.isEventProcessed('ORDER_DELIVERED', eventId)).toBe(true);
  });
});
