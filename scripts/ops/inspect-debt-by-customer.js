#!/usr/bin/env node
/** Tổng hợp công nợ theo khách từ đơn hàng active (chưa thanh toán). */
const path = require('path');
const Database = require('better-sqlite3');
const dbPath = process.argv[2] || path.join(__dirname, '..', '..', 'database.sqlite');
const db = new Database(dbPath, { readonly: true });

console.log('Tổng theo khách (đơn active, có khách, chưa paid):');
const rows = db.prepare(
  `SELECT c.id, c.name, c.debt AS mirror,
          COUNT(s.id) n_orders,
          COALESCE(SUM(s.total),0) sum_total,
          SUM(CASE WHEN s.payment_status='paid' THEN 1 ELSE 0 END) n_paid,
          SUM(CASE WHEN s.delivery_status='DELIVERED' THEN 1 ELSE 0 END) n_delivered
     FROM customers c
     JOIN sales s ON s.customer_id = c.id AND s.type='sale' AND s.archived=0 AND s.deleted=0
    GROUP BY c.id
    ORDER BY sum_total DESC`
).all();
rows.forEach((r) => console.log('  ', JSON.stringify(r)));

console.log('\nTổng chung:', rows.reduce((s, r) => s + r.sum_total, 0).toLocaleString('vi-VN'));
console.log('Số khách có đơn:', rows.length);
console.log('Max theo 1 khách:', rows.length ? rows[0].sum_total.toLocaleString('vi-VN') : 0);
console.log('Trên hạn mức 5tr:', rows.filter((r) => r.sum_total > 5000000).length, 'khách');
