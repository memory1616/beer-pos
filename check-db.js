const Database = require('better-sqlite3');
const db = new Database('./database.sqlite', { readonly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

const purchases = db.prepare('SELECT COUNT(*) as cnt FROM purchases').get();
console.log('Purchases:', purchases.cnt);

const purchaseItems = db.prepare('SELECT COUNT(*) as cnt FROM purchase_items').get();
console.log('Purchase items:', purchaseItems.cnt);
