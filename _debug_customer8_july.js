const db = require('./database');

const sales = db.prepare("SELECT id,date,type,archived,promo_type,promo_free_liters,deliver_kegs,return_kegs,total FROM sales WHERE customer_id=8 AND strftime('%Y-%m', date) = '2026-07' ORDER BY date ASC, id ASC").all();
console.log('JULY_SALES', JSON.stringify(sales, null, 2));

const pending = db.prepare('SELECT * FROM pending_rewards WHERE customer_id=8').all();
console.log('PENDING_REWARDS', JSON.stringify(pending, null, 2));

const rewardHistory = db.prepare('SELECT * FROM reward_history WHERE customer_id=8 ORDER BY claimed_at DESC LIMIT 10').all();
console.log('REWARD_HISTORY', JSON.stringify(rewardHistory, null, 2));
