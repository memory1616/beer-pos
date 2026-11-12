/**
 * Xác minh production: module Quản lý Tài xế & Lương
 * Chạy: node scripts/verify-driver-staff-production.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const BASE = process.env.PROD_BASE || 'https://admin.biatuoitayninh.store';

async function req(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data;
  try { data = await res.json(); } catch (_) { data = null; }
  return { status: res.status, data };
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (n, c, e) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (e ? ' → ' + JSON.stringify(e) : '')); }
  };

  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD;

  // 1. Trang /sales-staff có 2 tab mới
  const page = await fetch(BASE + '/sales-staff');
  const html = await page.text();
  ok('trang /sales-staff trả 200', page.status === 200, page.status);
  ok('tab "Tài xế" hiển thị', html.includes('id="tab-drivers"'));
  ok('tab "Lương tài xế" hiển thị', html.includes('id="tab-driverSalary"'));
  ok('tab "Lương tài xế" hiển thị', html.includes('id="content-driverSalary"'));

  // 2. API bắt buộc đăng nhập
  const anon = await req('/api/admin/driver-staff');
  ok('API chưa đăng nhập → 401', anon.status === 401, anon);

  // 3. Đăng nhập admin
  const login = await req('/auth', { method: 'POST', body: { username, password } });
  ok('đăng nhập admin', login.status === 200 && login.data?.token, login);
  const token = login.data?.token;
  if (!token) { console.log('\nKhông lấy được token — dừng.'); process.exit(1); }

  // 4. Danh sách tài xế
  const list = await req('/api/admin/driver-staff', { token });
  ok('GET danh sách tài xế', list.status === 200 && list.data.success === true, list);
  ok('response không chứa password_hash', !JSON.stringify(list.data).includes('password_hash'));

  // 5. Bảng lương tháng
  const now = new Date();
  const year = now.getFullYear(), month = now.getMonth() + 1;
  const summary = await req(`/api/admin/driver-staff/salary/summary?year=${year}&month=${month}`, { token });
  ok('GET bảng lương tháng', summary.status === 200 && Array.isArray(summary.data.data), summary);

  // 6. Tạo tài xế test → đăng nhập Driver Portal → khoá
  const uname = 'prod_verify_' + Date.now().toString().slice(-6);
  const created = await req('/api/admin/driver-staff', {
    method: 'POST', token,
    body: { username: uname, password: 'ProdVerify123', fullName: 'Tài xế Prod Verify', monthlySalary: 5000000 },
  });
  ok('POST tạo tài xế', created.status === 201 && created.data.success === true, created);
  const driverId = created.data?.id;

  const dlogin = await req('/auth/driver', { method: 'POST', body: { username: uname, password: 'ProdVerify123' } });
  ok('tài xế đăng nhập Driver Portal', dlogin.status === 200 && dlogin.data.success === true, dlogin);
  const driverToken = dlogin.data?.token;

  if (driverToken) {
    const forbidden = await req('/api/admin/driver-staff', { token: driverToken });
    ok('driver bị chặn 403', forbidden.status === 403, forbidden);
    const forbidden2 = await req('/api/admin/driver-staff/salary/summary', { token: driverToken });
    ok('driver bị chặn khỏi bảng lương', forbidden2.status === 403, forbidden2);
  }

  // 7. Lương tháng
  const setSalary = await req(`/api/admin/driver-staff/${driverId}/salary`, {
    method: 'PUT', token,
    body: { year, month, baseSalary: 5000000, bonus: 500000, deduction: 100000 },
  });
  ok('PUT lương tài xế', setSalary.status === 200 && setSalary.data.data.total === 5400000, setSalary);

  const paid = await req(`/api/admin/driver-staff/${driverId}/salary/paid`, {
    method: 'POST', token, body: { year, month, paid: true },
  });
  ok('POST đánh dấu đã trả', paid.status === 200, paid);

  const hist = await req(`/api/admin/driver-staff/${driverId}/salary-history`, { token });
  ok('GET lịch sử lương', hist.status === 200 && hist.data.data.length > 0, hist);

  // 8. Khoá tài xế
  const del = await req(`/api/admin/driver-staff/${driverId}`, { method: 'DELETE', token });
  ok('DELETE khoá tài xế', del.status === 200 && del.data.success === true, del);

  const dlogin2 = await req('/auth/driver', { method: 'POST', body: { username: uname, password: 'ProdVerify123' } });
  ok('tài khoản đã khoá không đăng nhập được', dlogin2.status === 401, dlogin2);

  // 9. Trang Driver Portal vẫn hoạt động
  const dpage = await fetch('https://giaohang.biatuoitayninh.store/auth/driver');
  ok('trang đăng nhập Driver Portal trả 200', dpage.status === 200, dpage.status);

  console.log(`\n=== KẾT QUẢ: ${pass} pass / ${fail} fail ===`);
  process.exit(fail > 0 ? 1 : 0);
})();
