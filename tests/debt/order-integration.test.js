/**
 * SỔ CÔNG NỢ GIA HUY — GĐ2: Tích hợp đơn hàng (integration test)
 * ─────────────────────────────────────────────────────────────────────────────
 * Phạm vi test:
 *  1. Ghi nhận đơn hàng DELIVERED
 *  2. KHÔNG ghi nhận đơn chưa Delivered (PENDING / IN_PROGRESS)
 *  3. KHÔNG ghi nhận trùng đơn (giao nhiều lần / webhook lặp)
 *  4. Đơn thanh toán một phần → Amount Customer Owes = còn lại
 *  5. Đơn đã thanh toán đủ → KHÔNG ghi công nợ
 *  6. Hủy đơn sau khi giao → REVERSAL (không xoá bút toán gốc)
 *  7. Sửa đơn sau khi giao → ADJUSTMENT
 *  8. Server restart / xử lý lại event → idempotent
 *  9. Đối soát: đơn DELIVERED thiếu bút toán
 * Kiểm tra toàn vẹn dữ liệu sau mỗi test.
 */
process.env.NODE_ENV = 'test';

const db = require('../../database');
const DebtLedgerService = require('../../src/services/debt/DebtLedgerService');
const DebtOrderIntegration = require('../../src/services/debt/DebtOrderIntegration');
const { TRANSACTION_TYPES, EVENT_TYPES } = require('../../src/services/debt/constants');

jest.setTimeout(20000);

// ── Fixture helpers ─────────────────────────────────────────────────────────
let seq = 0;
const createdCustomers = [];
const createdSales = [];
const createdDeliveries = [];

function makeCustomer() {
  seq += 1;
  const name = `__DEBT_ORDER_${Date.now()}_${seq}`;
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, debt, archived, created_at, updated_at)
       VALUES (?, '', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(name);
  createdCustomers.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

/**
 * Tạo đơn hàng bán chịu.
 * @param {number} customerId
 * @param {number} total
 * @param {object} opts { isCredit, paymentStatus }
 */
function makeSale(customerId, total, opts = {}) {
  const info = db
    .prepare(
      `INSERT INTO sales (customer_id, date, total, profit, type, status, payment_status,
                          delivery_status, is_credit, created_at)
       VALUES (?, date('now'), ?, 0, 'sale', 'completed', ?, ?, ?, CURRENT_TIMESTAMP)`
    )
    .run(
      customerId,
      total,
      opts.paymentStatus || 'unpaid',
      opts.deliveryStatus || null,
      opts.isCredit === false ? 0 : 1
    );
  createdSales.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function makeDelivery(saleId, customerId, status = 'PENDING') {
  const info = db
    .prepare(
      `INSERT INTO delivery_records (sale_id, customer_id, driver_username, status,
                                     scheduled_date, expected_kegs, created_at, updated_at)
       VALUES (?, ?, '__test_driver', ?, date('now'), 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(saleId, customerId, status);
  createdDeliveries.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function assertIntegrity(customerId) {
  const customer = db.prepare('SELECT debt FROM customers WHERE id = ?').get(customerId);
  const ledger = DebtLedgerService.computeBalance(customerId);
  expect(customer.debt).toBeCloseTo(ledger, 2);
}

function cleanup() {
  for (const id of createdDeliveries) {
    try {
      db.prepare('DELETE FROM delivery_events WHERE delivery_id = ?').run(id);
      db.prepare('DELETE FROM delivery_records WHERE id = ?').run(id);
    } catch (_) {
      /* ignore */
    }
  }
  for (const id of createdSales) {
    try {
      db.prepare('DELETE FROM order_debts WHERE sale_id = ?').run(id);
      db.prepare('DELETE FROM debt_audit_logs WHERE transaction_id IN (SELECT id FROM debt_transactions WHERE reference_id = ?)').run(String(id));
      db.prepare('DELETE FROM debt_transactions WHERE reference_id = ?').run(String(id));
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
  createdDeliveries.length = 0;
  createdSales.length = 0;
  createdCustomers.length = 0;
}

afterEach(() => cleanup());
afterAll(() => cleanup());

// ═══════════════════════════════════════════════════════════════════════════
// Test 1 — Ghi nhận đơn hàng DELIVERED
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 1 — ghi nhận đơn hàng DELIVERED', () => {
  test('ghi bút toán ORDER_DEBT khi đơn chuyển sang DELIVERED', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 1500000);

    const res = DebtOrderIntegration.recordOrderDebtOnDelivered(saleId, { actor: 'driver_a' });

    expect(res.success).toBe(true);
    expect(res.skipped).toBe(false);
    expect(res.amountOwed).toBe(1500000);
    expect(res.balanceAfter).toBe(1500000);

    const tx = db
      .prepare("SELECT * FROM debt_transactions WHERE customer_id = ? AND transaction_type = 'ORDER_DEBT'")
      .get(cid);
    expect(tx).toBeTruthy();
    expect(tx.amount).toBe(1500000);
    expect(tx.reference_type).toBe('ORDER');
    expect(tx.reference_id).toBe(String(saleId));
    expect(tx.source).toBe('POS');
    assertIntegrity(cid);
  });

  test('hook onDeliveryStatusChanged ghi nợ khi toStatus = DELIVERED', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 2000000);

    const res = DebtOrderIntegration.onDeliveryStatusChanged({
      saleId,
      fromStatus: 'IN_PROGRESS',
      toStatus: 'DELIVERED',
      actor: 'driver_a',
    });

    expect(res.success).toBe(true);
    expect(res.skipped).toBe(false);
    expect(DebtLedgerService.computeBalance(cid)).toBe(2000000);
    assertIntegrity(cid);
  });

  test('ghi bảng chiếu order_debts để UI cũ hiển thị', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 1200000);
    DebtOrderIntegration.recordOrderDebtOnDelivered(saleId, {});

    const proj = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleId);
    expect(proj).toBeTruthy();
    expect(proj.original_amount).toBe(1200000);
    expect(proj.remaining_amount).toBe(1200000);
    expect(proj.status).toBe('pending');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 2 — KHÔNG ghi nhận đơn chưa Delivered
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 2 — không ghi nhận đơn chưa DELIVERED', () => {
  test.each(['PENDING', 'IN_PROGRESS', 'FAILED', 'DISCREPANCY'])(
    'trạng thái %s → KHÔNG ghi công nợ',
    (status) => {
      const cid = makeCustomer();
      const saleId = makeSale(cid, 1000000);

      const res = DebtOrderIntegration.onDeliveryStatusChanged({
        saleId,
        fromStatus: 'PENDING',
        toStatus: status,
      });

      expect(res.success).toBe(true);
      expect(res.skipped).toBe(true);
      expect(DebtLedgerService.computeBalance(cid)).toBe(0);
      assertIntegrity(cid);
    }
  );

  test('đơn không có khách hàng → bỏ qua', () => {
    const saleId = makeSale(null, 500000, { isCredit: true });
    const res = DebtOrderIntegration.recordOrderDebtOnDelivered(saleId, {});
    expect(res.skipped).toBe(true);
  });

  test('đơn không phải bán chịu → bỏ qua', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 500000, { isCredit: false });
    const res = DebtOrderIntegration.recordOrderDebtOnDelivered(saleId, {});
    expect(res.skipped).toBe(true);
    expect(DebtLedgerService.computeBalance(cid)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 3 — KHÔNG ghi nhận trùng đơn
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 3 — không ghi nhận trùng đơn', () => {
  test('giao nhiều lần → chỉ có 1 bút toán ORDER_DEBT', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 1800000);

    const r1 = DebtOrderIntegration.recordOrderDebtOnDelivered(saleId, {});
    const r2 = DebtOrderIntegration.recordOrderDebtOnDelivered(saleId, {});
    const r3 = DebtOrderIntegration.onDeliveryStatusChanged({
      saleId,
      fromStatus: 'DELIVERED',
      toStatus: 'DELIVERED',
    });

    expect(r1.skipped).toBe(false);
    expect(r2.skipped).toBe(true);
    expect(r3.skipped).toBe(true);

    const count = db
      .prepare("SELECT COUNT(*) c FROM debt_transactions WHERE customer_id = ? AND transaction_type = 'ORDER_DEBT'")
      .get(cid).c;
    expect(count).toBe(1);
    expect(DebtLedgerService.computeBalance(cid)).toBe(1800000);
    assertIntegrity(cid);
  });

  test('webhook lặp (event id trùng) → không ghi lại', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 900000);

    expect(DebtLedgerService.markEventProcessed(EVENT_TYPES.ORDER_DELIVERED, String(saleId))).toBe(true);
    expect(DebtLedgerService.markEventProcessed(EVENT_TYPES.ORDER_DELIVERED, String(saleId))).toBe(false);

    const res = DebtOrderIntegration.recordOrderDebtOnDelivered(saleId, {});
    expect(res.success).toBe(true);
    const count = db
      .prepare("SELECT COUNT(*) c FROM debt_transactions WHERE customer_id = ? AND transaction_type = 'ORDER_DEBT'")
      .get(cid).c;
    expect(count).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 4 — Đơn thanh toán một phần
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 4 — đơn thanh toán một phần', () => {
  test('Amount Customer Owes = tổng đơn - đã trả trước', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 2000000);

    // Khách đã có công nợ trước (số dư > 0) để việc trả trước hợp lệ
    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.OPENING_BALANCE,
      amount: 1000000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
      description: 'Công nợ đầu kỳ',
    });

    // Khách đã trả trước 500.000 cho đơn này (PAYMENT gắn reference ORDER)
    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.PAYMENT,
      amount: 500000,
      direction: DebtLedgerService.DIRECTION.DECREASE,
      referenceType: 'ORDER',
      referenceId: String(saleId),
      description: 'Trả trước 500.000',
    });

    const res = DebtOrderIntegration.recordOrderDebtOnDelivered(saleId, {});
    expect(res.amountOwed).toBe(1500000);
    // Tổng số dư = công nợ đầu kỳ 1.000.000 - 500.000 + 1.500.000
    expect(DebtLedgerService.computeBalance(cid)).toBe(2000000);
    assertIntegrity(cid);
  });

  test('trả trước qua bảng chiếu order_debts.paid_amount cũng được tính', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 3000000);
    db.prepare(
      `INSERT INTO order_debts (sale_id, customer_id, original_amount, paid_amount, remaining_amount, status)
       VALUES (?, ?, ?, 1000000, 2000000, 'partial')`
    ).run(saleId, cid, 3000000);

    const res = DebtOrderIntegration.recordOrderDebtOnDelivered(saleId, {});
    expect(res.amountOwed).toBe(2000000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 5 — Đơn đã thanh toán đủ
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 5 — đơn đã thanh toán đủ', () => {
  test('KHÔNG ghi công nợ khi khách đã trả đủ trước khi giao', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 1000000);

    // Khách có công nợ sẵn 1.000.000 (đầu kỳ) → trả đủ 1.000.000 cho đơn
    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.OPENING_BALANCE,
      amount: 1000000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
      description: 'Công nợ đầu kỳ',
    });
    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.PAYMENT,
      amount: 1000000,
      direction: DebtLedgerService.DIRECTION.DECREASE,
      referenceType: 'ORDER',
      referenceId: String(saleId),
    });

    const res = DebtOrderIntegration.recordOrderDebtOnDelivered(saleId, {});
    expect(res.success).toBe(true);
    expect(res.skipped).toBe(true);
    expect(res.amountOwed).toBe(0);
    expect(DebtLedgerService.computeBalance(cid)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 6 — Hủy đơn sau khi giao
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 6 — hủy đơn sau khi giao', () => {
  test('tạo REVERSAL, giữ nguyên bút toán gốc, số dư về 0', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 2500000);
    DebtOrderIntegration.recordOrderDebtOnDelivered(saleId, {});
    expect(DebtLedgerService.computeBalance(cid)).toBe(2500000);

    const rev = DebtOrderIntegration.reverseOrderDebt(saleId, { actor: 'admin', reason: 'Huỷ đơn' });
    expect(rev.success).toBe(true);
    expect(rev.skipped).toBe(false);
    expect(DebtLedgerService.computeBalance(cid)).toBe(0);

    // Bút toán gốc VẪN CÒN
    const rows = db
      .prepare('SELECT transaction_type FROM debt_transactions WHERE customer_id = ?')
      .all(cid)
      .map((r) => r.transaction_type);
    expect(rows).toContain('ORDER_DEBT');
    expect(rows).toContain('REVERSAL');
    assertIntegrity(cid);
  });

  test('đảo 2 lần → lần 2 bị bỏ qua (chống hoàn trùng)', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 1000000);
    DebtOrderIntegration.recordOrderDebtOnDelivered(saleId, {});

    DebtOrderIntegration.reverseOrderDebt(saleId, {});
    const second = DebtOrderIntegration.reverseOrderDebt(saleId, {});
    expect(second.skipped).toBe(true);
    expect(DebtLedgerService.computeBalance(cid)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 7 — Sửa đơn sau khi giao → ADJUSTMENT
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 7 — điều chỉnh công nợ khi sửa đơn', () => {
  test('tăng tổng đơn → thêm bút toán ADJUSTMENT', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 1000000);
    DebtOrderIntegration.recordOrderDebtOnDelivered(saleId, {});

    db.prepare('UPDATE sales SET total = 1500000 WHERE id = ?').run(saleId);
    const adj = DebtOrderIntegration.adjustOrderDebtAfterChange(saleId, {
      actor: 'admin',
      reason: 'Sửa đơn',
    });

    expect(adj.success).toBe(true);
    expect(adj.diff).toBe(500000);
    expect(DebtLedgerService.computeBalance(cid)).toBe(1500000);

    // Bút toán gốc vẫn còn
    const original = db
      .prepare("SELECT amount FROM debt_transactions WHERE customer_id = ? AND transaction_type = 'ORDER_DEBT'")
      .get(cid);
    expect(original.amount).toBe(1000000);
    assertIntegrity(cid);
  });

  test('giảm tổng đơn → bút toán ADJUSTMENT giảm', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 2000000);
    DebtOrderIntegration.recordOrderDebtOnDelivered(saleId, {});

    db.prepare('UPDATE sales SET total = 1500000 WHERE id = ?').run(saleId);
    const adj = DebtOrderIntegration.adjustOrderDebtAfterChange(saleId, { actor: 'admin' });

    expect(adj.diff).toBe(-500000);
    expect(DebtLedgerService.computeBalance(cid)).toBe(1500000);
    assertIntegrity(cid);
  });

  test('đơn chưa ghi nợ → không điều chỉnh', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 1000000);
    const adj = DebtOrderIntegration.adjustOrderDebtAfterChange(saleId, {});
    expect(adj.skipped).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 8 — Server restart giữa quá trình xử lý
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 8 — chống xử lý lại sau khi server restart', () => {
  test('idempotency_key trong DB bảo đảm không ghi trùng sau restart', () => {
    const cid = makeCustomer();
    const saleId = makeSale(cid, 1750000);

    // Lần 1: ghi bút toán (giả lập trước khi server crash)
    const first = DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 1750000,
      direction: DebtLedgerService.DIRECTION.INCREASE,
      referenceType: 'ORDER',
      referenceId: String(saleId),
      idempotencyKey: DebtOrderIntegration.orderDebtKey(saleId),
    });
    expect(first.success).toBe(true);

    // Lần 2 (sau restart): cùng idempotency key → duplicate, không tạo bản ghi mới
    const second = DebtOrderIntegration.recordOrderDebtOnDelivered(saleId, {});
    expect(second.skipped).toBe(true);

    const count = db
      .prepare("SELECT COUNT(*) c FROM debt_transactions WHERE customer_id = ? AND transaction_type = 'ORDER_DEBT'")
      .get(cid).c;
    expect(count).toBe(1);
    expect(DebtLedgerService.computeBalance(cid)).toBe(1750000);
    assertIntegrity(cid);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 9 — Đối soát: đơn DELIVERED thiếu bút toán
// ═══════════════════════════════════════════════════════════════════════════
describe('Test 9 — đối soát đơn DELIVERED thiếu bút toán', () => {
  test('listDeliveredWithoutDebt phát hiện đơn thiếu bút toán', () => {
    const cid = makeCustomer();
    const saleWithDebt = makeSale(cid, 1000000);
    const saleWithoutDebt = makeSale(cid, 2000000);
    db.prepare("UPDATE sales SET delivery_status = 'DELIVERED' WHERE id = ?").run(saleWithDebt);
    db.prepare("UPDATE sales SET delivery_status = 'DELIVERED' WHERE id = ?").run(saleWithoutDebt);

    DebtOrderIntegration.recordOrderDebtOnDelivered(saleWithDebt, {});

    const missing = DebtOrderIntegration.listDeliveredWithoutDebt(500);
    const ids = missing.map((m) => m.sale_id);
    expect(ids).toContain(saleWithoutDebt);
    expect(ids).not.toContain(saleWithDebt);
  });
});
