const db = require('./database');
const prods = db.prepare("SELECT id, name, type, stock FROM products WHERE archived = 0 ORDER BY id").all();
console.log('All products:');
prods.forEach(p => console.log('  ID', p.id, ':', p.name, '| type:', p.type, '| stock:', p.stock));
db.close();
