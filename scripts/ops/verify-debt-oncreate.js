#!/usr/bin/env node
/** Verify module Sổ công nợ sau deploy: settings, ledger, mirror. */
const path = require('path');
const Database = require('better-sqlite3');
const dbPath = process.argv[2] || path.join(__dirname, '..', '..', 'database.sqlite');
const db = new Database(dbPath, { readonly: true });

console.log('settings công nợ:');
db.prepare("SELECT key, value FROM settings WHERE key LIKE 'debt_%' OR key = 'max_debt_per_customer'").all()
  .forEach((r) => console.log('   ', r.key, '=', r.value));

const ledger = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(CASE WHEN direction=\'INCREASE\' THEN amount ELSE -amount END),0) bal FROM debt_transactions').get();
console.log('\ndebt_transactions: rows =', ledger.c, '| balance tổng =', ledger.bal);

const mirror = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(debt),0) s FROM customers WHERE debt != 0').get();
console.log('mirror customers.debt != 0: ', mirror.c, 'khách | tổng =', mirror.s);

console.log('\nđơn active có khách (10 gần nhất):');
db.prepare(`SELECT id, customer_id, total, payment_status, delivery_status, is_credit, date
              FROM sales WHERE type='sale' AND archived=0 AND deleted=0 AND customer_id>0
             ORDER BY id DESC LIMIT 10`).all()
  .forEach((r) => console.log('   ', JSON.stringify(r)));

console.log('\norder_debts (10 gần nhất):');
db.prepare(`SELECT od.sale_id, od.customer_id, od.original_amount, od.paid_amount, od.remaining_amount, od.status
              FROM order_debts od ORDER BY od.id DESC LIMIT 10`).all()
  .forEach((r) => console.log('   ', JSON.stringify(r)));
