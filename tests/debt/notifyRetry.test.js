/**
 * DEBT NOTIFY — danh sách tin chưa gửi & gửi lại có xác nhận
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ NGUYÊN TẮC: KHÔNG BAO GIỜ tự động gửi tin vào nhóm Zalo của khách.
 *    `listMissingNotifications` CHỈ ĐỌC & LIỆT KÊ.
 *    `resendNotificationForTx` chỉ gửi khi được gọi tường minh (1 giao dịch).
 *
 * Phạm vi test:
 *  - listMissingNotifications tìm đúng giao dịch thiếu thông báo.
 *  - KHÔNG gửi lại giao dịch đã gửi thành công.
 *  - KHÔNG gửi lại giao dịch có log `failed` cũ (> 1 giờ).
 *  - Số dư trả về đúng (trước / sau).
 */
process.env.NODE_ENV = 'test';

const db = require('../../database');
const DebtLedgerService = require('../../src/services/debt/DebtLedgerService');
const DebtNotifyService = require('../../src/services/debt/DebtNotifyService');
const { TRANSACTION_TYPES } = require('../../src/services/debt/constants');

jest.setTimeout(20000);

// ── Fixture ─────────────────────────────────────────────────────────────────
let seq = 0;
const createdCustomers = [];

function makeCustomer(suffix) {
  seq += 1;
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, debt, archived, created_at, updated_at)
       VALUES (?, '', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(`__NOTIFYRETRY_TEST_${suffix}_${Date.now()}_${seq}`);
  createdCustomers.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function addDebt(customerId, amount) {
  DebtLedgerService.recordTransaction({
    customerId,
    transactionType: TRANSACTION_TYPES.ORDER_DEBT,
    amount,
    direction: 'INCREASE',
    description: 'nợ test notify retry',
    source: 'POS',
  });
}

/** Tạo giao dịch Sepay đã gạch nợ (giả lập trạng thái sau khi settle). */
function makeSettledTx(customerId, amount, debtTxId) {
  const sepayId = `ZZNR${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const info = db
    .prepare(
      `INSERT INTO sepay_transactions
         (sepay_id, content, transfer_type, transfer_amount, transaction_date,
          debt_code, status, customer_id, applied_amount, credit_amount,
          debt_transaction_id, processed_at)
       VALUES (?, 'NHAN TU 1234567890 TRACE 1 ND TEST', 'in', ?, ?, 'KH9999',
               'matched', ?, ?, 0, ?, CURRENT_TIMESTAMP)`
    )
    .run(sepayId, amount, '2026-11-23 10:00:00', customerId, amount, debtTxId);
  return info.lastInsertRowid;
}

/** Bút toán PAYMENT → trả về id bút toán (để gắn vào sepay_transactions). */
function addPayment(customerId, amount) {
  const res = DebtLedgerService.recordTransaction({
    customerId,
    transactionType: TRANSACTION_TYPES.PAYMENT,
    amount,
    direction: 'DECREASE',
    description: 'thanh toán test',
    source: 'POS',
  });
  return res.transactionId;
}

function cleanup() {
  for (const id of createdCustomers) {
    try {
      db.prepare('DELETE FROM debt_notifications WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM sepay_transactions WHERE customer_id = ?').run(id);
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

// ═══════════════════════════════════════════════════════════════════════════
// listMissingNotifications — CHỈ LIỆT KÊ, KHÔNG GỬI
// ═══════════════════════════════════════════════════════════════════════════
describe('listMissingNotifications — không tự động gửi', () => {
  test('giao dịch matched chưa có log payment → được liệt kê', () => {
    const custId = makeCustomer('MISSING');
    addDebt(custId, 500000);
    const debtTxId = addPayment(custId, 500000);
    const txId = makeSettledTx(custId, 500000, debtTxId);

    const result = DebtNotifyService.listMissingNotifications({ lookbackDays: 30 });
    const found = result.items.find((i) => i.txId === txId);
    expect(found).toBeTruthy();
    expect(found.customerId).toBe(custId);
    expect(found.amount).toBe(500000);

    // ⚠️ QUAN TRỌNG: hàm này KHÔNG được tạo log thông báo (không gửi tin).
    const logCount = db
      .prepare('SELECT COUNT(*) AS c FROM debt_notifications WHERE customer_id = ?')
      .get(custId).c;
    expect(logCount).toBe(0);
  });

  test('số dư trả về đúng (trước / sau)', () => {
    const custId = makeCustomer('BAL');
    addDebt(custId, 1000000);
    const debtTxId = addPayment(custId, 400000);
    const txId = makeSettledTx(custId, 400000, debtTxId);

    const result = DebtNotifyService.listMissingNotifications({ lookbackDays: 30 });
    const found = result.items.find((i) => i.txId === txId);
    expect(found).toBeTruthy();
    // balanceAfter = 1.000.000 - 400.000 = 600.000
    expect(found.balanceAfter).toBe(600000);
    // balanceBefore = balanceAfter + applied = 600.000 + 400.000 = 1.000.000
    expect(found.balanceBefore).toBe(1000000);
  });

  test('giao dịch ĐÃ có log sent → không liệt kê', () => {
    const custId = makeCustomer('SENT');
    addDebt(custId, 300000);
    const debtTxId = addPayment(custId, 300000);
    const txId = makeSettledTx(custId, 300000, debtTxId);

    db.prepare(
      `INSERT INTO debt_notifications
         (customer_id, customer_name, channel, event_type, amount,
          applied_amount, balance_after, status, transaction_id, sent_at)
       VALUES (?, (SELECT name FROM customers WHERE id = ?), 'omicall_zalo_personal',
               'payment', 300000, 300000, 0, 'sent', ?, CURRENT_TIMESTAMP)`
    ).run(custId, custId, debtTxId);

    const result = DebtNotifyService.listMissingNotifications({ lookbackDays: 30 });
    expect(result.items.find((i) => i.txId === txId)).toBeFalsy();
  });

  test('giao dịch có log failed CŨ (> 1 giờ) → không liệt kê (tránh spam)', () => {
    const custId = makeCustomer('OLDFAIL');
    addDebt(custId, 200000);
    const debtTxId = addPayment(custId, 200000);
    const txId = makeSettledTx(custId, 200000, debtTxId);

    db.prepare(
      `INSERT INTO debt_notifications
         (customer_id, customer_name, channel, event_type, amount,
          applied_amount, balance_after, status, error, transaction_id, created_at)
       VALUES (?, (SELECT name FROM customers WHERE id = ?), 'omicall_zalo_personal',
               'payment', 200000, 200000, 0, 'failed', 'lỗi cũ', ?,
               datetime('now', '-3 days'))`
    ).run(custId, custId, debtTxId);

    const result = DebtNotifyService.listMissingNotifications({ lookbackDays: 30 });
    expect(result.items.find((i) => i.txId === txId)).toBeFalsy();
  });

  test('giao dịch có log failed MỚI (< 1 giờ) → KHÔNG liệt kê (chống spam)', () => {
    const custId = makeCustomer('NEWFAIL');
    addDebt(custId, 200000);
    const debtTxId = addPayment(custId, 200000);
    const txId = makeSettledTx(custId, 200000, debtTxId);

    db.prepare(
      `INSERT INTO debt_notifications
         (customer_id, customer_name, channel, event_type, amount,
          applied_amount, balance_after, status, error, transaction_id, created_at)
       VALUES (?, (SELECT name FROM customers WHERE id = ?), 'omicall_zalo_personal',
               'payment', 200000, 200000, 0, 'failed', 'lỗi mới', ?,
               datetime('now', '-5 minutes'))`
    ).run(custId, custId, debtTxId);

    const result = DebtNotifyService.listMissingNotifications({ lookbackDays: 30 });
    expect(result.items.find((i) => i.txId === txId)).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resendNotificationForTx — gửi 1 giao dịch (có xác nhận)
// ═══════════════════════════════════════════════════════════════════════════
describe('resendNotificationForTx — gửi lại 1 giao dịch', () => {
  test('txId không hợp lệ → báo lỗi, KHÔNG gửi', async () => {
    const result = await DebtNotifyService.resendNotificationForTx(null);
    expect(result.success).toBe(false);
    expect(result.error).toContain('không hợp lệ');
  });

  test('txId không tồn tại → báo lỗi, KHÔNG gửi', async () => {
    const result = await DebtNotifyService.resendNotificationForTx(999999999);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Không tìm thấy');
  });

  test('khách chưa liên kết nhóm Zalo → KHÔNG gửi nhầm', async () => {
    const custId = makeCustomer('NOGROUP');
    addDebt(custId, 150000);
    const debtTxId = addPayment(custId, 150000);
    const txId = makeSettledTx(custId, 150000, debtTxId);

    const result = await DebtNotifyService.resendNotificationForTx(txId);
    expect(result.success).toBe(false);
    // DISABLED (chưa cấu hình OmiCall) hoặc NO_GROUP (chưa liên kết nhóm).
    expect(['DISABLED', 'NO_GROUP', 'CHANNEL_MISMATCH']).toContain(result.error);
  });
});
