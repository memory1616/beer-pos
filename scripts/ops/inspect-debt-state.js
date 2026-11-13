#!/usr/bin/env node
/**
 * Kiểm tra trạng thái Sổ công nợ trên production (read-only).
 * Dùng: node scripts/ops/inspect-debt-state.js [dbPath]
 */
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.argv[2] || path.join(__dirname, '..', '..', 'database.sqlite');
const db = new Database(dbPath, { readonly: true });

const q = (sql) => db.prepare(sql).get();

const rows = db
  .prepare(
    `SELECT customer_id, COUNT(*) n,
            SUM(CASE WHEN direction='INCREASE' THEN amount ELSE -amount END) bal
       FROM debt_transactions GROUP BY customer_id ORDER BY bal DESC`
  )
  .all();

const auditByAction = db
  .prepare(`SELECT action, COUNT(*) n FROM debt_audit_logs GROUP BY action`)
  .all();

const txByType = db
  .prepare(`SELECT transaction_type, COUNT(*) n, COALESCE(SUM(amount),0) s
              FROM debt_transactions GROUP BY transaction_type`)
  .all();

console.log('DB:', dbPath);
console.log('--- COUNTS ---');
console.log('debt_accounts        :', q('SELECT COUNT(*) n FROM debt_accounts').n);
console.log('debt_transactions   :', q('SELECT COUNT(*) n FROM debt_transactions').n);
console.log('debt_audit_logs     :', q('SELECT COUNT(*) n FROM debt_audit_logs').n);
console.log('order_debts         :', q('SELECT COUNT(*) n FROM order_debts').n);
console.log('debt_customer_groups:', q('SELECT COUNT(*) n FROM debt_customer_groups').n);
console.log('debt_processed_ev   :', q('SELECT COUNT(*) n FROM debt_processed_events').n);
console.log('debt_bridge_events  :', q('SELECT COUNT(*) n FROM debt_bridge_events').n);
console.log('--- SUMS ---');
console.log(
  'ledger_total        :',
  q(
    "SELECT COALESCE(SUM(CASE WHEN direction='INCREASE' THEN amount ELSE -amount END),0) s FROM debt_transactions"
  ).s
);
console.log('mirror_total (customers.debt):', q('SELECT COALESCE(SUM(debt),0) s FROM customers').s);
console.log('customers debt!=0   :', q('SELECT COUNT(*) n FROM customers WHERE debt != 0').n);
console.log('customers total     :', q('SELECT COUNT(*) n FROM customers').n);
console.log('--- TX BY TYPE ---');
txByType.forEach((r) => console.log('  ', r.transaction_type, r.n, r.s));
console.log('--- AUDIT BY ACTION ---');
auditByAction.forEach((r) => console.log('  ', r.action, r.n));
console.log('--- PER CUSTOMER ---');
rows.forEach((r) => console.log('  cust', r.customer_id, 'tx', r.n, 'bal', r.bal));
