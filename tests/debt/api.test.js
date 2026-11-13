/**
 * SỔ CÔNG NỢ GIA HUY — GĐ3/GĐ4: API routes + Reconciliation + RBAC
 * ─────────────────────────────────────────────────────────────────────────────
 * Phạm vi test:
 *  - Phân quyền API (Admin / Staff / Customer)
 *  - Quick Entry `+1000` / `-1000` (thay thế Zalo Personal Bridge)
 *  - Manual Payment / Manual Debt / Adjust / Reverse
 *  - Nhóm Zalo mapping (cấm Zalo OA)
 *  - Đối soát (reconciliation) + xử lý có audit log
 *  - Toàn vẹn dữ liệu sau mỗi test
 */
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const db = require('../../database');
const DebtLedgerService = require('../../src/services/debt/DebtLedgerService');
const DebtAccountService = require('../../src/services/debt/DebtAccountService');
const DebtReconciliationService = require('../../src/services/debt/DebtReconciliationService');
const debtLedgerRouter = require('../../routes/api/debtLedger');
const { TRANSACTION_TYPES } = require('../../src/services/debt/constants');

jest.setTimeout(25000);

// ── App test ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
// Giả lập session theo header `x-test-user`
app.use((req, _res, next) => {
  const username = req.headers['x-test-user'];
  if (username) {
    req.user = {
      username: String(username),
      role: req.headers['x-test-role'] || 'ADMIN',
    };
  }
  next();
});
app.use('/api/debt-ledger', debtLedgerRouter);

const ADMIN = { 'x-test-user': 'admin', 'x-test-role': 'ADMIN' };
const STAFF = { 'x-test-user': 'staff_a', 'x-test-role': 'STAFF' };
const CUSTOMER = { 'x-test-user': 'cust_x', 'x-test-role': 'CUSTOMER' };

// ── Fixtures ───────────────────────────────────────────────────────────────
let seq = 0;
const createdCustomers = [];
const createdSales = [];
const createdStaff = [];

function makeCustomer(debt = 0) {
  seq += 1;
  const name = `__DEBT_API_${Date.now()}_${seq}`;
  const info = db
    .prepare(
      `INSERT INTO customers (name, phone, debt, archived, created_at, updated_at)
       VALUES (?, '', ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(name, debt);
  createdCustomers.push(info.lastInsertRowid);
  // Số dư đầu kỳ phải được ghi vào ledger (nguồn sự thật) — mirror chỉ là bản sao
  if (debt > 0) {
    DebtAccountService.setOpeningBalance(info.lastInsertRowid, debt, {
      createdBy: 'test',
      source: 'MIGRATION',
    });
  }
  return info.lastInsertRowid;
}

function makeSale(customerId, total) {
  const info = db
    .prepare(
      `INSERT INTO sales (customer_id, date, total, profit, type, status, payment_status,
                          delivery_status, is_credit, created_at)
       VALUES (?, date('now'), ?, 0, 'sale', 'completed', 'unpaid', 'DELIVERED', 1,
                CURRENT_TIMESTAMP)`
    )
    .run(customerId, total);
  createdSales.push(info.lastInsertRowid);
  return info.lastInsertRowid;
}

/** Tạo user STAFF trong app_users để phân quyền. */
function makeStaffUser(username) {
  const exists = db.prepare('SELECT id FROM app_users WHERE username = ?').get(username);
  if (exists) return username;
  const info = db
    .prepare(
      `INSERT INTO app_users (username, password_hash, full_name, role, active, created_at)
       VALUES (?, 'x', ?, 'STAFF', 1, CURRENT_TIMESTAMP)`
    )
    .run(username, username);
  createdStaff.push(info.lastInsertRowid);
  return username;
}

function assignStaff(staffId, customerId) {
  db.prepare(
    `INSERT OR REPLACE INTO debt_staff_permissions (staff_id, customer_id, can_record_payment, status)
     VALUES (?, ?, 1, 'active')`
  ).run(staffId, customerId);
}

function assertIntegrity(customerId) {
  const customer = db.prepare('SELECT debt FROM customers WHERE id = ?').get(customerId);
  const ledger = DebtLedgerService.computeBalance(customerId);
  expect(customer.debt).toBeCloseTo(ledger, 2);
}

function cleanup() {
  for (const id of createdSales) {
    try {
      db.prepare('DELETE FROM order_debts WHERE sale_id = ?').run(id);
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
      db.prepare('DELETE FROM debt_staff_permissions WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM debt_customer_groups WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    } catch (_) {
      /* ignore */
    }
  }
  for (const id of createdStaff) {
    try {
      db.prepare('DELETE FROM app_users WHERE id = ?').run(id);
    } catch (_) {
      /* ignore */
    }
  }
  createdSales.length = 0;
  createdCustomers.length = 0;
  createdStaff.length = 0;
}

afterEach(() => cleanup());
afterAll(() => cleanup());

// ═══════════════════════════════════════════════════════════════════════════
// Phân quyền
// ═══════════════════════════════════════════════════════════════════════════
describe('Phân quyền API', () => {
  test('không đăng nhập → 401', async () => {
    const res = await request(app).get('/api/debt-ledger/overview');
    expect(res.status).toBe(401);
  });

  test('CUSTOMER không được ghi giao dịch → 403', async () => {
    const cid = makeCustomer(1000000);
    const res = await request(app)
      .post('/api/debt-ledger/quick-entry')
      .set(CUSTOMER)
      .send({ customerId: cid, content: '+100' });
    expect(res.status).toBe(403);
  });

  test('STAFF chưa được phân công → 403 khi ghi thanh toán', async () => {
    const cid = makeCustomer(1000000);
    const res = await request(app)
      .post('/api/debt-ledger/payment')
      .set(STAFF)
      .send({ customerId: cid, amount: 100000 });
    expect(res.status).toBe(403);
  });

  test('STAFF được phân công → ghi thanh toán thành công', async () => {
    const cid = makeCustomer(1000000);
    makeStaffUser('staff_a');
    assignStaff('staff_a', cid);

    const res = await request(app)
      .post('/api/debt-ledger/payment')
      .set(STAFF)
      .send({ customerId: cid, amount: 100000 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.balanceAfter).toBe(900000);
    assertIntegrity(cid);
  });

  test('STAFF không được điều chỉnh / đảo → 403', async () => {
    const res = await request(app)
      .post('/api/debt-ledger/adjust')
      .set(STAFF)
      .send({ customerId: 1, amount: 1000, reason: 'x' });
    expect(res.status).toBe(403);

    const res2 = await request(app)
      .post('/api/debt-ledger/reverse')
      .set(STAFF)
      .send({ transactionId: 1, reason: 'x' });
    expect(res2.status).toBe(403);
  });

  test('STAFF không thấy khách không được phân công', async () => {
    const cid1 = makeCustomer(1000000);
    makeCustomer(500000);
    makeStaffUser('staff_a');
    assignStaff('staff_a', cid1);

    const res = await request(app).get('/api/debt-ledger/customers').set(STAFF);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].id).toBe(cid1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Quick Entry (+ / -)
// ═══════════════════════════════════════════════════════════════════════════
describe('Quick Entry — lệnh + / -', () => {
  test('lệnh +1000 ghi nhận thanh toán 1.000.000đ', async () => {
    const cid = makeCustomer(3000000);
    const res = await request(app)
      .post('/api/debt-ledger/quick-entry')
      .set(ADMIN)
      .send({ customerId: cid, content: '+1000' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.amount).toBe(1000000);
    expect(res.body.data.balanceAfter).toBe(2000000);
    expect(DebtLedgerService.computeBalance(cid)).toBe(2000000);
    assertIntegrity(cid);
  });

  test('lệnh -1000 ghi nợ tay 1.000.000đ (KHÔNG tạo đơn hàng)', async () => {
    const cid = makeCustomer(1000000);
    const salesBefore = db.prepare('SELECT COUNT(*) c FROM sales').get().c;

    const res = await request(app)
      .post('/api/debt-ledger/quick-entry')
      .set(ADMIN)
      .send({ customerId: cid, content: '-1000' });

    expect(res.status).toBe(200);
    expect(res.body.data.amount).toBe(1000000);
    expect(res.body.data.balanceAfter).toBe(2000000);

    // KHÔNG tạo đơn hàng mới
    expect(db.prepare('SELECT COUNT(*) c FROM sales').get().c).toBe(salesBefore);

    const tx = db
      .prepare("SELECT * FROM debt_transactions WHERE customer_id = ? AND transaction_type = 'MANUAL_DEBT'")
      .get(cid);
    expect(tx).toBeTruthy();
    expect(tx.amount).toBe(1000000);
    expect(tx.direction).toBe('INCREASE');
  });

  test('cú pháp sai bị từ chối (không ghi gì)', async () => {
    const cid = makeCustomer(1000000);
    for (const bad of ['++1000', '+0', '+-1000', '+abc', 'hello']) {
      const res = await request(app)
        .post('/api/debt-ledger/quick-entry')
        .set(ADMIN)
        .send({ customerId: cid, content: bad });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    }
    expect(DebtLedgerService.computeBalance(cid)).toBe(1000000);
  });

  test('messageId trùng → không ghi nhận lần 2', async () => {
    const cid = makeCustomer(3000000);
    const body = { customerId: cid, content: '+1000', messageId: 'msg_dup_1' };

    const r1 = await request(app).post('/api/debt-ledger/quick-entry').set(ADMIN).send(body);
    expect(r1.status).toBe(200);

    const r2 = await request(app).post('/api/debt-ledger/quick-entry').set(ADMIN).send(body);
    expect(r2.status).toBe(400);
    expect(r2.body.code).toBe('DUPLICATE_MESSAGE');

    expect(DebtLedgerService.computeBalance(cid)).toBe(2000000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Giao dịch đồng thời (race condition)
// ═══════════════════════════════════════════════════════════════════════════
describe('Giao dịch đồng thời', () => {
  test('2 request song song với cùng idempotency key → chỉ ghi 1 bút toán', async () => {
    const cid = makeCustomer(3000000);
    const key = 'race_key_1';

    const results = await Promise.all([
      request(app)
        .post('/api/debt-ledger/payment')
        .set(ADMIN)
        .set('X-Request-Id', key)
        .send({ customerId: cid, amount: 1000000 }),
      request(app)
        .post('/api/debt-ledger/payment')
        .set(ADMIN)
        .set('X-Request-Id', key)
        .send({ customerId: cid, amount: 1000000 }),
    ]);

    const okCount = results.filter((r) => r.status === 200).length;
    expect(okCount).toBeGreaterThanOrEqual(1);

    // Chỉ có ĐÚNG 1 bút toán PAYMENT 1.000.000đ
    const txs = db
      .prepare(
        "SELECT * FROM debt_transactions WHERE customer_id = ? AND transaction_type = 'PAYMENT'"
      )
      .all(cid);
    expect(txs.length).toBe(1);
    expect(txs[0].amount).toBe(1000000);

    expect(DebtLedgerService.computeBalance(cid)).toBe(2000000);
    assertIntegrity(cid);
  });

  test('2 lệnh + đồng thời → số dư không bị tính sai (không âm, không trùng)', async () => {
    const cid = makeCustomer(2000000);

    await Promise.all([
      request(app)
        .post('/api/debt-ledger/quick-entry')
        .set(ADMIN)
        .send({ customerId: cid, content: '+1000', messageId: 'race_msg_1' }),
      request(app)
        .post('/api/debt-ledger/quick-entry')
        .set(ADMIN)
        .send({ customerId: cid, content: '+500', messageId: 'race_msg_2' }),
    ]);

    const balance = DebtLedgerService.computeBalance(cid);
    expect(balance).toBeGreaterThanOrEqual(0);
    // Tổng bút toán phải khớp số dư
    const sum = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN direction='INCREASE' THEN amount ELSE -amount END),0) s
           FROM debt_transactions WHERE customer_id = ?`
      )
      .get(cid).s;
    expect(sum).toBeCloseTo(balance, 2);
    assertIntegrity(cid);
  });

  test('2 ghi nợ tay đồng thời → cả 2 đều được ghi, balance chính xác', async () => {
    const cid = makeCustomer(0);

    await Promise.all([
      request(app)
        .post('/api/debt-ledger/manual-debt')
        .set(ADMIN)
        .send({ customerId: cid, amount: 300000 }),
      request(app)
        .post('/api/debt-ledger/manual-debt')
        .set(ADMIN)
        .send({ customerId: cid, amount: 700000 }),
    ]);

    expect(DebtLedgerService.computeBalance(cid)).toBe(1000000);
    assertIntegrity(cid);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Manual Debt / Adjust / Reverse
// ═══════════════════════════════════════════════════════════════════════════
describe('Manual Debt / Adjust / Reverse', () => {
  test('ghi nợ tay qua API', async () => {
    const cid = makeCustomer(0);
    const res = await request(app)
      .post('/api/debt-ledger/manual-debt')
      .set(ADMIN)
      .send({ customerId: cid, amount: 500000, note: 'Mượn thêm vỏ' });

    expect(res.status).toBe(200);
    expect(res.body.data.balanceAfter).toBe(500000);
    assertIntegrity(cid);
  });

  test('thanh toán vượt số dư → bị chặn', async () => {
    const cid = makeCustomer(100000);
    const res = await request(app)
      .post('/api/debt-ledger/payment')
      .set(ADMIN)
      .send({ customerId: cid, amount: 500000 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OVERPAYMENT_BLOCKED');
    expect(DebtLedgerService.computeBalance(cid)).toBe(100000);
  });

  test('admin điều chỉnh công nợ (ADJUSTMENT)', async () => {
    const cid = makeCustomer(1000000);
    const res = await request(app)
      .post('/api/debt-ledger/adjust')
      .set(ADMIN)
      .send({ customerId: cid, amount: -200000, reason: 'Chênh lệch doanh thu' });

    expect(res.status).toBe(200);
    expect(res.body.data.balanceAfter).toBe(800000);

    const tx = db
      .prepare("SELECT * FROM debt_transactions WHERE customer_id = ? AND transaction_type = 'ADJUSTMENT'")
      .get(cid);
    expect(tx).toBeTruthy();
    assertIntegrity(cid);
  });

  test('admin đảo giao dịch (REVERSAL) — bút toán gốc KHÔNG bị xoá', async () => {
    const cid = makeCustomer(1000000);
    await request(app)
      .post('/api/debt-ledger/manual-debt')
      .set(ADMIN)
      .send({ customerId: cid, amount: 500000 });

    const tx = db
      .prepare("SELECT id FROM debt_transactions WHERE customer_id = ? AND transaction_type = 'MANUAL_DEBT'")
      .get(cid);

    const res = await request(app)
      .post('/api/debt-ledger/reverse')
      .set(ADMIN)
      .send({ transactionId: tx.id, reason: 'Ghi nhầm' });

    expect(res.status).toBe(200);

    // Bút toán gốc vẫn còn
    const still = db.prepare('SELECT * FROM debt_transactions WHERE id = ?').get(tx.id);
    expect(still).toBeTruthy();

    // Có bút toán REVERSAL
    const rev = db
      .prepare("SELECT * FROM debt_transactions WHERE customer_id = ? AND transaction_type = 'REVERSAL'")
      .get(cid);
    expect(rev).toBeTruthy();
    expect(rev.amount).toBe(500000);
    assertIntegrity(cid);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Nhóm Zalo
// ═══════════════════════════════════════════════════════════════════════════
describe('Nhóm Zalo (mapping)', () => {
  test('admin liên kết nhóm Zalo cá nhân với khách', async () => {
    const cid = makeCustomer(0);
    const res = await request(app)
      .post('/api/debt-ledger/groups')
      .set(ADMIN)
      .send({ customerId: cid, groupId: 'g_123', groupName: 'Nhóm Anh Hùng' });

    expect(res.status).toBe(200);
    const row = db
      .prepare('SELECT * FROM debt_customer_groups WHERE group_id = ?')
      .get('g_123');
    expect(row).toBeTruthy();
    expect(row.customer_id).toBe(cid);
    expect(row.platform).toBe('zalo_personal');
  });

  test('từ chối Zalo OA', async () => {
    const cid = makeCustomer(0);
    const res = await request(app)
      .post('/api/debt-ledger/groups')
      .set(ADMIN)
      .send({ customerId: cid, groupId: 'oa_1', platform: 'zalo_oa' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/OA/);
  });

  test('gỡ liên kết → chuyển inactive (KHÔNG xoá vật lý)', async () => {
    const cid = makeCustomer(0);
    await request(app)
      .post('/api/debt-ledger/groups')
      .set(ADMIN)
      .send({ customerId: cid, groupId: 'g_456' });

    const row = db.prepare('SELECT id FROM debt_customer_groups WHERE group_id = ?').get('g_456');
    const res = await request(app).delete(`/api/debt-ledger/groups/${row.id}`).set(ADMIN);
    expect(res.status).toBe(200);

    const after = db.prepare('SELECT * FROM debt_customer_groups WHERE id = ?').get(row.id);
    expect(after).toBeTruthy();
    expect(after.status).toBe('inactive');
  });

  test('staff không được quản lý nhóm', async () => {
    const res = await request(app)
      .post('/api/debt-ledger/groups')
      .set(STAFF)
      .send({ customerId: 1, groupId: 'g_x' });
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Overview / Customers / Detail
// ═══════════════════════════════════════════════════════════════════════════
describe('Truy vấn tổng quan', () => {
  test('overview trả KPI + top nợ', async () => {
    const cid = makeCustomer(2000000);
    const res = await request(app).get('/api/debt-ledger/overview').set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.totalDebt).toBe('number');
    expect(Array.isArray(res.body.data.topDebtors)).toBe(true);
  });

  test('chi tiết khách trả breakdown + lịch sử', async () => {
    const cid = makeCustomer(1000000);
    await request(app)
      .post('/api/debt-ledger/quick-entry')
      .set(ADMIN)
      .send({ customerId: cid, content: '+100' });

    const res = await request(app).get(`/api/debt-ledger/customers/${cid}`).set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.data.balance).toBe(900000);
    expect(res.body.data.breakdown.payment).toBe(-100000);
    expect(res.body.data.transactions.length).toBeGreaterThan(0);
  });

  test('staff không xem được chi tiết khách không được phân công', async () => {
    const cid = makeCustomer(1000000);
    makeStaffUser('staff_a');
    const res = await request(app).get(`/api/debt-ledger/customers/${cid}`).set(STAFF);
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Đối soát
// ═══════════════════════════════════════════════════════════════════════════
describe('Đối soát sổ công nợ', () => {
  test('phát hiện đơn DELIVERED thiếu bút toán ORDER_DEBT', () => {
    const cid = makeCustomer(0);
    const saleId = makeSale(cid, 1500000);

    const result = DebtReconciliationService.run({ apply: false });
    const missing = result.issues.filter((i) => i.type === 'MISSING_ORDER_DEBT');
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.some((i) => i.saleId === saleId)).toBe(true);
  });

  test('xử lý đối soát ghi bút toán bù + audit log', () => {
    const cid = makeCustomer(0);
    const saleId = makeSale(cid, 1500000);

    const result = DebtReconciliationService.run({ apply: true, actor: 'admin' });
    expect(result.summary.applied).toBe(true);

    const tx = db
      .prepare(
        "SELECT * FROM debt_transactions WHERE reference_type = 'ORDER' AND reference_id = ? AND transaction_type = 'ORDER_DEBT'"
      )
      .get(String(saleId));
    expect(tx).toBeTruthy();
    expect(tx.amount).toBe(1500000);
    expect(tx.source).toBe('RECONCILIATION');

    const audit = db
      .prepare(
        "SELECT * FROM debt_audit_logs WHERE action = 'RECONCILE_FIX' AND transaction_id = ?"
      )
      .get(tx.id);
    expect(audit).toBeTruthy();
    expect(audit.actor_id).toBe('admin');

    assertIntegrity(cid);
  });

  test('đối soát 1 khách: ledger vs mirror vs chiếu', () => {
    const cid = makeCustomer(500000);
    const res = DebtReconciliationService.reconcileCustomer(cid);
    expect(res.success).toBe(true);
    expect(res.data.checks.mirrorMatches).toBe(true);
  });

  test('endpoint reconciliation yêu cầu admin', async () => {
    const res = await request(app).get('/api/debt-ledger/reconciliation').set(STAFF);
    expect(res.status).toBe(403);

    const res2 = await request(app).get('/api/debt-ledger/reconciliation').set(ADMIN);
    expect(res2.status).toBe(200);
    expect(res2.body.data.summary).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bridge status
// ═══════════════════════════════════════════════════════════════════════════
describe('Zalo Bridge status', () => {
  test('trạng thái bridge + đơn vị lệnh', async () => {
    const res = await request(app).get('/api/debt-ledger/bridge').set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.data.settings.commandUnit).toBe(1000);
    expect(typeof res.body.data.available).toBe('boolean');
  });
});
