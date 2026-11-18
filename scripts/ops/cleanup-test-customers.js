#!/usr/bin/env node
/** Tìm & xoá khách test còn sót (SMOKE / __DEBT_ / __TEST_). */
const path = require('path');
const fs = require('fs');
const Database = require(path.join('/var/www/beer-pos', 'node_modules', 'better-sqlite3'));

const DB_PATH = '/var/www/beer-pos/database.sqlite';
const db = new Database(DB_PATH);

const rows = db
  .prepare(
    `SELECT id, name, phone, archived, debt, created_at
       FROM customers
      WHERE name LIKE '__SMOKE%'
         OR name LIKE '__DEBT%'
         OR name LIKE '__TEST%'
         OR name LIKE 'SMOKE%'
      ORDER BY id`
  )
  .all();

if (rows.length === 0) {
  console.log('Không còn khách test nào.');
  process.exit(0);
}
console.log('Khách test còn sót:');
rows.forEach((r) => console.log('  ', JSON.stringify(r)));

if (process.argv.includes('--apply')) {
  const TS = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const BACKUP = `/var/www/beer-pos/backups/database.sqlite.pre-testcust-cleanup.${TS}.bak`;
  // ⚠️ VACUUM INTO (không copyFile) vì DB ở chế độ WAL — copy thô sẽ thiếu
  // các transaction chưa checkpoint (mất đơn hàng mới nhất trong backup).
  db.exec(`VACUUM INTO '${BACKUP}'`);
  console.log('\nBackup:', BACKUP);

  const ids = rows.map((r) => r.id);
  const cleanup = db.transaction(() => {
    for (const id of ids) {
      db.prepare(
        `DELETE FROM debt_audit_logs WHERE transaction_id IN (
           SELECT id FROM debt_transactions WHERE customer_id = ?)`
      ).run(id);
      db.prepare('DELETE FROM debt_transactions WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM debt_accounts WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM order_debts WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM sales WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    }
  });
  cleanup();

  const left = db
    .prepare(
      `SELECT COUNT(*) c FROM customers
        WHERE name LIKE '__SMOKE%' OR name LIKE '__DEBT%' OR name LIKE '__TEST%' OR name LIKE 'SMOKE%'`
    )
    .get();
  console.log('Còn lại khách test:', left.c);
  console.log(left.c === 0 ? '\n✅ Đã xoá sạch khách test' : '\n⚠️  Vẫn còn');
} else {
  console.log('\n(chạy lại với --apply để xoá)');
}
