#!/usr/bin/env node
/**
 * RESET Sổ công nợ trên production — đặt công nợ TẤT CẢ khách về 0.
 *
 * ⚠️ DỮ LIỆU THẬT — luôn backup DB trước khi ghi.
 *
 * Xóa:
 *   - debt_transactions   (sổ cái)
 *   - debt_audit_logs     (audit log sổ công nợ)
 *   - debt_accounts       (tài khoản công nợ / opening balance)
 *   - debt_processed_events, debt_bridge_events (event id dạng manual:/smoke-)
 *   - customers.debt      → 0 cho tất cả
 *   - payments tạo trong lúc smoke test (2026-11-13) — artifact của test
 *
 * KHÔNG đụng:
 *   - customers (giữ nguyên danh sách khách)
 *   - sales, order_debts, khách hàng
 *   - payments cũ (trước 2026-11-13) — lịch sử thu tiền thật
 *   - settings (debt_command_unit, ...)
 *
 * Dùng: node scripts/ops/reset-debt-to-zero.js [dbPath]
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.argv[2] || path.join(__dirname, '..', '..', 'database.sqlite');
const db = new Database(dbPath);

const one = (sql) => db.prepare(sql).get();

function snapshot(label) {
  console.log(`\n--- ${label} ---`);
  console.log('debt_accounts      :', one('SELECT COUNT(*) n FROM debt_accounts').n);
  console.log('debt_transactions :', one('SELECT COUNT(*) n FROM debt_transactions').n);
  console.log('debt_audit_logs   :', one('SELECT COUNT(*) n FROM debt_audit_logs').n);
  console.log('ledger_total      :', one("SELECT COALESCE(SUM(CASE WHEN direction='INCREASE' THEN amount ELSE -amount END),0) s FROM debt_transactions").s);
  console.log('mirror_total      :', one('SELECT COALESCE(SUM(debt),0) s FROM customers').s);
  console.log('customers debt!=0 :', one('SELECT COUNT(*) n FROM customers WHERE debt != 0').n);
  console.log('customers total   :', one('SELECT COUNT(*) n FROM customers').n);
  console.log('payments          :', one('SELECT COUNT(*) n FROM payments').n);
  console.log('processed_events  :', one('SELECT COUNT(*) n FROM debt_processed_events').n);
  console.log('bridge_events     :', one('SELECT COUNT(*) n FROM debt_bridge_events').n);
}

console.log('DB:', dbPath);
snapshot('TRƯỚC KHI RESET');

// ── Backup ───────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(__dirname, '..', '..', 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const backupFile = path.join(backupDir, `database.sqlite.pre-debtreset.${stamp}.bak`);
fs.copyFileSync(dbPath, backupFile);
console.log('\nBackup:', backupFile);

// ── Reset ────────────────────────────────────────────────────────────────────
const tx = db.transaction(() => {
  db.prepare('DELETE FROM debt_audit_logs').run();
  db.prepare('DELETE FROM debt_transactions').run();
  db.prepare('DELETE FROM debt_accounts').run();
  db.prepare(
    `DELETE FROM debt_processed_events WHERE event_id LIKE 'manual:%' OR event_id LIKE 'smoke-%'`
  ).run();
  db.prepare(`DELETE FROM debt_bridge_events WHERE group_id LIKE 'manual:%'`).run();
  db.prepare('UPDATE customers SET debt = 0 WHERE debt != 0').run();
  // Artifact smoke test 2026-11-13 (khách 7 & 11) — KHÔNG đụng payments cũ.
  const rmPayments = db
    .prepare(
      `DELETE FROM payments WHERE created_at >= '2026-11-13' AND created_at < '2026-11-14'`
    ).run();
  console.log('payments smoke-test đã xoá:', rmPayments.changes);
});
tx();

snapshot('SAU KHI RESET');

// ── Kiểm tra toàn vẹn ───────────────────────────────────────────────────────
const lt = one(
  "SELECT COALESCE(SUM(CASE WHEN direction='INCREASE' THEN amount ELSE -amount END),0) s FROM debt_transactions"
).s;
const mt = one('SELECT COALESCE(SUM(debt),0) s FROM customers').s;
const mism = db
  .prepare(
    `SELECT COUNT(*) n FROM customers c
      LEFT JOIN debt_transactions dt ON dt.customer_id = c.id
     GROUP BY c.id
    HAVING ABS(COALESCE(c.debt,0) - COALESCE(SUM(CASE WHEN dt.direction='INCREASE' THEN dt.amount ELSE -dt.amount END),0)) > 0.5`
  )
  .all().length;

console.log('\n--- KIỂM TRA ---');
console.log('ledger vs mirror:', Math.abs(lt - mt) < 0.01 ? '✅ khớp' : '❌ lệch');
console.log('mismatch count  :', mism === 0 ? '✅ 0' : '❌ ' + mism);
console.log('tất cả = 0     :', lt === 0 && mt === 0 ? '✅' : '❌');
