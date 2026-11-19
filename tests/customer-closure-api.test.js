/**
 * CHỐT KHÁCH NGỪNG BÁN — API routes
 * ─────────────────────────────────────────────────────────────────────────────
 *  - GET  /api/customers/:id/closure-preview
 *  - POST /api/customers/:id/closure
 *  - GET  /api/customers/:id/closures
 */
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const db = require('../database');
const customersRouter = require('../routes/api/customers');

jest.setTimeout(25000);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const username = req.headers['x-test-user'];
  if (username) {
    req.user = { username: String(username), role: req.headers['x-test-role'] || 'ADMIN' };
  }
  next();
});
app.use('/api/customers', customersRouter);

const ADMIN = { 'x-test-user': 'admin', 'x-test-role': 'ADMIN' };

// ── Fixtures ────────────────────────────────────────────────────────────────
const createdCustomers = [];

function makeCustomer(opts = {}) {
  const name = `__CLOSURE_API_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, deposit, keg_balance, debt, archived, created_at, updated_at)
       VALUES (?, '', ?, ?, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(name, opts.deposit || 0, opts.kegBalance || 0);
  createdCustomers.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

function cleanup() {
  for (const id of createdCustomers) {
    try {
      db.prepare('DELETE FROM customer_closure_items WHERE closure_id IN (SELECT id FROM customer_closures WHERE customer_id = ?)').run(id);
      db.prepare('DELETE FROM customer_closures WHERE customer_id = ?').run(id);
    } catch (_) {}
    try {
      db.prepare('DELETE FROM debt_audit_logs WHERE transaction_id IN (SELECT id FROM debt_transactions WHERE customer_id = ?)').run(id);
      db.prepare('DELETE FROM debt_transactions WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM debt_accounts WHERE customer_id = ?').run(id);
    } catch (_) {}
    try { db.prepare('DELETE FROM customers WHERE id = ?').run(id); } catch (_) {}
  }
  createdCustomers.length = 0;
}

afterEach(() => cleanup());
afterAll(() => cleanup());

// ═══════════════════════════════════════════════════════════════════════════
describe('GET /api/customers/:id/closure-preview', () => {
  test('trả về preview', async () => {
    const cid = makeCustomer({ deposit: 200000, kegBalance: 6 });
    const res = await request(app).get(`/api/customers/${cid}/closure-preview`).set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.preview.customer.id).toBe(cid);
    expect(res.body.preview.customer.kegBalance).toBe(6);
    expect(res.body.preview.defaults.depositRefund).toBe(200000);
  });

  test('ID không hợp lệ → 400', async () => {
    const res = await request(app).get('/api/customers/abc/closure-preview').set(ADMIN);
    expect(res.status).toBe(400);
  });

  test('khách không tồn tại → 404', async () => {
    const res = await request(app).get('/api/customers/999999999/closure-preview').set(ADMIN);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('POST /api/customers/:id/closure', () => {
  test('chốt khách thành công', async () => {
    const cid = makeCustomer({ kegBalance: 4 });
    const res = await request(app)
      .post(`/api/customers/${cid}/closure`)
      .set(ADMIN)
      .send({
        kegsEmpty: 4,
        kegsFull: 0,
        kegsLost: 0,
        items: [],
        depositRefund: 0,
        debtMode: 'offset',
        archive: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.closureNo).toMatch(/^CL-\d{8}-\d{4}$/);

    const cust = db.prepare('SELECT keg_balance, archived FROM customers WHERE id=?').get(cid);
    expect(cust.keg_balance).toBe(0);
    expect(cust.archived).toBe(1);
  });

  test('số âm → 400', async () => {
    const cid = makeCustomer({ kegBalance: 4 });
    const res = await request(app)
      .post(`/api/customers/${cid}/closure`)
      .set(ADMIN)
      .send({ kegsEmpty: -1, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 0 });
    expect(res.status).toBe(400);
  });

  test('vượt số vỏ → 400 với message', async () => {
    const cid = makeCustomer({ kegBalance: 2 });
    const res = await request(app)
      .post(`/api/customers/${cid}/closure`)
      .set(ADMIN)
      .send({ kegsEmpty: 5, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vượt quá/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('GET /api/customers/:id/closures', () => {
  test('trả về lịch sử phiếu', async () => {
    const cid = makeCustomer({ kegBalance: 0 });
    await request(app)
      .post(`/api/customers/${cid}/closure`)
      .set(ADMIN)
      .send({ kegsEmpty: 0, kegsFull: 0, kegsLost: 0, items: [], depositRefund: 0, debtMode: 'keep' });

    const res = await request(app).get(`/api/customers/${cid}/closures`).set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.closures).toHaveLength(1);
  });
});
