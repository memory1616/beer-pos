#!/usr/bin/env node
/** Kiểm tra schema sales/order_debts + settings liên quan công nợ. */
const path = require('path');
const Database = require('better-sqlite3');
const dbPath = process.argv[2] || path.join(__dirname, '..', '..', 'database.sqlite');
const db = new Database(dbPath, { readonly: true });

console.log('sales cols (payment/delivery/credit):');
db.prepare('PRAGMA table_info(sales)').all()
  .filter((c) => /payment|delivery|credit|status|total|customer/i.test(c.name))
  .forEach((c) => console.log('   ', c.name, c.type, 'default=' + c.dflt_value));

console.log('\norder_debts cols:');
db.prepare('PRAGMA table_info(order_debts)').all().forEach((c) => console.log('   ', c.name, c.type));

console.log('\nsettings liên quan:');
db.prepare("SELECT key, value FROM settings WHERE key LIKE '%debt%' OR key LIKE '%max_debt%'").all()
  .forEach((r) => console.log('   ', r.key, '=', r.value));

console.log('\nsales stats:');
db.prepare(
  `SELECT COUNT(*) total,
          SUM(CASE WHEN archived=0 AND deleted=0 THEN 1 ELSE 0 END) active,
          SUM(CASE WHEN customer_id IS NOT NULL AND customer_id>0 AND archived=0 AND deleted=0 THEN 1 ELSE 0 END) with_cust,
          SUM(CASE WHEN payment_status='paid' THEN 1 ELSE 0 END) paid,
          SUM(CASE WHEN payment_status='unpaid' THEN 1 ELSE 0 END) unpaid,
          SUM(CASE WHEN payment_status='partial' THEN 1 ELSE 0 END) partial,
          COALESCE(SUM(CASE WHEN archived=0 AND deleted=0 AND customer_id>0 THEN total ELSE 0 END),0) sum_total_cust
     FROM sales WHERE type='sale'`
).get && console.log(JSON.stringify(db.prepare(
  `SELECT COUNT(*) total,
          SUM(CASE WHEN archived=0 AND deleted=0 THEN 1 ELSE 0 END) active,
          SUM(CASE WHEN customer_id>0 AND archived=0 AND deleted=0 THEN 1 ELSE 0 END) with_cust,
          SUM(CASE WHEN payment_status='paid' THEN 1 ELSE 0 END) paid,
          SUM(CASE WHEN payment_status='unpaid' THEN 1 ELSE 0 END) unpaid,
          SUM(CASE WHEN payment_status='partial' THEN 1 ELSE 0 END) partial,
          COALESCE(SUM(CASE WHEN archived=0 AND deleted=0 AND customer_id>0 THEN total ELSE 0 END),0) sum_total_cust
     FROM sales WHERE type='sale'`
).get(), null, 2));

console.log('\nđơn active có khách, theo payment_status (10 gần nhất):');
db.prepare(
  `SELECT id, customer_id, total, payment_status, delivery_status, is_credit, date
     FROM sales WHERE type='sale' AND archived=0 AND deleted=0 AND customer_id>0
    ORDER BY id DESC LIMIT 10`
).all().forEach((r) => console.log('   ', JSON.stringify(r)));
