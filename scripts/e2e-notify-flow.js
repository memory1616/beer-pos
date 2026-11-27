/**
 * E2E: Thanh toán → tạo job → worker gửi (mock) → cập nhật trạng thái.
 * Chạy LOCAL, dùng DB thật local rồi dọn dẹp dữ liệu test.
 */
process.env.NODE_ENV = 'test';
process.env.NOTIFICATION_PROVIDER = 'mock';

const db = require('../database');
const DebtPaymentService = require('../src/services/debt/DebtPaymentService');
const DebtLedgerService = require('../src/services/debt/DebtLedgerService');
const CustomerGroupService = require('../src/services/notify/CustomerGroupService');
const NotificationJobService = require('../src/services/notify/NotificationJobService');
const { NotificationWorker } = require('../src/services/notify/NotificationWorker');
const { TRANSACTION_TYPES, SOURCES } = require('../src/services/debt/constants');

const USER = { username: 'admin', role: 'ADMIN' };
const TAG = '__E2E_NOTIFY__';

function seedDebt(customerId, amount) {
  return DebtLedgerService.recordTransaction({
    customerId,
    transactionType: TRANSACTION_TYPES.MANUAL_DEBT,
    amount,
    direction: DebtLedgerService.DIRECTION.INCREASE,
    source: SOURCES.MANUAL_UI,
    description: TAG + ' ghi nợ',
  });
}

function cleanup() {
  db.prepare('DELETE FROM debt_notification_jobs WHERE customer_name LIKE ?').run('%' + TAG + '%');
  db.prepare('DELETE FROM debt_notifications WHERE customer_name LIKE ?').run('%' + TAG + '%');
  db.prepare('DELETE FROM debt_customer_groups WHERE group_name LIKE ?').run('%' + TAG + '%');
  db.prepare("DELETE FROM debt_transactions WHERE description LIKE ?").run('%' + TAG + '%');
  db.prepare('DELETE FROM customers WHERE name LIKE ?').run('%' + TAG + '%');
}

/** Bật thông báo (mặc định tắt) trong khi chạy E2E, rồi khôi phục. */
function setNotifyEnabled(enabled) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('debt_notify_enabled', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(enabled ? '1' : '0');
}

(async () => {
  cleanup();

  // Bật thông báo trong lúc E2E (khôi phục ở finally).
  const prevNotify = db.prepare("SELECT value FROM settings WHERE key = 'debt_notify_enabled'").get();
  setNotifyEnabled(true);
  try {

  // ── Tạo khách hàng test ───────────────────────────────────────────────────
  const info = db
    .prepare('INSERT INTO customers (name, phone, created_at) VALUES (?, ?, datetime(\'now\'))')
    .run(TAG + ' Khách', '0900' + Date.now().toString().slice(-6));
  const custId = info.lastInsertRowid;
  console.log('Khách test id =', custId);

  // ── Ghi nợ trước để khách có công nợ ─────────────────────────────────────
  seedDebt(custId, 200000);
  console.log('Số dư công nợ =', DebtLedgerService.computeBalance(custId));

  // ── THỦNG THỦ: chưa có nhóm → payment vẫn thành công, job = no_group ─────
  const payNoGroup = await DebtPaymentService.recordPayment({
    customerId: custId,
    amount: 50000,
    type: 'payment',
    note: TAG + ' nội bộ',
    user: USER,
    source: 'MANUAL_UI',
  });
  console.log('\n[1] Thanh toán KHÔNG có nhóm → success =', payNoGroup.success);
  const jobsNoGroup = db
    .prepare("SELECT * FROM debt_notification_jobs WHERE customer_id = ? ORDER BY id")
    .all(custId);
  console.log('    jobs:', jobsNoGroup.map((j) => j.status + '/' + j.group_id).join(', ') || '(none)');

  // ── Liên kết nhóm ─────────────────────────────────────────────────────────
  const gid = 'E2E_GRP_' + Date.now();
  const link = CustomerGroupService.upsert({
    customerId: custId,
    groupId: gid,
    groupName: TAG + ' Nhóm',
    platform: 'zalo_personal',
  });
  console.log('\n[2] Liên kết nhóm →', link.success, link.data && link.data.group_id);

  // ── Thanh toán có nhóm → tạo job queued ───────────────────────────────────
  const pay = await DebtPaymentService.recordPayment({
    customerId: custId,
    amount: 75000,
    type: 'payment',
    note: TAG + ' nội bộ',
    user: USER,
    source: 'MANUAL_UI',
  });
  console.log('\n[3] Thanh toán CÓ nhóm → success =', pay.success);
  const jobs = db
    .prepare('SELECT * FROM debt_notification_jobs WHERE customer_id = ? ORDER BY id')
    .all(custId);
  jobs.forEach((j) =>
    console.log(
      `    job#${j.id} status=${j.status} grp=${j.group_id} attempts=${j.attempts} key=${j.idempotency_key}`
    )
  );
  console.log('    snapshot nội dung:', (jobs[jobs.length - 1] || {}).content_snapshot);

  // ── Idempotency: gọi lại enqueue cùng transaction → không tạo job mới ─────
  const before = db.prepare('SELECT COUNT(*) c FROM debt_notification_jobs WHERE customer_id = ?').get(custId).c;
  const dup = NotificationJobService.enqueueJob({
    customerId: custId,
    customerName: TAG + ' Khách',
    transactionId: jobs[jobs.length - 1].transaction_id,
    eventType: 'payment',
    groupId: gid,
    groupName: TAG + ' Nhóm',
    content: jobs[jobs.length - 1].content_snapshot,
    amount: 75000,
    applied: 75000,
    balanceAfter: 0,
    source: 'MANUAL_UI',
  });
  const after = db.prepare('SELECT COUNT(*) c FROM debt_notification_jobs WHERE customer_id = ?').get(custId).c;
  console.log('\n[4] Idempotency → duplicate =', dup.duplicate, '| số job trước/sau:', before, '/', after);

  // ── Worker xử lý job ─────────────────────────────────────────────────────
  const worker = new NotificationWorker({ workerId: 'e2e-worker', intervalMs: 60000 });
  const res = await worker.runOnce();
  console.log('\n[5] Worker runOnce →', JSON.stringify(res));

  const finalJobs = db
    .prepare('SELECT id,status,attempts,provider,provider_message_id,delivery_status,last_error FROM debt_notification_jobs WHERE customer_id = ? ORDER BY id')
    .all(custId);
  finalJobs.forEach((j) =>
    console.log(
      `    job#${j.id} status=${j.status} attempts=${j.attempts} provider=${j.provider} msgId=${j.provider_message_id} delivery=${j.delivery_status} err=${j.last_error || '-'}`
    )
  );

  const hist = db
    .prepare('SELECT id, customer_name, group_id, status, amount FROM debt_notifications WHERE customer_id = ?')
    .all(custId);
  console.log('\n[6] Lịch sử gửi:', JSON.stringify(hist));

  cleanup();
  // Khôi phục setting thông báo
  if (prevNotify) setNotifyEnabled(prevNotify.value === '1');
  else db.prepare("DELETE FROM settings WHERE key = 'debt_notify_enabled'").run();
  console.log('\n→ Đã dọn dẹp dữ liệu test + khôi phục setting.');
  process.exit(0);
  } catch (e) {
    console.error('E2E ERROR:', e.message, e.stack);
    try {
      cleanup();
      if (prevNotify) setNotifyEnabled(prevNotify.value === '1');
      else db.prepare("DELETE FROM settings WHERE key = 'debt_notify_enabled'").run();
    } catch (_) {}
    process.exit(1);
  }
})().catch((e) => {
  console.error('E2E FATAL:', e.message, e.stack);
  process.exit(1);
});
