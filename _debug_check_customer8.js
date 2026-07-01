const db = require('./database');
const { PromotionService } = require('./src/services');

const customerId = 8;

const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
console.log('Customer:', JSON.stringify(customer, null, 2));

const sales = db.prepare("SELECT id,date,type,archived,promo_type,promo_free_liters,total,note FROM sales WHERE customer_id=? ORDER BY date DESC,id DESC LIMIT 20").all(customerId);
console.log('Recent sales:', JSON.stringify(sales, null, 2));

const pending = db.prepare('SELECT * FROM pending_rewards WHERE customer_id=?').all(customerId);
console.log('Pending rewards:', JSON.stringify(pending, null, 2));

const history = db.prepare('SELECT * FROM reward_history WHERE customer_id=? ORDER BY claimed_at DESC LIMIT 20').all(customerId);
console.log('Reward history:', JSON.stringify(history, null, 2));

const stats = db.prepare('SELECT * FROM customer_monthly_stats WHERE customer_id=? ORDER BY year DESC,month DESC LIMIT 12').all(customerId);
console.log('Monthly stats:', JSON.stringify(stats, null, 2));

const rewardInfo = PromotionService.getRewardForPrevMonth(customerId);
console.log('Reward info:', JSON.stringify(rewardInfo, null, 2));
