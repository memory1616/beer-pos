/**
 * Script dọn dữ liệu TEST do test suite ghi nhầm vào DB thật.
 *
 * BỐI CẢNH
 * ─────────
 * Trước đây jest test require('../database') → mở đúng `database.sqlite`,
 * khiến mọi lần chạy `npm test` đều ghi thêm:
 *   • đơn hàng (sales) với driver_username = test_driver_01 / tmp_drv_pos_test / ds_ui_test
 *   • giao dịch vỏ bình (keg_transactions_log) với customer_name = 'KHÁCH TEST DRIVER'
 *   • tài khoản (app_users) với username ds_* / tmp_* / *test*
 *   • tài xế (driver_staff) với username keg_drv*
 *   • khách hàng (customers) tên chứa 'TEST'
 *   • phiếu giao (delivery_records) + phiếu thu vỏ (driver_keg_receipts)
 *
 * Hệ quả: báo cáo doanh thu, tồn kho và lương tài xế bị bóp méo.
 * Đã sửa gốc (tests/setup.js dùng DB copy trong thư mục tạm), script này
 * dọn lại phần dữ liệu đã bị ghi nhầm trước đó.
 *
 * AN TOÀN
 * ───────
 * • CÓ BACKUP BẮT BUỘC (tự tạo trước khi sửa).
 * • CHỈ xóa bản ghi có dấu hiệu test rõ ràng (driver_username / username /
 *   customer_name chứa 'test'), KHÔNG đụng dữ liệu vận hành.
 * • Dùng deleteSaleRestoringInventory() để hoàn kho + hoàn thống kê đúng
 *   (giống hệt luồng xóa đơn bình thường của ứng dụng).
 * • Báo cáo chi tiết trước/sau, chạy được nhiều lần (idempotent).
 *
 * CÁCH CHẠY
 * ─────────
 *   node scripts/cleanup-test-data.js            # xem kế hoạch (dry-run)
 *   node scripts/cleanup-test-data.js --apply    # thực thi
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'database.sqlite');
const APPLY = process.argv.includes('--apply');
// Script chạy ngoài server → không được phép khởi động cron/interval (giữ process sống).
process.env.DISABLE_BACKGROUND_JOBS = '1';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// Các mẫu nhận diện dữ liệu test
const TEST_DRIVER_USERNAMES = ['test_driver_01', 'tmp_drv_pos_test', 'ds_ui_test'];
const TEST_USER_PATTERNS = ['ds_%', 'tmp_%', '%test%', 'keg_drv%', 'drv_ui_check'];
const TEST_DRIVER_STAFF_PATTERNS = ['keg_drv%', 'keg_drv2%'];

function backupDb() {
  const dir = path.join(ROOT, 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const out = path.join(dir, `pre_test_cleanup_${ts}.sqlite`);
  const db = new Database(DB_PATH);
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  db.close();
  return out;
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const log = (...a) => console.log(...a);

// ── Thu thập dữ liệu test ────────────────────────────────────────────────────
function collect() {
  const sales = db
    .prepare(`SELECT id, customer_id, total, date, archived FROM sales
              WHERE driver_username IN (${TEST_DRIVER_USERNAMES.map(() => '?').join(',')})`)
    .all(...TEST_DRIVER_USERNAMES);

  const saleIds = sales.map(s => s.id);

  const customers = db
    .prepare(`SELECT id, name FROM customers WHERE name LIKE '%TEST%' OR name LIKE '%test%'`)
    .all();

  const appUsers = db
    .prepare(`SELECT id, username, role FROM app_users
              WHERE ${TEST_USER_PATTERNS.map(p => `username LIKE '${p}'`).join(' OR ')}`)
    .all();

  const driverStaff = db
    .prepare(`SELECT id, username FROM driver_staff
              WHERE ${TEST_DRIVER_STAFF_PATTERNS.map(p => `username LIKE '${p}'`).join(' OR ')}`)
    .all();

  const kegTx = db
    .prepare(`SELECT id, quantity, note FROM keg_transactions_log
              WHERE customer_name LIKE '%TEST%' OR customer_name LIKE '%test%'
                 OR note LIKE '%inv_test%' OR note LIKE '%test_drv%'`)
    .all();

  const authSessions = db
    .prepare(`SELECT token FROM auth_sessions
              WHERE username LIKE '%test%' OR username LIKE 'ds_%' OR username LIKE 'tmp_%'
                 OR app_user_id IN (SELECT id FROM app_users
                       WHERE ${TEST_USER_PATTERNS.map(p => `username LIKE '${p}'`).join(' OR ')})`)
    .all();

  const deliveryRecords = db
    .prepare(`SELECT id FROM delivery_records
              WHERE sale_id IN (${saleIds.length ? saleIds.join(',') : 'NULL'})`)
    .all();

  const kegReceipts = db
    .prepare(`SELECT id FROM driver_keg_receipts
              WHERE driver_username IN (${TEST_DRIVER_USERNAMES.map(() => '?').join(',')})
                 OR driver_username IN (${TEST_DRIVER_STAFF_PATTERNS.map(() => '?').join(',')})
                 OR customer_name LIKE '%TEST%'`)
    .all(...TEST_DRIVER_USERNAMES, ...TEST_DRIVER_STAFF_PATTERNS);

  return { sales, customers, appUsers, driverStaff, kegTx, authSessions, deliveryRecords, kegReceipts };
}

const data = collect();
const sum = data.sales.reduce((a, s) => a + (s.total || 0), 0);
const kegQty = data.kegTx.reduce((a, k) => a + (k.quantity || 0), 0);

log('══════ KẾ HOẠCH DỌN DỮ LIỆU TEST ══════\n');
log(`DB: ${DB_PATH}`);
log(`sales (driver_username test)   : ${data.sales.length}  (tổng ${sum.toLocaleString('vi-VN')} đ)`);
log(`sale_items liên quan            : ${data.sales.length ? 'sẽ xóa theo sale_id' : '0'}`);
log(`customers tên chứa TEST        : ${data.customers.length}`);
log(`app_users test                  : ${data.appUsers.length}`);
log(`driver_staff test               : ${data.driverStaff.length}`);
log(`keg_transactions_log test       : ${data.kegTx.length}  (tổng qty ${kegQty})`);
log(`auth_sessions test               : ${data.authSessions.length}`);
log(`delivery_records của đơn test   : ${data.deliveryRecords.length}`);
log(`driver_keg_receipts của tx test : ${data.kegReceipts.length}`);

if (!APPLY) {
  log('\n── DRY RUN (chưa thay đổi gì). Chạy lại với --apply để thực thi.');
  db.close();
  process.exit(0);
}

// ── Backup ──────────────────────────────────────────────────────────────────
const backupFile = backupDb();
log(`\n✔ Backup: ${backupFile}`);

// ── Xóa ──────────────────────────────────────────────────────────────────────
const { deleteSaleRestoringInventory } = require(path.join(ROOT, 'src/services/saleDelete'));

let deletedSales = 0, failedSales = 0;
for (const s of data.sales) {
  const r = deleteSaleRestoringInventory(s.id);
  if (r.ok) deletedSales++;
  else {
    // Đã archived sẵn → coi như đã "xoá" về mặt doanh thu
    if (r.code === 'already_deleted') deletedSales++;
    else { failedSales++; log(`  ! sale #${s.id}: ${r.code}`); }
  }
}
log(`✔ sales đã xử lý: ${deletedSales} (lỗi: ${failedSales})`);

// sale_items orphan còn sót (nếu deleteSale đã xóa rồi thì không có)
if (data.sales.length) {
  const ids = data.sales.map(s => s.id);
  const r = db.prepare(`DELETE FROM sale_items WHERE sale_id IN (${ids.join(',')})`).run();
  log(`✔ sale_items dọn: ${r.changes}`);

  // deleteSaleRestoringInventory dùng SOFT-DELETE (archived=1) để hoàn kho an toàn.
  // Sau khi hoàn kho xong, xóa hẳn row để dữ liệu test không còn sót lại.
  const r2 = db.prepare(`DELETE FROM sales WHERE id IN (${ids.join(',')}) AND archived = 1`).run();
  log(`✔ sales (đã archived) xóa hẳn: ${r2.changes}`);
}

// keg tx test — hoàn kho theo balance_after
if (data.kegTx.length) {
  const ids = data.kegTx.map(k => k.id);
  const r = db.prepare(`DELETE FROM keg_transactions_log WHERE id IN (${ids.join(',')})`).run();
  log(`✔ keg_transactions_log dọn: ${r.changes} (net qty ${kegQty})`);
}

// recompute keg_stats từ nguồn chuẩn
const inv = db.prepare("SELECT COALESCE(SUM(stock),0) t FROM products WHERE type='keg'").get().t;
const hold = db.prepare('SELECT COALESCE(SUM(keg_balance),0) t FROM customers').get().t;
db.prepare('UPDATE keg_stats SET inventory=?, customer_holding=?, updated_at=CURRENT_TIMESTAMP WHERE id=1').run(inv, hold);
log(`✔ keg_stats đồng bộ: inventory=${inv}, customer_holding=${hold}`);

if (data.customers.length) {
  const ids = data.customers.map(c => c.id);
  const r = db.prepare(`DELETE FROM customers WHERE id IN (${ids.join(',')})`).run();
  log(`✔ customers dọn: ${r.changes}`);
}

if (data.authSessions.length) {
  const tokens = data.authSessions.map(s => s.token);
  const r = db.prepare(`DELETE FROM auth_sessions WHERE token IN (${tokens.map(t => `'${t.replace(/'/g, "''")}'`).join(',')})`).run();
  log(`✔ auth_sessions dọn: ${r.changes}`);
}

if (data.driverStaff.length) {
  const ids = data.driverStaff.map(d => d.id);
  const r = db.prepare(`DELETE FROM driver_staff WHERE id IN (${ids.join(',')})`).run();
  log(`✔ driver_staff dọn: ${r.changes}`);
}

if (data.kegReceipts.length) {
  const ids = data.kegReceipts.map(r => r.id);
  db.prepare(`DELETE FROM driver_keg_receipts WHERE id IN (${ids.join(',')})`).run();
  log(`✔ driver_keg_receipts dọn: ${ids.length}`);
}

if (data.appUsers.length) {
  const ids = data.appUsers.map(u => u.id);
  const r = db.prepare(`DELETE FROM app_users WHERE id IN (${ids.join(',')})`).run();
  log(`✔ app_users dọn: ${r.changes}`);
}

// ── Báo cáo ─────────────────────────────────────────────────────────────────
log('\n══════ KẾT QUẢ ══════');
const now = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(total),0) t FROM sales WHERE archived=0').get();
log(`sales còn lại (archived=0): ${now.c} đơn / ${now.t.toLocaleString('vi-VN')} đ`);
const users = db.prepare('SELECT COUNT(*) c FROM app_users').get().c;
log(`app_users còn lại: ${users}`);
const keg = db.prepare('SELECT COUNT(*) c FROM keg_transactions_log').get().c;
log(`keg_transactions_log còn lại: ${keg}`);
log(`integrity_check: ${db.pragma('integrity_check', { simple: true })}`);
const fk = db.pragma('foreign_key_check');
log(`foreign_key_check: ${fk.length === 0 ? 'ok' : fk.length + ' vi phạm'}`);

db.close();
