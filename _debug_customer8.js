const db = require('./database');

const c = db.prepare('SELECT id,name,created_at,first_order_date,promotion_enabled,new_shop_enabled,reward_enabled,monthly_purchased_liters FROM customers WHERE id=?').get(8);
console.log('CUSTOMER', JSON.stringify(c, null, 2));

const sales = db.prepare("SELECT id,date,type,archived,promo_type,promo_free_liters,deliver_kegs,return_kegs,total FROM sales WHERE customer_id=8 ORDER BY date DESC,id DESC LIMIT 10").all();
console.log('SALES', JSON.stringify(sales, null, 2));

const stats = db.prepare('SELECT * FROM customer_monthly_stats WHERE customer_id=8 ORDER BY year DESC,month DESC LIMIT 6').all();
console.log('MONTHLY_STATS', JSON.stringify(stats, null, 2));

const pending = db.prepare('SELECT * FROM pending_rewards WHERE customer_id=8').all();
console.log('PENDING_REWARDS', JSON.stringify(pending, null, 2));

const rewardHistory = db.prepare('SELECT * FROM reward_history WHERE customer_id=8 ORDER BY claimed_at DESC LIMIT 10').all();
console.log('REWARD_HISTORY', JSON.stringify(rewardHistory, null, 2));
