const Database = require('better-sqlite3');
const db = new Database('./database.sqlite', { readonly: true });

const products = db.prepare('SELECT * FROM products').all();
console.log('Products:');
console.log(JSON.stringify(products, null, 2));

const sales = db.prepare('SELECT * FROM sales ORDER BY date DESC LIMIT 5').all();
console.log('Recent Sales:');
console.log(JSON.stringify(sales, null, 2));
