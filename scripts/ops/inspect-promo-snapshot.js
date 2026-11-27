process.env.TZ = 'Asia/Ho_Chi_Minh';
const path = require('path');
// [DB GUARD] Chống ghi nhầm vào DB vận hành (2026-11-27).
// [DB GUARD] Chạy trên bản sao: set DB_PATH=<file .sqlite sao>
// [DB GUARD] Ghi có chủ đích lên DB thật: node inspect-promo-snapshot.js --allow-prod-write
const guard = require('../../src/utils/dbWriteGuard');
guard.requireSafeDb({ context: 'chỉ đọc: inspect-promo-snapshot.js', allowWrite: false });
const db = require(path.join(__dirname, '..', '..', 'database'));

console.log('--- sales.date / sale_time / created_at samples ---');
console.table(db.prepare(`
  SELECT id, date, sale_time, created_on, created_at, promo_type, reward_liters_used
  FROM sales ORDER BY id DESC LIMIT 8
`).all());

console.log('--- distinct length(sales.date) ---');
console.table(db.prepare(`SELECT length(date) AS len, COUNT(*) c FROM sales GROUP BY len`).all());

console.log('--- sale_items columns ---');
console.log(db.prepare('PRAGMA table_info(sale_items)').all().map(c => c.name).join(', '));

console.log('--- MONTHLY_BONUS sales sample ---');
console.table(db.prepare(`
  SELECT id, date, promo_type, reward_liters_used, note FROM sales
  WHERE promo_type IN ('MONTHLY_BONUS','NEW_SHOP_BONUS') ORDER BY id DESC LIMIT 8
`).all());

console.log('--- reward sale_items (reward_month/year) ---');
console.table(db.prepare(`
  SELECT si.sale_id, si.product_id, si.quantity, si.price, si.reward_source, si.reward_month, si.reward_year
  FROM sale_items si JOIN sales s ON s.id = si.sale_id
  WHERE s.promo_type IN ('MONTHLY_BONUS','NEW_SHOP_BONUS') LIMIT 10
`).all());

console.log('--- customer created_at samples ---');
console.table(db.prepare(`SELECT id, name, created_at, reward_enabled, new_shop_enabled, promotion_enabled FROM customers LIMIT 5`).all());

process.exit(0);
