const db = require('better-sqlite3')('beer.db');

// Check if sale_time column exists
const columns = db.prepare('PRAGMA table_info(sales)').all();
const hasSaleTime = columns.some(c => c.name === 'sale_time');

console.log('Has sale_time column:', hasSaleTime);

if (!hasSaleTime) {
  console.log('Adding sale_time column...');
  db.exec('ALTER TABLE sales ADD COLUMN sale_time TEXT');
  console.log('Column added!');
}

// Show recent sales
const sales = db.prepare('SELECT id, date, sale_time FROM sales ORDER BY id DESC LIMIT 5').all();
console.log('\nRecent sales:');
sales.forEach(s => console.log(`  #${s.id}: date=${s.date}, sale_time=${s.sale_time}`));

db.close();
