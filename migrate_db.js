const Database = require('better-sqlite3');

const db = new Database('beer.db');

try {
  db.exec('CREATE TABLE keg_transactions_log_new (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL CHECK(type IN ("deliver", "collect", "import", "adjust", "sell_empty", "gift", "lost", "replacement", "sale_delete")), quantity INTEGER NOT NULL, exchanged INTEGER DEFAULT 0, purchased INTEGER DEFAULT 0, customer_id INTEGER, customer_name TEXT, inventory_after INTEGER, empty_after INTEGER, holding_after INTEGER DEFAULT 0, lost_after INTEGER DEFAULT 0, note TEXT, date TEXT)');
  const count = db.prepare('SELECT COUNT(*) as c FROM keg_transactions_log').get();
  console.log('Rows:', count.c);
  db.exec('INSERT INTO keg_transactions_log_new SELECT * FROM keg_transactions_log');
  db.exec('DROP TABLE keg_transactions_log');
  db.exec('ALTER TABLE keg_transactions_log_new RENAME TO keg_transactions_log');
  console.log('Migration OK!');
} catch(e) {
  console.log('Error:', e.message);
}
db.close();
