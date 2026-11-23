process.env.TZ = 'Asia/Ho_Chi_Minh';
const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'database'));

const rows = db.prepare(`
  SELECT s.id, s.date, s.promo_type, s.promo_free_liters, s.deliver_kegs,
         COALESCE(SUM(CASE WHEN si.price = 0 THEN si.quantity ELSE 0 END), 0) AS gift_liters
    FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id
   WHERE s.promo_type LIKE 'NEW_SHOP%' AND s.archived = 0
   GROUP BY s.id ORDER BY s.id
`).all();
console.log('Tất cả đơn NEW_SHOP / NEW_SHOP_BONUS (chưa archive):');
console.table(rows);

const bonus = db.prepare("SELECT COUNT(*) c FROM sales WHERE promo_type='NEW_SHOP_BONUS'").get();
console.log('Đơn NEW_SHOP_BONUS:', bonus.c);

const orphan = db.prepare(`
  SELECT COUNT(*) c FROM sale_items si
   JOIN sales s ON s.id = si.sale_id
   WHERE s.promo_type='NEW_SHOP' AND si.price = 0 AND s.archived = 0
`).get();
console.log('Còn lít tặng sót trong đơn NEW_SHOP:', orphan.c);

const neg = db.prepare('SELECT COUNT(*) c FROM customers WHERE keg_balance < 0').get();
console.log('Khách có keg_balance âm:', neg.c);

const stockNeg = db.prepare('SELECT COUNT(*) c FROM products WHERE stock < 0').get();
console.log('Sản phẩm có stock âm:', stockNeg.c);

db.close();
