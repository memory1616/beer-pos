/**
 * Script kiểm tra dữ liệu sổ công nợ sau khi triển khai (read-only).
 * Dùng: node scripts/check-debt-data.js
 */
process.env.NODE_ENV = 'test';

const db = require('../database');
const DebtLedgerService = require('../src/services/debt/DebtLedgerService');
const DebtReconciliationService = require('../src/services/debt/DebtReconciliationService');

function money(n) {
  return `${Number(n || 0).toLocaleString('vi-VN')}đ`;
}

const total = db
  .prepare(
    `SELECT COUNT(*) AS tx,
            COUNT(DISTINCT customer_id) AS customers,
            COALESCE(SUM(CASE WHEN direction='INCREASE' THEN amount ELSE -amount END),0) AS balance
       FROM debt_transactions`
  )
  .get();

const byType = db
  .prepare(
    `SELECT transaction_type, direction, COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total
       FROM debt_transactions GROUP BY transaction_type, direction ORDER BY transaction_type`
  )
  .all();

const mirrorMismatch = db
  .prepare(
    `SELECT c.id, c.name, c.debt,
            COALESCE(SUM(CASE WHEN dt.direction='INCREASE' THEN dt.amount ELSE -dt.amount END),0) AS ledger
       FROM customers c
       LEFT JOIN debt_transactions dt ON dt.customer_id = c.id
      WHERE c.archived = 0
      GROUP BY c.id
     HAVING ABS(COALESCE(c.debt,0) - ledger) > 0.5`
  )
  .all();

const groups = db.prepare('SELECT COUNT(*) AS c FROM debt_customer_groups').get().c;
const perms = db.prepare('SELECT COUNT(*) AS c FROM debt_staff_permissions').get().c;
const accounts = db.prepare('SELECT COUNT(*) AS c FROM debt_accounts').get().c;

console.log('════════ SỔ CÔNG NỢ — KIỂM TRA DỮ LIỆU ════════');
console.log(`Tổng bút toán      : ${total.tx}`);
console.log(`Khách có ledger    : ${total.customers}`);
console.log(`Tổng số dư công nợ: ${money(total.balance)}`);
console.log(`Tài khoản công nợ  : ${accounts}`);
console.log(`Nhóm Zalo liên kết : ${groups}`);
console.log(`Phân quyền NV      : ${perms}`);
console.log('');
console.log('── Theo loại bút toán ──');
for (const r of byType) {
  console.log(
    `  ${r.transaction_type.padEnd(16)} ${r.direction.padEnd(9)} ${String(r.cnt).padStart(5)} bản ghi  ${money(r.total)}`
  );
}
console.log('');
console.log('── Lệch mirror customers.debt vs ledger ──');
if (!mirrorMismatch.length) {
  console.log('  ✅ Không có sai lệch');
} else {
  for (const r of mirrorMismatch) {
    console.log(
      `  ⚠ #${r.id} ${r.name}: mirror=${money(r.debt)} ledger=${money(r.ledger)}`
    );
  }
}
console.log('');
console.log('── Đối soát ──');
const recon = DebtReconciliationService.run({ apply: false });
console.log(`  ${JSON.stringify(recon.summary)}`);
if (recon.issues.length) {
  console.log('');
  for (const i of recon.issues.slice(0, 20)) {
    console.log(`  [${i.severity}] ${i.message}`);
  }
}
