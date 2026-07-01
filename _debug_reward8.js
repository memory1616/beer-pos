const db = require('./database');

console.log('--- Customer 8 info ---');
const customer = db.prepare('SELECT id,name,created_at,first_order_date,promotion_enabled,new_shop_enabled,reward_enabled,monthly_purchased_liters FROM customers WHERE id=?').get(8);
console.log(JSON.stringify(customer, null, 2));

console.log('--- Promotion settings ---');
const settings = db.prepare('SELECT * FROM promotion_settings WHERE id=1').get();
console.log(JSON.stringify(settings, null, 2));

console.log('--- getRewardForPrevMonth simulation ---');
const { PromotionService } = require('./src/services');
const info = PromotionService.getRewardForPrevMonth(8);
console.log(JSON.stringify(info, null, 2));

console.log('--- isInNewShopPeriod ---');
const newShop = PromotionService.isInNewShopPeriod(8);
console.log(newShop);

console.log('--- check current month sales ---');
const now = new Date();
const currentYear = now.getFullYear();
const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
const sales = db.prepare("SELECT id,date,type,archived,promo_type FROM sales WHERE customer_id=8 AND strftime('%Y-%m', date)=? ORDER BY date ASC, id ASC").all(`${currentYear}-${currentMonth}`);
console.log(JSON.stringify(sales, null, 2));
