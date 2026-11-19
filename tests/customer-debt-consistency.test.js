/**
 * ĐỒNG BỘ CÔNG NỢ — KPI trang khách ↔ Sổ công nợ
 * ─────────────────────────────────────────────────────────────────────────────
 * Nguyên tắc: SỔ CÔNG NỢ (ledger `debt_transactions`) là nguồn sự thật duy nhất.
 * `customers.debt` chỉ là MIRROR.
 *
 * Kiểm tra:
 *  - GET /api/customers/:id/stats trả `currentDebt` (trước đây THIẾU → KPI = 0)
 *  - GET /api/customers/:id trả `debt` theo ledger
 *  - GET /api/debts/:customerId trả `customer.debt` + `totalDebt` theo ledger
 *  - Cả 3 khớp nhau
 */
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const db = require('../database');
const customersRouter = require('../routes/api/customers');
const debtsRouter = require('../routes/api/debts');
const DebtLedgerService = require('../src/services/debt/DebtLedgerService');
const { TRANSACTION_TYPES } = require('../src/services/debt/constants');

jest.setTimeout(25000);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { username: 'admin', role: 'ADMIN' };
  next();
});
app.use('/api/customers', customersRouter);
app.use('/api/debts', debtsRouter);

const createdCustomers = [];

function makeCustomer(debt = 0) {
  const name = `__DEBT_SYNC_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, debt, archived, created_at, updated_at)
       VALUES (?, '', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(name);
  const id = info.lastInsertRowid;
  createdCustomers.push(id);
  if (debt > 0) {
    DebtLedgerService.recordTransaction({
      customerId: id,
      transactionType: TRANSACTION_TYPES.MANUAL_DEBT,
      amount: debt,
      direction: DebtLedgerService.DIRECTION.INCREASE,
      createdBy: 'test',
    });
  }
  return id;
}

function cleanup() {
  for (const id of createdCustomers) {
    try {
      db.prepare('DELETE FROM debt_audit_logs WHERE transaction_id IN (SELECT id FROM debt_transactions WHERE customer_id = ?)').run(id);
      db.prepare('DELETE FROM debt_transactions WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM debt_accounts WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM order_debts WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    } catch (_) {}
  }
  createdCustomers.length = 0;
}

afterEach(() => cleanup());
afterAll(() => cleanup());

describe('Đồng bộ công nợ giữa KPI / trang khách / sổ công nợ', () => {
  test('GET /api/customers/:id/stats trả currentDebt theo ledger', async () => {
    const cid = makeCustomer(1234000);
    const res = await request(app).get(`/api/customers/${cid}/stats`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('currentDebt');
    expect(res.body.currentDebt).toBe(1234000);
  });

  test('GET /api/customers/:id/stats — khách không nợ → currentDebt = 0', async () => {
    const cid = makeCustomer(0);
    const res = await request(app).get(`/api/customers/${cid}/stats`);
    expect(res.body.currentDebt).toBe(0);
  });

  test('GET /api/customers/:id trả debt theo ledger', async () => {
    const cid = makeCustomer(750000);
    const res = await request(app).get(`/api/customers/${cid}`);
    expect(res.status).toBe(200);
    expect(res.body.debt).toBe(750000);
  });

  test('GET /api/debts/:customerId trả debt theo ledger', async () => {
    const cid = makeCustomer(900000);
    const res = await request(app).get(`/api/debts/${cid}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalDebt).toBe(900000);
    expect(res.body.data.customer.debt).toBe(900000);
  });

  test('3 nguồn khớp nhau sau khi thu tiền', async () => {
    const cid = makeCustomer(1000000);
    // Thu 300k
    const r = await request(app)
      .post('/api/debts/payment')
      .send({ customerId: cid, amount: 300000, note: 'test' });
    expect(r.status).toBe(200);

    const stats = await request(app).get(`/api/customers/${cid}/stats`);
    const cust = await request(app).get(`/api/customers/${cid}`);
    const debts = await request(app).get(`/api/debts/${cid}`);

    expect(stats.body.currentDebt).toBe(700000);
    expect(cust.body.debt).toBe(700000);
    expect(debts.body.data.totalDebt).toBe(700000);
    expect(debts.body.data.customer.debt).toBe(700000);
    expect(DebtLedgerService.computeBalance(cid)).toBe(700000);
  });
});
