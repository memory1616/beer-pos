#!/usr/bin/env node
/** Verify KPI "Tiền thu hôm nay" / "Nợ phát sinh hôm nay" đúng công thức mới. */
const path = require('path');
const Database = require(path.join('/var/www/beer-pos', 'node_modules', 'better-sqlite3'));
const db = new Database('/var/www/beer-pos/database.sqlite', { readonly: true });

const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

const debt = db
  .prepare(
    `SELECT COALESCE(SUM(
              CASE
                WHEN dt.transaction_type = 'REVERSAL' AND dt.direction = 'DECREASE' THEN -dt.amount
                WHEN dt.transaction_type = 'REVERSAL' THEN 0
                WHEN dt.direction = 'INCREASE' THEN dt.amount
                ELSE -dt.amount
              END), 0) AS total
       FROM debt_transactions dt
      WHERE dt.transaction_type IN ('ORDER_DEBT','MANUAL_DEBT','ADJUSTMENT','REVERSAL')
        AND date(dt.created_at) = date(?)`
  )
  .get(today).total;

const payment = db
  .prepare(
    `SELECT COALESCE(SUM(
              CASE
                WHEN dt.transaction_type = 'PAYMENT' AND dt.direction = 'DECREASE' THEN dt.amount
                WHEN dt.transaction_type = 'REVERSAL' AND dt.direction = 'INCREASE' THEN -dt.amount
                ELSE 0
              END), 0) AS total
       FROM debt_transactions dt
      WHERE dt.transaction_type IN ('PAYMENT','REVERSAL')
        AND date(dt.created_at) = date(?)`
  )
  .get(today).total;

const oldPayment = db
  .prepare(
    `SELECT COALESCE(SUM(CASE WHEN dt.direction = 'DECREASE' THEN dt.amount ELSE -dt.amount END), 0) AS total
       FROM debt_transactions dt
      WHERE dt.transaction_type IN ('PAYMENT','REVERSAL') AND date(dt.created_at) = date(?)`
  )
  .get(today).total;

console.log('Ngày:', today);
console.log('KPI MỚI  — Tiền thu hôm nay     :', payment.toLocaleString('vi-VN') + 'đ');
console.log('KPI CŨ   — Tiền thu hôm nay (sai):', oldPayment.toLocaleString('vi-VN') + 'đ');
console.log('Nợ phát sinh hôm nay            :', debt.toLocaleString('vi-VN') + 'đ');
