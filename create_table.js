const db = require('better-sqlite3')('beer.db');

try {
  db.exec('CREATE TABLE IF NOT EXISTS keg_transactions_log (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL CHECK(type IN ("deliver", "collect", "import", "adjust", "sell_empty", "gift", "lost", "replacement", "sale_delete")), quantity INTEGER NOT NULL, exchanged INTEGER DEFAULT 0, purchased INTEGER DEFAULT 0, customer_id INTEGER, customer_name TEXT, inventory_after INTEGER, empty_after INTEGER, holding_after INTEGER DEFAULT 0, lost_after INTEGER DEFAULT 0, note TEXT, date TEXT)');
  console.log('Table created');
  
  db.exec('CREATE INDEX IF NOT EXISTS idx_keg_tx_log_date ON keg_transactions_log(date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_keg_tx_log_type ON keg_transactions_log(type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_keg_tx_log_customer ON keg_transactions_log(customer_id)');
  console.log('Indexes created');
  
  console.log('Migration done!');
} catch(e) {
  console.log('Error:', e.message);
}
db.close();
