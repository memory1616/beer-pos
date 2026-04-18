const Database = require('better-sqlite3');
const db = new Database('D:/Beer/database.sqlite');

console.log('=== Kiem tra 10 don gan nhat ===');
const recentSales = db.prepare(`
  SELECT s.id, s.date, s.total, s.profit, s.type, s.customer_id, s.status, s.archived,
         COALESCE(c.name, 'Khach le') as customer_name
  FROM sales s
  LEFT JOIN customers c ON s.customer_id = c.id
  WHERE s.archived = 0 AND s.type = 'sale'
  ORDER BY datetime(s.date) DESC
  LIMIT 10
`).all();

recentSales.forEach(s => {
  console.log('ID:', s.id, '| Date:', s.date, '| Total:', s.total, '| Type:', s.type, '| Status:', s.status, '| KH:', s.customer_name);
});

console.log('');
console.log('=== Kiem tra tat ca don trong bang sales (khong loc) ===');
const allSales = db.prepare(`
  SELECT id, date, total, type, status, archived
  FROM sales
  ORDER BY datetime(date) DESC
  LIMIT 20
`).all();

allSales.forEach(s => {
  console.log('ID:', s.id, '| Date:', s.date, '| Total:', s.total, '| Type:', s.type, '| Status:', s.status, '| Archived:', s.archived);
});

console.log('');
console.log('=== Thong tin date cua server ===');
const now = new Date();
console.log('Server time (local):', now.toISOString());
console.log('Server time (VN):', new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString());

db.close();
