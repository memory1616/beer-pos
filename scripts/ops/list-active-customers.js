#!/usr/bin/env node
/** Liệt kê khách đang hiển thị trên UI (active, chưa xoá). */
const path = require('path');
const Database = require(path.join('/var/www/beer-pos', 'node_modules', 'better-sqlite3'));
const db = new Database('/var/www/beer-pos/database.sqlite', { readonly: true });

const rows = db
  .prepare(
    `SELECT id, name, phone, debt, archived, created_at
       FROM customers
      WHERE archived = 0 AND deleted = 0
      ORDER BY id`
  )
  .all();

console.log('Tổng khách active:', rows.length);
rows.forEach((r) => console.log('  ', JSON.stringify(r)));

console.log('\nKhông tồn tại:', db.prepare('SELECT COUNT(*) c FROM customers WHERE archived = 0 AND deleted = 0 AND name LIKE \'__%\'').get().c);
console.log('Sổ công nợ: rows =', db.prepare('SELECT COUNT(*) c FROM debt_transactions').get().c,
  '| balance =', db.prepare("SELECT COALESCE(SUM(CASE WHEN direction='INCREASE' THEN amount ELSE -amount END),0) b FROM debt_transactions").get().b);
