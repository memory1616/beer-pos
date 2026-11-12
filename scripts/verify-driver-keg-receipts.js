/**
 * Kiểm tra tích hợp CRUD PHIẾU THU VỎ (tài xế) qua HTTP thật.
 * Chạy: node scripts/verify-driver-keg-receipts.js
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const BASE = process.env.VERIFY_BASE || 'http://127.0.0.1:3000';

async function req(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch (_) { data = null; }
  return { status: res.status, data };
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (n, c, e) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (e ? ' → ' + JSON.stringify(e).slice(0, 300) : '')); }
  };

  require('dotenv').config();
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD;
  if (!adminPass) {
    console.log('  SKIP  Không có ADMIN_PASSWORD trong .env');
    process.exit(0);
  }

  // 1. Đăng nhập admin
  const login = await req('/auth', { method: 'POST', body: { username: adminUser, password: adminPass } });
  ok('đăng nhập admin', login.status === 200 && login.data?.token, login);
  const adminToken = login.data?.token;
  if (!adminToken) process.exit(1);

  // 2. Tạo tài xế test
  const uname = 'keg_drv_' + Date.now().toString().slice(-6);
  const created = await req('/api/admin/driver-staff', {
    method: 'POST', token: adminToken,
    body: { username: uname, password: 'KegPass123', fullName: 'Tài xế Phiếu Vỏ', monthlySalary: 5000000 },
  });
  ok('POST tạo tài xế', created.status === 201 && created.data.success === true, created);

  // 3. Đăng nhập Driver Portal
  const dlogin = await req('/auth/driver', { method: 'POST', body: { username: uname, password: 'KegPass123' } });
  ok('tài xế đăng nhập Driver Portal', dlogin.status === 200 && dlogin.data.success === true, dlogin);
  const token = dlogin.data?.token;
  if (!token) process.exit(1);

  // 4. Tạo khách hàng có tồn vỏ
  const custName = 'KH Test Phiếu Vỏ ' + Date.now().toString().slice(-6);
  const c = await req('/api/customers', {
    method: 'POST', token: adminToken,
    body: { name: custName, phone: '0900000000' },
  });
  ok('POST tạo khách hàng', c.status === 201 || c.status === 200, c);
  const custId = c.data?.customer?.id || c.data?.id;
  const kegsBefore = 20;

  // POST tạo khách luôn đặt keg_balance = 0 → set tồn vỏ qua PUT
  const putC = await req('/api/customers/' + custId, {
    method: 'PUT', token: adminToken,
    body: { keg_balance: kegsBefore },
  });
  ok('PUT set tồn vỏ khách = ' + kegsBefore, putC.status === 200, putC);
  const checkC = await req('/api/customers/' + custId, { token: adminToken });
  ok('tồn vỏ khách đã set', (checkC.data?.keg_balance ?? checkC.data?.customer?.keg_balance) === kegsBefore, checkC.data);

  // 5. Tạo phiếu thu vỏ
  const r1 = await req('/api/driver/keg-receipts', {
    method: 'POST', token,
    body: { customerId: custId, kegs: 5, note: 'Phiếu test' },
  });
  ok('POST tạo phiếu thu vỏ', r1.status === 201 && r1.data.success === true, r1);
  const receiptId = r1.data?.receipt?.id;

  // 6. Danh sách phiếu
  const list = await req('/api/driver/keg-receipts', { token });
  ok('GET danh sách phiếu', list.status === 200 && list.data.receipts.length >= 1, list);
  ok('danh sách có đúng phiếu vừa tạo',
    list.data.receipts.some((x) => x.id === receiptId), list.data.receipts?.[0]);

  // 7. Chi tiết phiếu
  const det = await req('/api/driver/keg-receipts/' + receiptId, { token });
  ok('GET chi tiết phiếu', det.status === 200 && det.data.receipt.id === receiptId, det);

  // 8. SỬA phiếu: 5 → 8 vỏ
  const upd = await req('/api/driver/keg-receipts/' + receiptId, {
    method: 'PATCH', token,
    body: { kegs: 8, note: 'Đã sửa phiếu' },
  });
  ok('PATCH sửa phiếu (tăng 5→8)', upd.status === 200 && upd.data.receipt.kegs === 8, upd);
  ok('PATCH cập nhật ghi chú', upd.data?.receipt?.note === 'Đã sửa phiếu', upd.data?.receipt);

  // 9. Kiểm tra tồn vỏ khách đã bị trừ đúng
  const afterEdit = await req('/api/customers/' + custId, { token: adminToken });
  const balAfterEdit = afterEdit.data?.keg_balance ?? afterEdit.data?.customer?.keg_balance;
  ok('tồn vỏ khách sau khi sửa = before - 8',
    balAfterEdit === kegsBefore - 8, { kegsBefore, balAfterEdit });

  // 10. SỬA phiếu: 8 → 3 vỏ (hoàn lại 5 vỏ)
  const upd2 = await req('/api/driver/keg-receipts/' + receiptId, {
    method: 'PATCH', token,
    body: { kegs: 3 },
  });
  ok('PATCH sửa phiếu (giảm 8→3)', upd2.status === 200 && upd2.data.receipt.kegs === 3, upd2);
  const afterEdit2 = await req('/api/customers/' + custId, { token: adminToken });
  const bal2 = afterEdit2.data?.keg_balance ?? afterEdit2.data?.customer?.keg_balance;
  ok('tồn vỏ khách sau khi giảm = before - 3',
    bal2 === kegsBefore - 3, { kegsBefore, bal2 });

  // 11. Sửa với số vỏ không hợp lệ → lỗi
  const bad = await req('/api/driver/keg-receipts/' + receiptId, {
    method: 'PATCH', token, body: { kegs: 0 },
  });
  ok('PATCH số vỏ = 0 bị từ chối', bad.status === 400, bad);

  // 12. XOÁ phiếu → hoàn lại vỏ
  const del = await req('/api/driver/keg-receipts/' + receiptId, { method: 'DELETE', token });
  ok('DELETE xoá phiếu', del.status === 200 && del.data.success === true, del);

  const afterDel = await req('/api/customers/' + custId, { token: adminToken });
  const bal3 = afterDel.data?.keg_balance ?? afterDel.data?.customer?.keg_balance;
  ok('tồn vỏ khách được hoàn lại đủ', bal3 === kegsBefore, { kegsBefore, bal3 });

  // 13. Phiếu đã xoá không còn trong danh sách
  const list2 = await req('/api/driver/keg-receipts', { token });
  ok('phiếu đã xoá không còn trong danh sách',
    !list2.data.receipts.some((x) => x.id === receiptId), list2.data.receipts);

  // 14. Xoá phiếu không tồn tại → 400
  const del2 = await req('/api/driver/keg-receipts/99999999', { method: 'DELETE', token });
  ok('DELETE phiếu không tồn tại → lỗi', del2.status === 400, del2);

  // 15. Tài xế khác KHÔNG xoá được phiếu của tài xế này
  const uname2 = 'keg_drv2_' + Date.now().toString().slice(-6);
  await req('/api/admin/driver-staff', {
    method: 'POST', token: adminToken,
    body: { username: uname2, password: 'KegPass123', fullName: 'Tài xế 2' },
  });
  const dlogin2 = await req('/auth/driver', { method: 'POST', body: { username: uname2, password: 'KegPass123' } });
  const token2 = dlogin2.data?.token;
  const r2 = await req('/api/driver/keg-receipts', {
    method: 'POST', token: token2, body: { customerId: custId, kegs: 2 },
  });
  ok('tài xế 2 tạo phiếu riêng', r2.status === 201, r2);
  const crossDel = await req('/api/driver/keg-receipts/' + r2.data?.receipt?.id, { method: 'DELETE', token });
  ok('tài xế 1 KHÔNG xoá được phiếu của tài xế 2', crossDel.status === 400, crossDel);

  // Dọn dẹp
  const db = require('../database');
  db.prepare('DELETE FROM driver_keg_receipts WHERE driver_username IN (?, ?)').run(uname, uname2);
  db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(kegsBefore, custId);
  db.prepare('DELETE FROM customers WHERE id = ?').run(custId);
  db.prepare('DELETE FROM driver_staff WHERE username IN (?, ?)').run(uname, uname2);
  db.prepare('DELETE FROM app_users WHERE username IN (?, ?)').run(uname, uname2);

  console.log(`\n=== KẾT QUẢ: ${pass} pass / ${fail} fail ===`);
  process.exit(fail > 0 ? 1 : 0);
})();
