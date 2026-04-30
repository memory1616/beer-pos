const db = require('/root/beer-pos/database.js');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', JSON.stringify(tables, null, 2));
const stats = db.prepare('SELECT * FROM keg_stats WHERE id = 1').get();
console.log('keg_stats:', JSON.stringify(stats));
