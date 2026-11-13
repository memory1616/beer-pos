/**
 * Dọn dữ liệu test Sổ công nợ (khách "ZZ TEST SMOKE DEBT" + bút toán liên quan).
 *
 * ⚠️ CHỈ dùng cho dữ liệu THỬ NGHIỆM do smoke test tạo ra.
 *    KHÔNG chạy trên dữ liệu kinh doanh thật.
 */
process.env.TZ = 'Asia/Ho_Chi_Minh';

const db = require('../database');

const MARKER = 'ZZ TEST SMOKE DEBT';

const ids = db
  .prepare('SELECT id FROM customers WHERE name = ?')
  .all(MARKER)
  .map((r) => r.id);

if (!ids.length) {
  console.log('Không có khách test để dọn.');
  process.exit(0);
}

const ph = ids.map(() => '?').join(',');
const txIds = db
  .prepare(`SELECT id FROM debt_transactions WHERE customer_id IN (${ph})`)
  .all(...ids)
  .map((r) => r.id);

console.log(`Dọn ${ids.length} khách test (${ids.join(', ')}), ${txIds.length} bút toán...`);

const tx = db.transaction(() => {
  // 1. Audit logs của các bút toán test
  if (txIds.length) {
    const tph = txIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM debt_audit_logs WHERE transaction_id IN (${tph})`).run(...txIds);
  }
  // 2. Bút toán test
  db.prepare(`DELETE FROM debt_transactions WHERE customer_id IN (${ph})`).run(...ids);
  // 3. Bridge events của nhóm manual test
  db.prepare(
    `DELETE FROM debt_bridge_events
      WHERE group_id LIKE 'manual:%' AND sender_id = 'admin'`
  ).run();
  // 4. Processed events của quick-entry test
  db.prepare(`DELETE FROM debt_processed_events WHERE event_id LIKE 'manual:%'`).run();
  // 5. Debt accounts
  db.prepare(`DELETE FROM debt_accounts WHERE customer_id IN (${ph})`).run(...ids);
  // 6. Order debts projection
  db.prepare(`DELETE FROM order_debts WHERE customer_id IN (${ph})`).run(...ids);
  // 7. Khách test
  db.prepare(`DELETE FROM customers WHERE id IN (${ph})`).run(...ids);
});

tx();

console.log('Đã dọn xong.');

// Verify
const total = db
  .prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='INCREASE' THEN amount ELSE -amount END),0) s
       FROM debt_transactions`
  )
  .get().s;
const mirror = db.prepare('SELECT COALESCE(SUM(debt),0) s FROM customers').get().s;
const cnt = db.prepare('SELECT COUNT(*) n FROM customers WHERE name = ?').get(MARKER).n;

console.log(`  ledger total   : ${total}`);
console.log(`  mirror total   : ${mirror}`);
console.log(`  con khach test : ${cnt}`);
console.log(Math.abs(total - mirror) < 0.01 ? '✅ Toàn vẹn OK' : '❌ VẪN LỆCH');
