const db = require('better-sqlite3')('beer.db');
const stmt = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='keg_transactions_log'");
const result = stmt.get();
console.log('Schema:', result ? result.sql : 'Not found');
db.close();
