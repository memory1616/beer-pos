/**
 * Kiểm tra tích hợp endpoint tài xế qua HTTP thật (server local).
 * Chạy: node scripts/verify-driver-staff-endpoints.js
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const BASE = process.env.VERIFY_BASE || 'http://127.0.0.1:3301';

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
    else { fail++; console.log('  FAIL  ' + n + (e ? ' → ' + JSON.stringify(e) : '')); }
  };

  // Đăng nhập admin từ env
  require('dotenv').config();
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.log('  SKIP  Không có ADMIN_PASSWORD trong .env');
    process.exit(0);
  }

  const login = await req('/auth', { method: 'POST', body: { username, password } });
  ok('đăng nhập admin', login.status === 200 && login.data?.token, login);
  const token = login.data?.token;
  if (!token) { process.exit(1); }

  // Danh sách tài xế
  const list = await req('/api/admin/driver-staff', { token });
  ok('GET /api/admin/driver-staff', list.status === 200 && list.data.success === true, list);

  // Tạo tài xế test
  const uname = 'verify_drv_' + Date.now().toString().slice(-6);
  const created = await req('/api/admin/driver-staff', {
    method: 'POST', token,
    body: { username: uname, password: 'VerifyPass123', fullName: 'Tài xế Verify', monthlySalary: 5000000 },
  });
  ok('POST /api/admin/driver-staff', created.status === 201 && created.data.success === true, created);
  const driverId = created.data?.id;

  // Tài xế đăng nhập được
  const dlogin = await req('/auth/driver', { method: 'POST', body: { username: uname, password: 'VerifyPass123' } });
  ok('tài xế đăng nhập Driver Portal', dlogin.status === 200 && dlogin.data.success === true, dlogin);
  const driverToken = dlogin.data?.token;

  // Driver KHÔNG được truy cập API tài xế
  if (driverToken) {
    const forbidden = await req('/api/admin/driver-staff', { token: driverToken });
    ok('driver bị chặn 403', forbidden.status === 403, forbidden);
  }

  // Bảng lương tháng
  const now = new Date();
  const year = now.getFullYear(), month = now.getMonth() + 1;
  const summary = await req(`/api/admin/driver-staff/salary/summary?year=${year}&month=${month}`, { token });
  ok('GET bảng lương tháng', summary.status === 200 && Array.isArray(summary.data.data), summary);

  // Thiết lập lương
  const setSalary = await req(`/api/admin/driver-staff/${driverId}/salary`, {
    method: 'PUT', token,
    body: { year, month, baseSalary: 5000000, bonus: 500000, deduction: 100000 },
  });
  ok('PUT lương tài xế', setSalary.status === 200 && setSalary.data.data.total === 5400000, setSalary);

  // Đánh dấu đã trả
  const paid = await req(`/api/admin/driver-staff/${driverId}/salary/paid`, {
    method: 'POST', token, body: { year, month, paid: true },
  });
  ok('POST đánh dấu đã trả', paid.status === 200, paid);

  // Lịch sử
  const hist = await req(`/api/admin/driver-staff/${driverId}/salary-history`, { token });
  ok('GET lịch sử lương', hist.status === 200 && hist.data.data.length > 0, hist);

  // Khoá tài xế
  const del = await req(`/api/admin/driver-staff/${driverId}`, { method: 'DELETE', token });
  ok('DELETE khoá tài xế', del.status === 200 && del.data.success === true, del);

  // Dọn dẹp
  const db = require('../database');
  db.prepare('DELETE FROM driver_monthly_salary WHERE driver_id IN (SELECT id FROM driver_staff WHERE username = ?)').run(uname);
  db.prepare('DELETE FROM driver_staff WHERE username = ?').run(uname);
  db.prepare('DELETE FROM app_users WHERE username = ?').run(uname);

  console.log(`\n=== KẾT QUẢ: ${pass} pass / ${fail} fail ===`);
  process.exit(fail > 0 ? 1 : 0);
})();
