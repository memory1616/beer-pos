#!/usr/bin/env node
/** Kiểm tra nhanh các bảng liên quan công nợ trên production (read-only). */
const path = require('path');
const Database = require('better-sqlite3');
const dbPath = process.argv[2] || path.join(__dirname, '..', '..', 'database.sqlite');
const db = new Database(dbPath, { readonly: true });
const one = (s) => db.prepare(s).get();

console.log('debt_staff_permissions:', one('SELECT COUNT(*) n FROM debt_staff_permissions').n);
console.log('debt_customer_groups  :', one('SELECT COUNT(*) n FROM debt_customer_groups').n);
console.log('settings debt_*       :');
db.prepare("SELECT key, value FROM settings WHERE key LIKE 'debt%'").all().forEach((r) => console.log('   ', r.key, '=', r.value));
console.log('audit_logs schema     :');
db.prepare('PRAGMA table_info(debt_audit_logs)').all().forEach((c) => console.log('   ', c.name));
console.log('audit rows            :');
db.prepare('SELECT id, action, actor_id, created_at FROM debt_audit_logs ORDER BY id').all().forEach((r) => console.log('   ', r.id, r.action, r.actor_id, r.created_at));
console.log('payments              :');
db.prepare('SELECT id, customer_id, amount, created_at FROM payments ORDER BY id').all().forEach((r) => console.log('   ', r.id, 'cust', r.customer_id, r.amount, r.created_at));
console.log('customers debt!=0     :');
db.prepare('SELECT id, name, debt FROM customers WHERE debt != 0').all().forEach((r) => console.log('   ', r.id, r.name, r.debt));
console.log('debt_accounts         :');
db.prepare('SELECT * FROM debt_accounts').all().forEach((r) => console.log('   ', JSON.stringify(r)));
console.log('debt_transactions     :');
db.prepare('SELECT id, customer_id, transaction_type, amount, direction, balance_after, created_at FROM debt_transactions ORDER BY id').all().forEach((r) => console.log('   ', JSON.stringify(r)));
