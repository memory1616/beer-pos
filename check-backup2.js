const Database = require('better-sqlite3');

const backups = [
  './backup/backup-2026-03-11-2300.db',
  './backup/backup-2026-03-10.db',
  './backup/backup-2026-03-09.db'
];

for (const backup of backups) {
  console.log('\n---', backup, '---');
  try {
    const db = new Database(backup, { readonly: true });
    const purchases = db.prepare('SELECT COUNT(*) as cnt FROM purchases').get();
    console.log('Purchases:', purchases.cnt);
    
    if (purchases.cnt > 0) {
      const rows = db.prepare('SELECT * FROM purchases ORDER BY date DESC LIMIT 5').all();
      console.log(JSON.stringify(rows, null, 2));
    }
    db.close();
  } catch (e) {
    console.log('Error:', e.message);
  }
}
