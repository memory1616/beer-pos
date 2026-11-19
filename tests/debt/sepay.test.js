/**
 * SEPAY — Gạch nợ công nợ tự động (unit + integration)
 * ─────────────────────────────────────────────────────────────────────────────
 * Phạm vi test:
 *  - Migration 061: bảng `sepay_transactions`, `sepay_settings`, cột
 *    `customers.debt_code`, loại bút toán `CREDIT`.
 *  - DebtSepayService:
 *      • Trích mã khách từ nội dung chuyển khoản (KHxxxx / prefix tùy chọn)
 *      • Sinh & gán mã khách (`debt_code`), không trùng lặp
 *      • Trả ĐÚNG số nợ → gạch hết, số dư = 0
 *      • Trả THIẾU → gạch một phần (FIFO), phần còn nợ giữ nguyên
 *      • Trả DƯ → gạch hết + ghi CREDIT (tiền khách nợ lại, số dư âm)
 *      • Idempotency: webhook retry KHÔNG gạch 2 lần
 *      • Không khớp khách → giữ trạng thái `manual`
 *      • Giao dịch tiền ra → bỏ qua
 *      • Phân bổ FIFO vào `order_debts`
 *      • Gán khách thủ công → gạch nợ
 *  - Xác thực webhook HMAC-SHA256.
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
  const name = `__SEPAY_TEST_${nameSuffix}_${Date.now()}_${seq}`;
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, debt, archived, created_at, updated_at)
       VALUES (?, '', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(name);
  createdCustomers.push(info.lastInsertRowid);
  const code = DebtSepayService.ensureCustomerDebtCode(info.lastInsertRowid);
  return { id: info.lastInsertRowid, code };
}

function makeSale(customerId, total, dateStr) {
  const info = db
    .prepare(
      `INSERT INTO sales (customer_id, date, total, profit, type, status, payment_status, created_at)
       VALUES (?, ?, ?, 0, 'sale', 'completed', 'unpaid', CURRENT_TIMESTAMP)`
    )
    .run(customerId, dateStr || '2026-11-01', total);
  createdSales.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

/** Ghi nợ cho khách (ORDER_DEBT). */
function addDebt(customerId, amount) {
  DebtLedgerService.recordTransaction({
    customerId,
    transactionType: TRANSACTION_TYPES.ORDER_DEBT,
    amount,
    direction: 'INCREASE',
    description: 'nợ test',
    source: 'POS',
  });
}

/** Payload webhook Sepay mẫu. */
function makePayload(overrides = {}) {
  return Object.assign(
    {
      id: `ZZSEP${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      gateway: 'VPB',
      transactionDate: '2026-11-18 10:00:00',
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
    db.prepare(`DELETE FROM sepay_transactions WHERE sepay_id LIKE 'ZZSEP%'`).run();
  } catch (_) {
    /* ignore */
  }
  createdSales.length = 0;
  createdCustomers.length = 0;
}

afterEach(() => cleanup());
afterAll(() => cleanup());

// ═══════════════════════════════════════════════════════════════════════════
// Migration 061
// ═══════════════════════════════════════════════════════════════════════════
describe('Migration 061 — schema Sepay', () => {
  test('đủ 2 bảng sepay_*', () => {
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sepay_%'`)
      .all()
      .map((r) => r.name);
    expect(names).toContain('sepay_transactions');
    expect(names).toContain('sepay_settings');
  });

  test('customers có cột debt_code', () => {
    const cols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
    expect(cols).toContain('debt_code');
  });

  test('debt_transactions chấp nhận loại bút toán CREDIT', () => {
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='debt_transactions'")
      .get().sql;
    expect(ddl).toContain("'CREDIT'");
  });

  test('sepay_settings có 1 dòng mặc định', () => {
    const row = db.prepare('SELECT * FROM sepay_settings WHERE id = 1').get();
    expect(row).toBeTruthy();
  });

  test('sepay_transactions.sepay_id UNIQUE (chống ghi trùng)', () => {
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='sepay_transactions'")
      .get().sql;
    expect(ddl).toMatch(/sepay_id\s+TEXT\s+NOT NULL\s+UNIQUE/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Trích mã khách
// ═══════════════════════════════════════════════════════════════════════════
describe('Trích mã khách từ nội dung chuyển khoản', () => {
  test('nhận dạng mã KHxxxx trong nội dung', () => {
    expect(DebtSepayService.extractDebtCode({ content: 'TT CONG NO KH0007' })).toBe('KH0007');
  });

  test('nhận dạng mã trong field `code`', () => {
    expect(DebtSepayService.extractDebtCode({ code: 'KH0123' })).toBe('KH0123');
  });

  test('nhận dạng mã trong field `description`', () => {
    expect(DebtSepayService.extractDebtCode({ description: 'KH0456 cong no' })).toBe('KH0456');
  });

  test('không có mã → trả chuỗi rỗng', () => {
    expect(DebtSepayService.extractDebtCode({ content: 'chuyen khoan thuong' })).toBe('');
  });

  test('normalizeCode bỏ dấu + khoảng trắng + hoa/thường', () => {
    expect(DebtSepayService.normalizeCode('kh 00a1')).toBe('KH00A1');
    expect(DebtSepayService.normalizeCode('đặng hàng')).toBe('DANGHANG');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mã khách hàng
// ═══════════════════════════════════════════════════════════════════════════
describe('Mã khách hàng (debt_code)', () => {
  test('khách mới được gán mã dạng KHxxxx', () => {
    const c = makeCustomer('Code');
    expect(c.code).toMatch(/^KH\d{4}$/);
  });

  test('gán mã 2 lần → giữ nguyên mã cũ', () => {
    const c = makeCustomer('CodeIdem');
    const again = DebtSepayService.ensureCustomerDebtCode(c.id);
    expect(again).toBe(c.code);
  });

  test('sửa mã thủ công → thành công', () => {
    const c = makeCustomer('CodeEdit');
    const res = DebtSepayService.setCustomerDebtCode(c.id, 'zz99');
    expect(res.success).toBe(true);
    expect(res.debtCode).toBe('ZZ99');
  });

  test('mã trùng khách khác → bị từ chối', () => {
    const a = makeCustomer('DupA');
    const b = makeCustomer('DupB');
    const res = DebtSepayService.setCustomerDebtCode(b.id, a.code);
    expect(res.success).toBe(false);
    expect(res.error).toContain('đã được khách');
  });

  test('mã rỗng → bị từ chối', () => {
    const c = makeCustomer('Empty');
    const res = DebtSepayService.setCustomerDebtCode(c.id, '  ');
    expect(res.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Gạch nợ — các tình huống thanh toán
// ═══════════════════════════════════════════════════════════════════════════
describe('Gạch nợ qua Sepay', () => {
  test('trả ĐÚNG số nợ → gạch hết, số dư = 0', () => {
    const c = makeCustomer('Exact');
    addDebt(c.id, 500000);

    const res = DebtSepayService.handleWebhook(
      makePayload({ content: `CONG NO ${c.code}`, transferAmount: 500000 })
    );

    expect(res.success).toBe(true);
    expect(res.settlement.applied).toBe(500000);
    expect(res.settlement.credit).toBe(0);
    expect(DebtLedgerService.computeBalance(c.id)).toBe(0);
  });

  test('trả THIẾU → gạch một phần, phần còn nợ giữ nguyên', () => {
    const c = makeCustomer('Under');
    addDebt(c.id, 500000);

    const res = DebtSepayService.handleWebhook(
      makePayload({ content: `CONG NO ${c.code}`, transferAmount: 200000 })
    );

    expect(res.settlement.applied).toBe(200000);
    expect(res.settlement.credit).toBe(0);
    expect(DebtLedgerService.computeBalance(c.id)).toBe(300000);
  });

  test('trả DƯ → gạch hết + ghi CREDIT (số dư âm)', () => {
    const c = makeCustomer('Over');
    addDebt(c.id, 500000);

    const res = DebtSepayService.handleWebhook(
      makePayload({ content: `CONG NO ${c.code}`, transferAmount: 800000 })
    );

    expect(res.settlement.applied).toBe(500000);
    expect(res.settlement.credit).toBe(300000);
    expect(DebtLedgerService.computeBalance(c.id)).toBe(-300000);

    const cust = db.prepare('SELECT debt FROM customers WHERE id = ?').get(c.id);
    expect(cust.debt).toBeCloseTo(-300000, 2);

    const creditTx = db
      .prepare(
        `SELECT * FROM debt_transactions
          WHERE customer_id = ? AND transaction_type = 'CREDIT'`
      )
      .get(c.id);
    expect(creditTx).toBeTruthy();
    expect(creditTx.amount).toBe(300000);
    expect(creditTx.direction).toBe('DECREASE');
  });

  test('khách chưa có công nợ → toàn bộ số tiền thành tiền nợ lại', () => {
    const c = makeCustomer('NoDebt');
    const res = DebtSepayService.handleWebhook(
      makePayload({ content: `CONG NO ${c.code}`, transferAmount: 150000 })
    );
    expect(res.settlement.applied).toBe(0);
    expect(res.settlement.credit).toBe(150000);
    expect(DebtLedgerService.computeBalance(c.id)).toBe(-150000);
  });

  // ── Trường hợp khách đang nợ lại (số dư âm) ───────────────────────────
  // Sổ công nợ dùng SỐ DƯ RÒNG: balance = tổng nợ - tổng đã trả.
  // → khi khách nợ lại 500k mà chuyển 1.000.000đ, cả 1.000.000đ đều quy về
  //    CREDIT → số dư -1.500.000đ (khách nợ lại hệ thống nhiều hơn).
  test('khách đang nợ lại 500k, chuyển 1.000.000đ → toàn bộ là CREDIT, số dư -1.500.000đ',
    () => {
      const c = makeCustomer('Deficit');
      addDebt(c.id, 500000);
      // Trả dư 1.000.000đ khi nợ 500k → còn nợ lại 500k
      DebtSepayService.handleWebhook(
        makePayload({ content: `CONG NO ${c.code}`, transferAmount: 1000000 })
      );
      expect(DebtLedgerService.computeBalance(c.id)).toBe(-500000);

      // Chuyển tiếp 1.000.000đ → không có nợ để gạch → toàn bộ thành CREDIT
      const res = DebtSepayService.handleWebhook(
        makePayload({ content: `CONG NO ${c.code}`, transferAmount: 1000000 })
      );
      expect(res.settlement.applied).toBe(0);
      expect(res.settlement.credit).toBe(1000000);
      expect(res.settlement.deficitOffset).toBe(500000);
      expect(DebtLedgerService.computeBalance(c.id)).toBe(-1500000);
    }
  );

  test('khách nợ lại 500k, mua thêm 300k → net -200k, chuyển 1.000.000đ → credit 1.000.000',
    () => {
      const c = makeCustomer('DeficitMix');
      // Trả dư khi chưa có nợ → nợ lại 500k
      DebtSepayService.handleWebhook(
        makePayload({ content: `CONG NO ${c.code}`, transferAmount: 500000 })
      );
      expect(DebtLedgerService.computeBalance(c.id)).toBe(-500000);

      // Khách vay thêm 300k → net -200k
      // ⚠️ ORDER_DEBT khi số dư âm → ledger phải cho phép (net balance)
      const addRes = DebtLedgerService.recordTransaction({
        customerId: c.id,
        transactionType: TRANSACTION_TYPES.ORDER_DEBT,
        amount: 300000,
        direction: 'INCREASE',
        description: 'nợ mới',
        source: 'POS',
        allowNegativeBalance: true,
        keepNegativeBalance: true,
      });
      expect(addRes.success).toBe(true);
      expect(DebtLedgerService.computeBalance(c.id)).toBe(-200000);

      // Chuyển 1.000.000đ → không có nợ dương để gạch → toàn bộ thành CREDIT
      const res = DebtSepayService.handleWebhook(
        makePayload({ content: `CONG NO ${c.code}`, transferAmount: 1000000 })
      );
      expect(res.settlement.applied).toBe(0);
      expect(res.settlement.credit).toBe(1000000);
      expect(DebtLedgerService.computeBalance(c.id)).toBe(-1200000);
    }
  );

  test('chuyển thiếu → gạch một phần, giữ nguyên phần còn nợ', () => {
    const c = makeCustomer('Under');
    addDebt(c.id, 1000000);
    const res = DebtSepayService.handleWebhook(
      makePayload({ content: `CONG NO ${c.code}`, transferAmount: 400000 })
    );
    expect(res.settlement.applied).toBe(400000);
    expect(res.settlement.credit).toBe(0);
    expect(res.settlement.deficitOffset).toBe(0);
    expect(DebtLedgerService.computeBalance(c.id)).toBe(600000);
  });

  test('chuyển đúng số nợ → gạch hết, số dư = 0', () => {
    const c = makeCustomer('Exact');
    addDebt(c.id, 750000);
    const res = DebtSepayService.handleWebhook(
      makePayload({ content: `CONG NO ${c.code}`, transferAmount: 750000 })
    );
    expect(res.settlement.applied).toBe(750000);
    expect(res.settlement.credit).toBe(0);
    expect(res.settlement.deficitOffset).toBe(0);
    expect(DebtLedgerService.computeBalance(c.id)).toBe(0);
  });

  test('webhook lặp (retry) → KHÔNG gạch 2 lần', () => {
    const c = makeCustomer('Idem');
    addDebt(c.id, 500000);
    const payload = makePayload({
      id: `ZZSEP_IDEM_${Date.now()}`,
      content: `CONG NO ${c.code}`,
      transferAmount: 500000,
    });

    DebtSepayService.handleWebhook(payload);
    const res2 = DebtSepayService.handleWebhook(payload);

    expect(res2.duplicate).toBe(true);
    expect(DebtLedgerService.computeBalance(c.id)).toBe(0);
    const txCount = db
      .prepare(
        `SELECT COUNT(*) c FROM debt_transactions
          WHERE customer_id = ? AND transaction_type = 'PAYMENT'`
      )
      .get(c.id).c;
    expect(txCount).toBe(1);
  });

  test('nội dung không có mã khách → giữ trạng thái manual', () => {
    const res = DebtSepayService.handleWebhook(
      makePayload({ id: `ZZSEP_NOMATCH_${Date.now()}`, content: 'chuyen khoan khong ro' })
    );
    expect(res.settlement.code).toBe('NO_CUSTOMER_MATCH');

    const tx = db
      .prepare(`SELECT * FROM sepay_transactions WHERE sepay_id LIKE 'ZZSEP_NOMATCH_%'`)
      .get();
    expect(tx.status).toBe('manual');
  });

  test('giao dịch tiền ra → bỏ qua, không gạch nợ', () => {
    const c = makeCustomer('Out');
    addDebt(c.id, 500000);
    const res = DebtSepayService.handleWebhook(
      makePayload({
        id: `ZZSEP_OUT_${Date.now()}`,
        content: `CONG NO ${c.code}`,
        transferType: 'out',
        transferAmount: 500000,
      })
    );
    expect(res.settlement.skipped).toBe(true);
    expect(DebtLedgerService.computeBalance(c.id)).toBe(500000);
  });

  test('số tiền = 0 → bỏ qua', () => {
    const res = DebtSepayService.handleWebhook(
      makePayload({ id: `ZZSEP_ZERO_${Date.now()}`, transferAmount: 0 })
    );
    expect(res.settlement.skipped).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phân bổ FIFO vào đơn hàng
// ═══════════════════════════════════════════════════════════════════════════
describe('Phân bổ FIFO vào order_debts', () => {
  test('trả 400k cho 2 đơn (300k cũ + 200k mới) → đơn cũ paid, đơn mới partial', () => {
    const c = makeCustomer('Fifo');
    const saleA = makeSale(c.id, 500000, '2026-11-01');
    const saleB = makeSale(c.id, 500000, '2026-11-10');

    db.prepare(
      `INSERT INTO order_debts (customer_id, sale_id, original_amount, paid_amount, remaining_amount, status, created_at)
       VALUES (?, ?, ?, 0, ?, 'unpaid', '2026-11-01 08:00:00')`
    ).run(c.id, saleA, 300000, 300000);
    db.prepare(
      `INSERT INTO order_debts (customer_id, sale_id, original_amount, paid_amount, remaining_amount, status, created_at)
       VALUES (?, ?, ?, 0, ?, 'unpaid', '2026-11-10 08:00:00')`
    ).run(c.id, saleB, 200000, 200000);

    addDebt(c.id, 500000);

    DebtSepayService.handleWebhook(
      makePayload({ content: `CONG NO ${c.code}`, transferAmount: 400000 })
    );

    const o1 = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleA);
    const o2 = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleB);

    expect(o1.status).toBe('paid');
    expect(o1.remaining_amount).toBe(0);
    expect(o2.status).toBe('partial');
    expect(o2.paid_amount).toBe(100000);
    expect(o2.remaining_amount).toBe(100000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Xử lý thủ công
// ═══════════════════════════════════════════════════════════════════════════
describe('Xử lý thủ công giao dịch chờ', () => {
  test('gán khách → gạch nợ ngay', () => {
    const c = makeCustomer('Assign');
    addDebt(c.id, 300000);

    const stored = DebtSepayService.storeTransaction(
      makePayload({ id: `ZZSEP_ASSIGN_${Date.now()}`, transferAmount: 100000 })
    );
    expect(stored.success).toBe(true);

    const res = DebtSepayService.assignCustomerAndSettle(stored.transactionId, c.id, {
      user: { username: 'admin' },
    });

    expect(res.success).toBe(true);
    expect(res.applied).toBe(100000);
    expect(DebtLedgerService.computeBalance(c.id)).toBe(200000);
  });

  test('bỏ qua giao dịch → status = ignored', () => {
    const stored = DebtSepayService.storeTransaction(
      makePayload({ id: `ZZSEP_IGNORE_${Date.now()}`, transferAmount: 100000 })
    );
    const res = DebtSepayService.ignoreTransaction(stored.transactionId, 'test');
    expect(res.success).toBe(true);

    const tx = db
      .prepare('SELECT * FROM sepay_transactions WHERE id = ?')
      .get(stored.transactionId);
    expect(tx.status).toBe('ignored');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Xác thực webhook HMAC-SHA256
// ═══════════════════════════════════════════════════════════════════════════
describe('Xác thực webhook HMAC-SHA256', () => {
  const crypto = require('crypto');
  const secret = 'test-secret-123';

  /**
   * Cách SePay ký (https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc):
   *   chuỗi ký = `{timestamp}.{raw_body}` → HMAC-SHA256 → hex
   *   header: `X-SePay-Signature: sha256={hex}`
   */
  function signSePay(rawBody, timestamp) {
    const hex = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
    return `sha256=${hex}`;
  }

  test('chữ ký đúng (format SePay) → hợp lệ', () => {
    const body = Buffer.from(JSON.stringify({ id: 1 }));
    const ts = Math.floor(Date.now() / 1000);
    const res = DebtSepayService.verifyWebhookSignature(
      body,
      signSePay(body, ts),
      secret,
      ts
    );
    expect(res.valid).toBe(true);
    expect(res.method).toBe('hmac-sha256');
  });

  test('chữ ký đúng nhưng thiếu prefix sha256= → vẫn hợp lệ', () => {
    const body = Buffer.from(JSON.stringify({ id: 1 }));
    const ts = Math.floor(Date.now() / 1000);
    const hex = crypto
      .createHmac('sha256', secret)
      .update(`${ts}.`)
      .update(body)
      .digest('hex');
    const res = DebtSepayService.verifyWebhookSignature(body, hex, secret, ts);
    expect(res.valid).toBe(true);
  });

  test('chữ ký sai → không hợp lệ', () => {
    const body = Buffer.from(JSON.stringify({ id: 1 }));
    const res = DebtSepayService.verifyWebhookSignature(body, 'sha256=deadbeef', secret);
    expect(res.valid).toBe(false);
  });

  test('thiếu chữ ký → không hợp lệ', () => {
    const body = Buffer.from('{}');
    const res = DebtSepayService.verifyWebhookSignature(body, null, secret);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('NO_SIGNATURE');
  });

  test('thiếu secret → không hợp lệ', () => {
    const body = Buffer.from('{}');
    const res = DebtSepayService.verifyWebhookSignature(body, 'abc', null);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('NO_SECRET');
  });

  test('timestamp quá cũ (>5 phút) → từ chối chống replay', () => {
    const body = Buffer.from(JSON.stringify({ id: 1 }));
    const oldTs = Math.floor(Date.now() / 1000) - 3600;
    const res = DebtSepayService.verifyWebhookSignature(
      body,
      signSePay(body, oldTs),
      secret,
      oldTs
    );
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('TIMESTAMP_EXPIRED');
  });

  test('thiếu timestamp → vẫn verify được (chữ ký trên body thuần)', () => {
    const body = Buffer.from(JSON.stringify({ id: 1 }));
    const hex = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const res = DebtSepayService.verifyWebhookSignature(body, hex, secret, null);
    expect(res.valid).toBe(true);
    expect(res.method).toBe('hmac-legacy');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Chuẩn hoá giao dịch từ API v2 (snake_case → camelCase)
// ═══════════════════════════════════════════════════════════════════════════
describe('Chuẩn hoá giao dịch API SePay v2', () => {
  test('map field snake_case của API v2', () => {
    const t = DebtSepayService.normalizeApiTransaction({
      id: 'uuid-1',
      transaction_date: '2026-11-18 10:00:00',
      account_number: '0933620773',
      va: 'VA001',
      code: 'KH0001',
      transfer_type: 'in',
      amount_in: 250000,
      amount_out: 0,
      accumulated: 500000,
      transaction_content: 'CONG NO KH0001',
      reference_number: 'FT123',
      bank_brand_name: 'VPB',
    });

    expect(t.id).toBe('uuid-1');
    expect(t.transactionDate).toBe('2026-11-18 10:00:00');
    expect(t.content).toBe('CONG NO KH0001');
    expect(t.transferAmount).toBe(250000);
    expect(t.referenceCode).toBe('FT123');
    expect(t.gateway).toBe('VPB');
    expect(t.code).toBe('KH0001');
  });

  test('giao dịch tiền ra lấy amount_out', () => {
    const t = DebtSepayService.normalizeApiTransaction({
      id: 'uuid-2',
      transfer_type: 'out',
      amount_in: 0,
      amount_out: 90000,
    });
    expect(t.transferAmount).toBe(90000);
    expect(t.transferType).toBe('out');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Truy vấn & thống kê
// ═══════════════════════════════════════════════════════════════════════════
describe('Truy vấn giao dịch Sepay', () => {
  test('listTransactions lọc theo status', () => {
    const c = makeCustomer('List');
    addDebt(c.id, 100000);
    DebtSepayService.handleWebhook(
      makePayload({
        id: `ZZSEP_LIST_${Date.now()}`,
        content: `CONG NO ${c.code}`,
        transferAmount: 100000,
      })
    );

    const res = DebtSepayService.listTransactions({ status: 'matched' });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.every((i) => i.status === 'matched')).toBe(true);
  });

  test('getSummary trả về số liệu tổng hợp', () => {
    const s = DebtSepayService.getSummary();
    expect(typeof s.total).toBe('number');
    expect(typeof s.matched).toBe('number');
    expect(typeof s.credit).toBe('number');
  });

  test('sepayBusinessDate lấy YYYY-MM-DD từ transactionDate', () => {
    expect(DebtSepayService.sepayBusinessDate('2026-11-18 15:04:05')).toBe('2026-11-18');
    expect(DebtSepayService.sepayBusinessDate(null)).toBeNull();
  });
});
