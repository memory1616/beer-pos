const db = require('./database');
const { PromotionService } = require('./src/services');

// Simulate what happens when creating a new sale for customer 8
const customerId = 8;

// 1. Check current state
const customer = db.prepare('SELECT first_order_date, promotion_enabled FROM customers WHERE id=?').get(customerId);
console.log('Customer first_order_date:', customer.first_order_date);

// 2. Check if there's any MONTHLY_BONUS sale for June 2026 (reward month)
const juneBonus = db.prepare(`
  SELECT id FROM sales 
  WHERE customer_id=? AND type='sale' AND archived=0 AND promo_type='MONTHLY_BONUS'
    AND strftime('%Y', datetime(date, '+7 hours'))='2026'
    AND strftime('%m', datetime(date, '+7 hours'))='06'
`).get(customerId);
console.log('June MONTHLY_BONUS sale:', juneBonus);

// 3. Simulate getRewardForPrevMonth
const rewardInfo = PromotionService.getRewardForPrevMonth(customerId);
console.log('Reward info:', rewardInfo);

// 4. Simulate the auto-reward check from routes/api/sales.js
const now = new Date();
const rewardMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const rewardMonthNum = rewardMonth.getMonth() + 1;
const rewardYear = rewardMonth.getFullYear();

const existingRewardSale = db.prepare(`
  SELECT id FROM sales
  WHERE customer_id = ? AND type = 'sale' AND archived = 0 AND promo_type = 'MONTHLY_BONUS'
    AND strftime('%Y', datetime(date, '+7 hours')) = ?
    AND strftime('%m', datetime(date, '+7 hours')) = ?
  LIMIT 1
`).get(customerId, String(rewardYear), String(rewardMonthNum).padStart(2, '0'));

console.log('Existing reward sale check:', existingRewardSale);

// 5. If we create a new sale now, what would happen?
console.log('\n--- Simulation: Creating new sale for customer 8 ---');
console.log('Would auto-reward attach?', !existingRewardSale && rewardInfo && rewardInfo.eligible && rewardInfo.rewardLiters > 0);
