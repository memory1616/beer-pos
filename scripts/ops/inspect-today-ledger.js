#!/usr/bin/env node
/** Kiểm tra bút toán hôm nay: ORDER_DEBT / PAYMENT / REVERSAL. */
const path = require('path');
const Database = require(path.join('/var/www/beer-pos', 'node_modules', 'better-sqlite3'));
const db = new Database('/var/www/beer-pos/database.sqlite', { readonly: true });

const today = new Date().toISOString().slice(0, 10);
console.log('Ngày:', today, '\n');

const rows = db
  .prepare(
    `SELECT id, customer_id, transaction_type, amount, direction,
            reference_type, reference_id, description, idempotency_key, created_at
       FROM debt_transactions
      WHERE date(created_at) = ?
      ORDER BY id`
  )
  .all(today);

rows.forEach((r) =>
  console.log(
    `#${r.id} c=${r.customer_id} ${r.transaction_type.padEnd(12)} ${r.direction.padEnd(8)} ${String(
      r.amount
    ).padStart(12)} ref=${r.reference_type}:${r.reference_id} key=${r.idempotency_key}\n     ${r.description}`
  )
);

const kpiPayment = db
  .prepare(
    `SELECT COALESCE(SUM(CASE WHEN dt.direction = 'DECREASE' THEN dt.amount ELSE -dt.amount END), 0) AS total
       FROM debt_transactions dt
      WHERE dt.transaction_type IN ('PAYMENT','REVERSAL') AND date(dt.created_at) = date(?)`
  )
  .get(today);

const onlyPayment = db
  .prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM debt_transactions dt
      WHERE dt.transaction_type = 'PAYMENT' AND date(dt.created_at) = date(?)`
  )
  .get(today);

console.log('\nKPI hiện tại (PAYMENT+REVERSAL net):', kpiPayment.total);
console.log('Chỉ PAYMENT thật:', onlyPayment.total);
