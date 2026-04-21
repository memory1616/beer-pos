const db = require('better-sqlite3')('beer.db');
const schema = db.prepare('SELECT sql FROM sqlite_master WHERE name="keg_transactions_log"').get();
console.log(schema ? schema.sql : 'No table');
db.close();
