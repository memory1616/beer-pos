const Database = require('better-sqlite3');
const db = new Database('D:/Beer/database.sqlite');

const now = new Date();
const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
const today = vn.getUTCFullYear() + '-' +
  String(vn.getUTCMonth() + 1).padStart(2, '0') + '-' +
  String(vn.getUTCDate()).padStart(2, '0');

console.log('Hôm nay (VN):', today);

const todaySales = db.prepare(`
  SELECT s.id, s.date, s.total, s.profit, s.type, s.customer_id, s.status, s.archived,
         COALESCE(c.name, 'Khách lẻ') as customer_name
  FROM sales s
  LEFT JOIN customers c ON s.customer_id = c.id
  WHERE date(s.date) = ?
  ORDER BY s.date DESC
`).all(today);

console.log('So don hom nay:', todaySales.length);
todaySales.forEach(s => {
  console.log('ID:', s.id, '| Date:', s.date, '| Total:', s.total, '| Type:', s.type, '| Status:', s.status, '| Archived:', s.archived, '| KH:', s.customer_name);
});

console.log('Tong doanh thu:', todaySales.reduce((sum, s) => sum + (s.total || 0), 0).toLocaleString('vi-VN'), 'đ');
console.log('Tong loi nhuan:', todaySales.reduce((sum, s) => sum + (s.profit || 0), 0).toLocaleString('vi-VN'), 'đ');

db.close();
