/**
 * SEPAY SMART MATCHING — Gạch nợ thông minh (unit + integration)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh (2026-11-23):
 *  Khách chuyển khoản theo SỐ TÀI KHOẢN (không quét mã QR) → nội dung CK
 *  không có mã KH → giao dịch rơi vào trạng thái `manual` → nhân viên phải
 *  gán khách TAY.
 *
 *  Nội dung thực tế:
 *    "NHAN TU 1988888779779 TRACE 104688 ND BUI TRUONG VAN chuyen tien"
 *
 * Phạm vi test:
 *  - Migration 067: cột `customers.bank_account`, `customers.bank_account_name`,
 *    `sepay_transactions.sender_account/sender_name/match_*`.
 *  - Trích số tài khoản & tên người gửi từ nội dung CK.
 *  - Khớp khách theo 4 chiến lược (mã KH → số TK → tên → số tiền).
 *  - Gạch nợ tự động khi khớp được (không cần gán tay).
 *  - Đăng ký / gỡ số tài khoản của khách.
 *  - Đối soát lại giao dịch đang chờ (resmartMatchPending).
 */
process.env.NODE_ENV = 'test';

const db = require('../../database');
const DebtSepayService = require('../../src/services/debt/DebtSepayService');
const DebtLedgerService = require('../../src/services/debt/DebtLedgerService');
const { TRANSACTION_TYPES } = require('../../src/services/debt/constants');

jest.setTimeout(20000);

// ── Fixture helpers ─────────────────────────────────────────────────────────
let seq = 0;
const createdCustomers = [];
const createdSales = [];

function makeCustomer(nameSuffix) {
  seq += 1;
  const name = `__SEPAYSMART_TEST_${nameSuffix}_${Date.now()}_${seq}`;
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, debt, archived, created_at, updated_at)
       VALUES (?, '', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(name);
  createdCustomers.push(info.lastInsertRowid);
  return { id: info.lastInsertRowid, name };
}

function addDebt(customerId, amount) {
  DebtLedgerService.recordTransaction({
    customerId,
    transactionType: TRANSACTION_TYPES.ORDER_DEBT,
    amount,
    direction: 'INCREASE',
    description: 'nợ test smart match',
    source: 'POS',
  });
}

function makePayload(overrides = {}) {
  return Object.assign(
    {
      id: `ZZSMART${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      gateway: 'VPB',
      transactionDate: '2026-11-23 10:00:00',
      accountNumber: '0933620773',
      content: 'THANH TOAN CONG NO',
      transferType: 'in',
      transferAmount: 100000,
      accumulated: 100000,
      referenceCode: 'FT0001',
    },
    overrides
  );
}

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
      db.prepare('DELETE FROM sepay_transactions WHERE customer_id = ?').run(id);
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
  try {
    db.prepare(`DELETE FROM sepay_transactions WHERE sepay_id LIKE 'ZZSMART%'`).run();
  } catch (_) {
    /* ignore */
  }
  createdSales.length = 0;
  createdCustomers.length = 0;
}

afterEach(() => cleanup());
afterAll(() => cleanup());

// ═══════════════════════════════════════════════════════════════════════════
// Migration 067 — schema
// ═══════════════════════════════════════════════════════════════════════════
describe('Migration 067 — schema gạch nợ thông minh', () => {
  test('customers có cột bank_account & bank_account_name', () => {
    const cols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
    expect(cols).toContain('bank_account');
    expect(cols).toContain('bank_account_name');
  });

  test('sepay_transactions có cột sender_*/match_*', () => {
    const cols = db
      .prepare('PRAGMA table_info(sepay_transactions)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('sender_account');
    expect(cols).toContain('sender_name');
    expect(cols).toContain('match_method');
    expect(cols).toContain('match_confidence');
    expect(cols).toContain('match_candidates');
  });

  test('có setting mặc định cho gạch nợ thông minh', () => {
    expect(DebtSepayService.getSetting('sepay_smart_match_enabled', null)).not.toBeNull();
    expect(DebtSepayService.getSetting('sepay_smart_min_confidence', null)).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Trích xuất thông tin người gửi
// ═══════════════════════════════════════════════════════════════════════════
describe('Trích số tài khoản & tên người gửi', () => {
  const REAL = 'NHAN TU 1988888779779 TRACE 104688 ND BUI TRUONG VAN chuyen tien';

  test('trích đúng số tài khoản từ nội dung thực tế', () => {
    expect(DebtSepayService.extractSenderAccount({ content: REAL })).toBe('1988888779779');
  });

  test('trích đúng tên người gửi từ nội dung thực tế', () => {
    expect(DebtSepayService.extractSenderName({ content: REAL })).toBe('BUI TRUONG VAN');
  });

  test('không trích nhầm mã ngân hàng làm tên người gửi', () => {
    const out = DebtSepayService.extractSenderName({
      content: 'NHAN TU 0671004149757 TRACE 836311 ND MBVCB.17123650534 CHUYEN TIEN',
    });
    expect(out).toBe('');
  });

  test('không trích số tài khoản từ nội dung chỉ có mã KH', () => {
    const content = 'ND 1121 KH0006-211126-18:37:58 6325ASCB02XFGAPD';
    expect(DebtSepayService.extractSenderAccount({ content })).toBe('');
    expect(DebtSepayService.extractDebtCode({ content })).toBe('KH0006');
  });

  test('normalizeAccount bỏ ký tự không phải số', () => {
    expect(DebtSepayService.normalizeAccount('1988 888-779.779')).toBe('1988888779779');
  });

  test('normalizeName bỏ dấu tiếng Việt + uppercase', () => {
    expect(DebtSepayService.normalizeName('Anh Vỹ')).toBe('ANH VY');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Chiến lược khớp khách
// ═══════════════════════════════════════════════════════════════════════════
describe('Chiến lược khớp khách', () => {
  test('chiến lược 1: mã KH trong nội dung (độ tin cậy 1.0)', () => {
    const cust = makeCustomer('CODE');
    const code = DebtSepayService.ensureCustomerDebtCode(cust.id);
    const res = DebtSepayService.smartMatchCustomer({
      content: `ND 1121 ${code}-211126-18:37:58`,
      debt_code: code,
      transfer_amount: 100000,
    });
    expect(res.customer).toBeTruthy();
    expect(res.customer.id).toBe(cust.id);
    expect(res.method).toBe('debt_code');
    expect(res.confidence).toBe(1.0);
  });

  test('chiến lược 2: số tài khoản người gửi khớp KH đã đăng ký (0.95)', () => {
    const cust = makeCustomer('ACC');
    const acc = `19${Date.now()}`.slice(0, 13);
    const set = DebtSepayService.setCustomerBankAccount(cust.id, acc, 'NGUYEN VAN A');
    expect(set.success).toBe(true);

    const res = DebtSepayService.smartMatchCustomer({
      content: `NHAN TU ${acc} TRACE 123456 ND NGUYEN VAN A chuyen tien`,
      sender_account: acc,
      sender_name: 'NGUYEN VAN A',
      transfer_amount: 100000,
    });
    expect(res.customer).toBeTruthy();
    expect(res.customer.id).toBe(cust.id);
    expect(res.method).toBe('bank_account');
    expect(res.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test('chiến lược 3: tên người gửi khớp tên chủ tài khoản', () => {
    const cust = makeCustomer('NAME');
    DebtSepayService.setCustomerBankAccount(cust.id, `88${Date.now()}`.slice(0, 12), 'PHAM THI C');
    const res = DebtSepayService.smartMatchCustomer({
      content: 'NHAN TU 9999999999999 TRACE 999 ND PHAM THI C chuyen tien',
      sender_name: 'PHAM THI C',
      transfer_amount: 100000,
    });
    expect(res.customer).toBeTruthy();
    expect(res.customer.id).toBe(cust.id);
    expect(res.method).toBe('name');
  });

  test('không khớp khi không có tín hiệu nào', () => {
    const res = DebtSepayService.smartMatchCustomer({
      content: 'THANH TOAN CONG NO',
      transfer_amount: 100000,
    });
    expect(res.customer).toBeNull();
    expect(res.method).toBe('');
  });

  test('trả về danh sách ứng viên khi mơ hồ (không tự quyết)', () => {
    const res = DebtSepayService.smartMatchCustomer({
      content: 'ND XYZ ABC',
      sender_name: 'XYZ ABC',
      transfer_amount: 100000,
    });
    expect(res.customer).toBeNull();
    expect(Array.isArray(res.candidates)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Gạch nợ tự động (không cần gán tay)
// ═══════════════════════════════════════════════════════════════════════════
describe('Gạch nợ tự động theo số tài khoản', () => {
  test('giao dịch không có mã KH vẫn được gạch nợ', () => {
    const cust = makeCustomer('SETTLE');
    const acc = `20${Date.now()}`.slice(0, 13);
    DebtSepayService.setCustomerBankAccount(cust.id, acc, 'LE VAN C');
    addDebt(cust.id, 500000);

    const stored = DebtSepayService.storeTransaction(
      makePayload({
        content: `NHAN TU ${acc} TRACE 104688 ND LE VAN C chuyen tien`,
        transferAmount: 500000,
      })
    );
    expect(stored.success).toBe(true);

    const processed = DebtSepayService.processTransaction(stored.transactionId, {
      force: true,
    });
    expect(processed.success).toBe(true);
    expect(processed.customerId).toBe(cust.id);
    expect(processed.applied).toBe(500000);
    expect(processed.matchMethod).toBe('bank_account');

    const tx = db
      .prepare('SELECT status, customer_id, match_method, sender_account FROM sepay_transactions WHERE id = ?')
      .get(stored.transactionId);
    expect(tx.status).toBe('matched');
    expect(tx.customer_id).toBe(cust.id);
    expect(tx.match_method).toBe('bank_account');
    expect(tx.sender_account).toBe(acc);

    const balance = DebtLedgerService.computeBalance(cust.id);
    expect(Math.round(balance)).toBe(0);
  });

  test('giao dịch KHÔNG khớp được vẫn giữ trạng thái manual', () => {
    const stored = DebtSepayService.storeTransaction(
      makePayload({
        content: 'NHAN TU 9999999999999 TRACE 000 ND KHONG TON TAI chuyen tien',
        transferAmount: 100000,
      })
    );
    const processed = DebtSepayService.processTransaction(stored.transactionId, {
      force: true,
    });
    expect(processed.success).toBe(false);
    expect(processed.code).toBe('NO_CUSTOMER_MATCH');

    const tx = db
      .prepare('SELECT status FROM sepay_transactions WHERE id = ?')
      .get(stored.transactionId);
    expect(tx.status).toBe('manual');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Quản lý số tài khoản của khách
// ═══════════════════════════════════════════════════════════════════════════
describe('Quản lý số tài khoản ngân hàng của khách', () => {
  test('lưu & đọc lại số tài khoản', () => {
    const cust = makeCustomer('SAVE');
    const res = DebtSepayService.setCustomerBankAccount(cust.id, '0123456789', 'TEST HOLDER');
    expect(res.success).toBe(true);
    expect(res.accountNumber).toBe('0123456789');

    const row = db
      .prepare('SELECT bank_account, bank_account_name FROM customers WHERE id = ?')
      .get(cust.id);
    expect(row.bank_account).toBe('0123456789');
    expect(row.bank_account_name).toBe('TEST HOLDER');
  });

  test('từ chối số tài khoản không hợp lệ', () => {
    const cust = makeCustomer('INVALID');
    const res = DebtSepayService.setCustomerBankAccount(cust.id, '12', 'X');
    expect(res.success).toBe(false);
  });

  test('từ chối số tài khoản đã thuộc khách khác', () => {
    const a = makeCustomer('DUP_A');
    const b = makeCustomer('DUP_B');
    const acc = '0911223344';
    expect(DebtSepayService.setCustomerBankAccount(a.id, acc, 'A').success).toBe(true);
    const res = DebtSepayService.setCustomerBankAccount(b.id, acc, 'B');
    expect(res.success).toBe(false);
    expect(res.error).toContain('đang thuộc khách');
  });

  test('xoá số tài khoản', () => {
    const cust = makeCustomer('CLEAR');
    DebtSepayService.setCustomerBankAccount(cust.id, '0555666777', 'X');
    expect(DebtSepayService.clearCustomerBankAccount(cust.id).success).toBe(true);
    const row = db.prepare('SELECT bank_account FROM customers WHERE id = ?').get(cust.id);
    expect(row.bank_account).toBeNull();
  });

  test('listCustomerBankAccounts trả về khách đã đăng ký', () => {
    const cust = makeCustomer('LIST');
    DebtSepayService.setCustomerBankAccount(cust.id, '0444555666', 'LIST HOLDER');
    const list = DebtSepayService.listCustomerBankAccounts();
    const found = list.find((r) => r.id === cust.id);
    expect(found).toBeTruthy();
    expect(found.bank_account).toBe('0444555666');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Đối soát lại giao dịch đang chờ
// ═══════════════════════════════════════════════════════════════════════════
describe('Đối soát lại giao dịch đang chờ (resmartMatchPending)', () => {
  test('giao dịch chờ được khớp & gạch sau khi đăng ký số TK', async () => {
    const cust = makeCustomer('REMATCH');
    const acc = `21${Date.now()}`.slice(0, 13);
    addDebt(cust.id, 300000);

    // 1. Giao dịch đến TRƯỚC khi đăng ký số TK → không khớp → manual.
    const stored = DebtSepayService.storeTransaction(
      makePayload({
        content: `NHAN TU ${acc} TRACE 777777 ND REMATCH HOLDER chuyen tien`,
        transferAmount: 300000,
      })
    );
    const processed = DebtSepayService.processTransaction(stored.transactionId, {
      force: true,
    });
    expect(processed.success).toBe(false);

    // 2. Đăng ký số tài khoản → chạy lại đối soát.
    DebtSepayService.setCustomerBankAccount(cust.id, acc, 'REMATCH HOLDER');
    const result = await DebtSepayService.resmartMatchPending({});
    expect(result.scanned).toBeGreaterThan(0);
    expect(result.settled).toBeGreaterThan(0);

    const tx = db
      .prepare('SELECT status, customer_id, match_method FROM sepay_transactions WHERE id = ?')
      .get(stored.transactionId);
    expect(tx.status).toBe('matched');
    expect(tx.customer_id).toBe(cust.id);
  });
});
