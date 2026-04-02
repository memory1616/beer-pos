const db = require('./database');
const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='sales'").get();
console.log('Sales schema:', schema ? schema.sql : 'no sales table');
const items = db.prepare("SELECT sql FROM sqlite_master WHERE name='sale_items'").get();
console.log('Sale_items schema:', items ? items.sql : 'no sale_items table');
