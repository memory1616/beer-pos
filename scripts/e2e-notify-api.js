/**
 * Kiểm tra API thông báo Zalo end-to-end trên LOCAL (không mở port thật).
 * Dùng pattern giống tests/debt/notifyApi.test.js (middleware x-test-user).
 */
process.env.NODE_ENV = 'test';
process.env.NOTIFICATION_PROVIDER = 'mock';

const path = require('path');
const request = require('supertest');
const express = require('express');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const username = req.headers['x-test-user'];
  if (username) {
    req.user = { username: String(username), role: req.headers['x-test-role'] || 'ADMIN' };
  }
  next();
});
app.use('/api/debt-ledger', require(path.join(__dirname, '..', 'routes', 'api', 'debtLedger')));

const ADMIN = { 'x-test-user': 'admin', 'x-test-role': 'ADMIN' };
const STAFF = { 'x-test-user': 'staff_a', 'x-test-role': 'STAFF' };

(async () => {
  const endpoints = [
    ['GET', '/api/debt-ledger/notify/summary', ADMIN],
    ['GET', '/api/debt-ledger/notify/provider-status', ADMIN],
    ['GET', '/api/debt-ledger/notify/jobs', ADMIN],
    ['GET', '/api/debt-ledger/notify/customer-groups', ADMIN],
    ['GET', '/api/debt-ledger/notify/history', ADMIN],
    ['GET', '/api/debt-ledger/notify/settings', ADMIN],
    ['GET', '/api/debt-ledger/notify/jobs', STAFF],
    ['GET', '/api/debt-ledger/notify/jobs', { 'x-test-user': 'cust_x', 'x-test-role': 'CUSTOMER' }],
  ];

  for (const [method, url, hdr] of endpoints) {
    const res = await request(app)[method.toLowerCase()](url).set(hdr);
    console.log(`${method} ${url} [${hdr['x-test-role']}] → ${res.status}  ${JSON.stringify(res.body || {}).slice(0, 260)}`);
  }

  // ── Tạo mapping 1:1 ──────────────────────────────────────────────────────
  const custRes = await request(app).get('/api/debt-ledger/customers?limit=3').set(ADMIN);
  const d = custRes.body && custRes.body.data;
  const list = (d && (d.customers || d.items || d)) || [];
  const cust = Array.isArray(list) ? list[0] : null;
  console.log('\nKhách hàng đầu tiên:', cust ? cust.id : '(không có)');

  if (cust) {
    const gid = 'E2E_GRP_' + Date.now();
    const created = await request(app)
      .post('/api/debt-ledger/notify/customer-groups')
      .set(ADMIN)
      .send({ customerId: cust.id, groupId: gid, groupName: 'Công nợ E2E', platform: 'zalo_personal' });
    console.log('POST customer-groups →', created.status, JSON.stringify(created.body).slice(0, 300));

    // Trùng group_id (khách khác) → phải bị từ chối
    const dupG = await request(app)
      .post('/api/debt-ledger/notify/customer-groups')
      .set(ADMIN)
      .send({ customerId: cust.id + 99999, groupId: gid, groupName: 'Trùng gid', platform: 'zalo_personal' });
    console.log('POST trùng group_id →', dupG.status, JSON.stringify(dupG.body).slice(0, 220));

    // Khách khác liên kết group_id khác → OK, rồi thử gắn thêm group thứ 2 cho cust
    const second = await request(app)
      .post('/api/debt-ledger/notify/customer-groups')
      .set(ADMIN)
      .send({ customerId: cust.id, groupId: gid + '_2', groupName: 'Nhóm thứ 2', platform: 'zalo_personal' });
    console.log('POST khách đã có nhóm (group khác) →', second.status, JSON.stringify(second.body).slice(0, 260));

    // GET theo khách
    const one = await request(app).get('/api/debt-ledger/notify/customer-groups/' + cust.id).set(ADMIN);
    console.log('GET customer-groups/:customerId →', one.status, JSON.stringify(one.body).slice(0, 260));

    // Gỡ liên kết
    const id = created.body && created.body.data && created.body.data.id;
    const del = await request(app).delete('/api/debt-ledger/notify/customer-groups/' + id).set(ADMIN);
    console.log('DELETE customer-groups →', del.status, JSON.stringify(del.body).slice(0, 220));
  }

  console.log('\nE2E DONE');
  process.exit(0);
})().catch((e) => {
  console.error('E2E ERROR:', e.message, e.stack);
  process.exit(1);
});
