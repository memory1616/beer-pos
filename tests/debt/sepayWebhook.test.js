/**
 * Sepay — kiểm thử tích hợp route (supertest)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu: đảm bảo endpoint PUBLIC `/webhook/sepay`:
 *  - TỪ CHỐI khi chưa cấu hình secret/token.
 *  - TỪ CHỐI khi chữ ký sai.
 *  - NHẬN & gạch nợ khi chữ ký đúng.
 *  - Trả về đúng body `{"success": true}` (yêu cầu của Sepay).
 *  - Idempotent khi Sepay retry.
 */
process.env.NODE_ENV = 'test';

const request = require('supertest');
const crypto = require('crypto');

const db = require('../../database');
const DebtSepayService = require('../../src/services/debt/DebtSepayService');
const DebtLedgerService = require('../../src/services/debt/DebtLedgerService');
const { TRANSACTION_TYPES } = require('../../src/services/debt/constants');

jest.setTimeout(20000);

// Mount riêng router webhook + middleware express.json() giống server.js
const express = require('express');
const app = express();
app.use('/webhook/sepay', require('../../routes/sepayWebhook'));

const SECRET = 'it-secret-abc';
let customerId = null;
let debtCode = null;

beforeAll(() => {
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, debt, archived, created_at, updated_at)
       VALUES ('__SEPAY_ROUTE_TEST__', '', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run();
  customerId = info.lastInsertRowid;
  debtCode = DebtSepayService.ensureCustomerDebtCode(customerId);

  DebtLedgerService.recordTransaction({
    customerId,
    transactionType: TRANSACTION_TYPES.ORDER_DEBT,
    amount: 400000,
    direction: 'INCREASE',
    description: 'nợ test route',
    source: 'POS',
  });

  DebtSepayService.saveSettings({
    webhookSecret: SECRET,
    apiToken: null,
    autoSettle: true,
  });
});

afterAll(() => {
  try {
    db.prepare('DELETE FROM sepay_transactions WHERE customer_id = ?').run(customerId);
    db.prepare(
      'DELETE FROM debt_audit_logs WHERE transaction_id IN (SELECT id FROM debt_transactions WHERE customer_id = ?)'
    ).run(customerId);
    db.prepare('DELETE FROM debt_transactions WHERE customer_id = ?').run(customerId);
    db.prepare('DELETE FROM debt_accounts WHERE customer_id = ?').run(customerId);
    db.prepare('DELETE FROM customers WHERE id = ?').run(customerId);
  } catch (_) {
    /* ignore */
  }
  // Khôi phục cấu hình cũ (xoá secret)
  DebtSepayService.saveSettings({ webhookSecret: null, apiToken: null });
});

function sign(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('POST /webhook/sepay — xác thực', () => {
  test('thiếu chữ ký → 401', async () => {
    const res = await request(app)
      .post('/webhook/sepay')
      .send({ id: 'ROUTE_NO_SIG', transferAmount: 100000 });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('chữ ký sai → 401', async () => {
    const res = await request(app)
      .post('/webhook/sepay')
      .set('X-Sepay-Signature', 'deadbeef')
      .send({ id: 'ROUTE_BAD_SIG', transferAmount: 100000 });
    expect(res.status).toBe(401);
  });

  test('không có mã khách → vẫn 200 (giao dịch được lưu chờ xử lý)', async () => {
    const body = { id: 'ROUTE_NOMATCH', transferAmount: 100000, content: 'CK KHONG MA' };
    const raw = JSON.stringify(body);
    const res = await request(app)
      .post('/webhook/sepay')
      .set('X-Sepay-Signature', sign(Buffer.from(raw)))
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});

describe('POST /webhook/sepay — gạch nợ', () => {
  test('chữ ký đúng → gạch nợ & trả {"success": true}', async () => {
    const body = {
      id: 'ROUTE_OK_1',
      transferAmount: 400000,
      content: `THANH TOAN CONG NO ${debtCode}`,
      transactionDate: '2026-11-18 10:00:00',
      transferType: 'in',
    };
    const raw = JSON.stringify(body);

    const res = await request(app)
      .post('/webhook/sepay')
      .set('X-Sepay-Signature', sign(Buffer.from(raw)))
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(DebtLedgerService.computeBalance(customerId)).toBe(0);
  });

  test('retry cùng giao dịch → không gạch 2 lần', async () => {
    const body = {
      id: 'ROUTE_RETRY',
      transferAmount: 100000,
      content: `THANH TOAN CONG NO ${debtCode}`,
      transferType: 'in',
    };
    const raw = JSON.stringify(body);
    const sig = sign(Buffer.from(raw));

    const r1 = await request(app)
      .post('/webhook/sepay')
      .set('X-Sepay-Signature', sig)
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(r1.status).toBe(200);

    const r2 = await request(app)
      .post('/webhook/sepay')
      .set('X-Sepay-Signature', sig)
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(r2.status).toBe(200);

    // Chỉ 1 bút toán PAYMENT
    const cnt = db
      .prepare(
        `SELECT COUNT(*) c FROM debt_transactions
          WHERE customer_id = ? AND transaction_type = 'PAYMENT'`
      )
      .get(customerId).c;
    expect(cnt).toBe(1);
  });

  test('chuyển DƯ → ghi CREDIT (số dư âm)', async () => {
    const cInfo = db
      .prepare(
        `INSERT INTO customers (name, phone, debt, archived, created_at, updated_at)
         VALUES ('__SEPAY_ROUTE_OVER__', '', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run();
    const cid = cInfo.lastInsertRowid;
    const code = DebtSepayService.ensureCustomerDebtCode(cid);

    DebtLedgerService.recordTransaction({
      customerId: cid,
      transactionType: TRANSACTION_TYPES.ORDER_DEBT,
      amount: 100000,
      direction: 'INCREASE',
      description: 'nợ test over',
      source: 'POS',
    });

    const body = {
      id: 'ROUTE_OVER',
      transferAmount: 250000,
      content: `CONG NO ${code}`,
      transferType: 'in',
    };
    const raw = JSON.stringify(body);

    const res = await request(app)
      .post('/webhook/sepay')
      .set('X-Sepay-Signature', sign(Buffer.from(raw)))
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(res.status).toBe(200);
    expect(DebtLedgerService.computeBalance(cid)).toBe(-150000);

    try {
      db.prepare('DELETE FROM sepay_transactions WHERE customer_id = ?').run(cid);
      db.prepare(
        'DELETE FROM debt_audit_logs WHERE transaction_id IN (SELECT id FROM debt_transactions WHERE customer_id = ?)'
      ).run(cid);
      db.prepare('DELETE FROM debt_transactions WHERE customer_id = ?').run(cid);
      db.prepare('DELETE FROM debt_accounts WHERE customer_id = ?').run(cid);
      db.prepare('DELETE FROM customers WHERE id = ?').run(cid);
    } catch (_) {
      /* ignore */
    }
  });
});
