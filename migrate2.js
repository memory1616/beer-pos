const db = require('better-sqlite3')('beer.db');

try {
  db.exec('DROP TABLE IF EXISTS keg_transactions_log_new');
  
  db.exec(`
    CREATE TABLE keg_transactions_log_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('deliver', 'collect', 'import', 'adjust', 'sell_empty', 'gift', 'lost', 'replacement', 'sale_delete')),
      quantity INTEGER NOT NULL,
      exchanged INTEGER DEFAULT 0,
      purchased INTEGER DEFAULT 0,
      customer_id INTEGER,
      customer_name TEXT,
      inventory_after INTEGER DEFAULT 0,
      empty_after INTEGER DEFAULT 0,
      holding_after INTEGER DEFAULT 0,
      lost_after INTEGER DEFAULT 0,
      note TEXT,
      date TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    )
  `);
  
  db.exec("INSERT INTO keg_transactions_log_new (id, type, quantity, exchanged, purchased, customer_id, customer_name, inventory_after, empty_after, holding_after, note, date, updated_at, lost_after) SELECT id, type, quantity, exchanged, purchased, customer_id, customer_name, COALESCE(inventory_after,0), COALESCE(empty_after,0), COALESCE(holding_after,0), note, date, updated_at, 0 FROM keg_transactions_log");
  
  db.exec('DROP TABLE keg_transactions_log');
  db.exec('ALTER TABLE keg_transactions_log_new RENAME TO keg_transactions_log');
  
  console.log('Migration complete!');
} catch(e) {
  console.log('Error:', e.message);
}
db.close();
