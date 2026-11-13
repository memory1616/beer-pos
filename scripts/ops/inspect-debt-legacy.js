#!/usr/bin/env node
/**
 * Kiểm tra bảng legacy `debt_transactions_legacy` (schema cũ, không dùng nữa).
 */
const path = require('path');
const Database = require('better-sqlite3');
const dbPath = process.argv[2] || path.join(__dirname, '..', '..', 'database.sqlite');
const db = new Database(dbPath, { readonly: true });
console.log('cols:', db.prepare('PRAGMA table_info(debt_transactions_legacy)').all().map((c) => c.name).join(', '));
db.prepare('SELECT * FROM debt_transactions_legacy').all().forEach((r) => console.log(JSON.stringify(r)));
