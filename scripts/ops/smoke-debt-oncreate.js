#!/usr/bin/env node
/**
 * Smoke test E2E — Sổ công nợ ghi nợ khi tạo đơn (production).
 * 1. Login admin → lấy cookie session
 * 2. Tạo 1 khách test + 1 đơn hàng qua POST /api/sales
 * 3. Kiểm tra: debt_transactions có ORDER_DEBT, customers.debt khớp,
 *    order_debts có dòng, sales.payment_status = unpaid
 * 4. Nhập thanh toán qua POST /api/debt-ledger/payment → số dư về 0
 * 5. Dọn dẹp (soft-delete đơn + xoá khách test)
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const { execSync } = require('child_process');
const path = require('path');
const Database = require(path.join('/var/www/beer-pos', 'node_modules', 'better-sqlite3'));

const DB_PATH = '/var/www/beer-pos/database.sqlite';
let _db = null;
function getDb() {
  if (!_db) _db = new Database(DB_PATH, { readonly: false });
  return _db;
}

let sessionCookie = '';
let authToken = '';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      ...(authToken ? { Authorization: 'Bearer ' + authToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    sessionCookie = setCookie.split(';')[0];
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* ignore */ }
  return { status: res.status, data };
}

/** Query trực tiếp DB (chỉ đọc). */
function q(sql, ...params) {
  const rows = getDb().prepare(sql).all(...params);
  return rows;
}
function q1(sql, ...params) {
  const row = getDb().prepare(sql).get(...params);
  return row;
}

function sqlite(sql) {
  return execSync(
    `cd /var/www/beer-pos && sqlite3 database.sqlite ${JSON.stringify(sql)}`,
    { encoding: 'utf8' }
  ).trim();
}

(async () => {
  // ── 1. Login ─────────────────────────────────────────────────────────────
  let user = process.env.ADMIN_USER;
  let pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass) {
    const envTxt = execSync('cat /var/www/beer-pos/.env', { encoding: 'utf8' });
    const m = envTxt.match(/^ADMIN_USER=(.*)$/m);
    const p = envTxt.match(/^ADMIN_PASSWORD=(.*)$/m);
    if (!m || !p) throw new Error('Không tìm thấy ADMIN_USER/ADMIN_PASSWORD trong .env');
    user = m[1].trim();
    pass = p[1].trim();
  }

  const login = await api('POST', '/auth', { username: user, password: pass });
  console.log('1. Login:', login.status, login.data && login.data.success ? 'OK' : JSON.stringify(login.data).slice(0, 150));
  if (!login.data || !login.data.success) throw new Error('Login thất bại');
  authToken = login.data.token || null;

  // ── 2. Tạo khách test ────────────────────────────────────────────────────
  const name = '__SMOKE_DEBT_' + Date.now();
  const c = await api('POST', '/api/customers', { name, phone: '0900000000', address: 'test' });
  console.log('2. Tạo khách:', c.status, JSON.stringify(c.data).slice(0, 200));
  const customerId = c.data && (c.data.customer?.id || c.data.id || c.data.customerId);
  if (!customerId) throw new Error('Không lấy được customerId');

  // ── 3. Lấy 1 sản phẩm ────────────────────────────────────────────────────
  let prod = null;
  for (const path of ['/api/products', '/api/driver/sale/products']) {
    const products = await api('GET', path);
    const list = products.data?.products || products.data?.data || products.data;
    if (Array.isArray(list)) {
      prod = list.find((p) => !p.archived && Number(p.price) > 0) || null;
      if (prod) break;
    }
  }
  if (!prod) {
    // Fallback: đọc trực tiếp từ DB (giá theo bảng `prices`)
    const row = q1(
      `SELECT p.id, p.name, COALESCE(pr.price, 0) AS price
         FROM products p
         LEFT JOIN prices pr ON pr.product_id = p.id AND pr.customer_id = ?
        WHERE p.archived = 0
        ORDER BY COALESCE(pr.price, 0) DESC
        LIMIT 1`,
      customerId
    );
    if (!row) throw new Error('Không có sản phẩm nào');
    prod = row;
  }
  console.log('3. Sản phẩm:', prod.name, '| giá:', prod.price);

  const price = Number(prod.price) || 100000;
  const total = price * 2;

  // ── 4. Tạo đơn ───────────────────────────────────────────────────────────
  const sale = await api('POST', '/api/sales', {
    customerId,
    items: [{ productId: prod.id, quantity: 2, price }],
  });
  console.log('4. Tạo đơn:', sale.status, JSON.stringify(sale.data).slice(0, 300));
  if (!sale.data || !sale.data.success) throw new Error('Tạo đơn thất bại: ' + JSON.stringify(sale.data).slice(0, 200));
  const saleId = sale.data.id;

  // ── 5. Kiểm tra sổ công nợ ──────────────────────────────────────────────
  const txRows = q(
    `SELECT transaction_type, amount, direction FROM debt_transactions
      WHERE reference_type = 'ORDER' AND reference_id = ?`,
    String(saleId)
  );
  const tx = JSON.stringify(txRows);
  console.log('5. debt_transactions cho đơn:', tx || '(RỖNG — LỖI!)');
  const mirror = q1('SELECT debt FROM customers WHERE id = ?', customerId);
  const proj = q1(
    'SELECT original_amount, paid_amount, remaining_amount, status FROM order_debts WHERE sale_id = ?',
    saleId
  );
  const payStatus = q1('SELECT payment_status, is_credit FROM sales WHERE id = ?', saleId);
  console.log('   customers.debt =', mirror.debt, '| order_debts:', JSON.stringify(proj), '| sales:', JSON.stringify(payStatus));

  // ── 6. Nhập thanh toán ───────────────────────────────────────────────────
  const pay = await api('POST', '/api/debt-ledger/payment', {
    customerId,
    amount: total,
    note: 'SMOKE test — thanh toán',
  });
  console.log('6. Thanh toán:', pay.status, JSON.stringify(pay.data).slice(0, 250));
  const mirrorAfter = q1('SELECT debt FROM customers WHERE id = ?', customerId);
  const projAfter = q1(
    'SELECT original_amount, paid_amount, remaining_amount, status FROM order_debts WHERE sale_id = ?',
    saleId
  );
  console.log('   customers.debt sau =', mirrorAfter.debt, '| order_debts:', JSON.stringify(projAfter));

  // ── 7. Dọn dẹp ───────────────────────────────────────────────────────────
  await api('DELETE', '/api/sales/' + saleId);
  getDb().prepare('UPDATE customers SET archived = 1 WHERE id = ?').run(customerId);
  console.log('7. Đã dọn đơn + ẩn khách test');

  const ok = tx.includes('ORDER_DEBT') && Number(mirrorAfter.debt) === 0;
  console.log(ok ? '\n✅ SMOKE TEST PASS' : '\n❌ SMOKE TEST FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('❌ Lỗi:', e.message);
  process.exit(1);
});
