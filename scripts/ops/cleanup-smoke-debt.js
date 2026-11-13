#!/usr/bin/env node
/**
 * Dọn dữ liệu smoke test của module Sổ công nợ (ghi nợ khi tạo đơn).
 * Chỉ xoá bút toán thuộc đơn test `__SMOKE_DEBT_*` / khách test.
 * CÓ BACKUP database trước khi xoá.
 */
const path = require('path');
const fs = require('fs');
const Database = require(path.join('/var/www/beer-pos', 'node_modules', 'better-sqlite3'));

const DB_PATH = '/var/www/beer-pos/database.sqlite';
const TS = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const BACKUP = `/var/www/beer-pos/backups/database.sqlite.pre-smoke-cleanup.${TS}.bak`;

const db = new Database(DB_PATH);

// 1. Backup
fs.copyFileSync(DB_PATH, BACKUP);
console.log('Backup:', BACKUP);

// 2. Tìm các bút toán smoke test
const smokeTxs = db
  .prepare(
    `SELECT dt.id, dt.customer_id, dt.reference_id, dt.transaction_type, dt.amount
       FROM debt_transactions dt
      WHERE dt.reference_type = 'ORDER'
        AND dt.reference_id IN (
          SELECT CAST(s.id AS TEXT) FROM sales s
            JOIN customers c ON c.id = s.customer_id
           WHERE c.name LIKE '__SMOKE_DEBT_%'
        )`
  )
  .all();

if (smokeTxs.length === 0) {
  console.log('Không có bút toán smoke test nào → không cần dọn.');
  process.exit(0);
}
console.log('Tìm thấy', smokeTxs.length, 'bút toán smoke test:');
smokeTxs.forEach((t) => console.log('  ', JSON.stringify(t)));

const saleIds = [...new Set(smokeTxs.map((t) => t.reference_id))];
const custIds = [...new Set(smokeTxs.map((t) => t.customer_id))];

// 3. Xoá trong transaction
const cleanup = db.transaction(() => {
  for (const id of saleIds) {
    db.prepare(
      `DELETE FROM debt_audit_logs WHERE transaction_id IN (
         SELECT id FROM debt_transactions WHERE reference_type = 'ORDER' AND reference_id = ?)`
    ).run(String(id));
    db.prepare(
      `DELETE FROM debt_transactions WHERE reference_type = 'ORDER' AND reference_id = ?`
    ).run(String(id));
    db.prepare('DELETE FROM order_debts WHERE sale_id = ?').run(Number(id));
    db.prepare('DELETE FROM sales WHERE id = ?').run(Number(id));
  }
  for (const cid of custIds) {
    db.prepare(
      `DELETE FROM debt_audit_logs WHERE transaction_id IN (
         SELECT id FROM debt_transactions WHERE customer_id = ?)`
    ).run(cid);
    db.prepare('DELETE FROM debt_transactions WHERE customer_id = ?').run(cid);
    db.prepare('DELETE FROM debt_accounts WHERE customer_id = ?').run(cid);
    db.prepare('DELETE FROM customers WHERE id = ?').run(cid);
  }
});
cleanup();

// 4. Verify
const after = db
  .prepare(
    `SELECT COUNT(*) c,
            COALESCE(SUM(CASE WHEN direction = 'INCREASE' THEN amount ELSE -amount END), 0) bal
       FROM debt_transactions`
  )
  .get();
const mirror = db.prepare('SELECT COUNT(*) c FROM customers WHERE debt != 0').get();
const proj = db.prepare('SELECT COUNT(*) c FROM order_debts').get();

console.log('\n=== SAU KHI DỌN ===');
console.log('debt_transactions rows =', after.c, '| balance tổng =', after.bal);
console.log('customers.debt != 0     =', mirror.c);
console.log('order_debts rows        =', proj.c);
console.log(after.c === 0 && after.bal === 0 && mirror.c === 0 ? '\n✅ Sổ công nợ sạch' : '\n⚠️  Vẫn còn dữ liệu');
