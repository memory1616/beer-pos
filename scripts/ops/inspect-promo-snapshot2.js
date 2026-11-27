process.env.TZ = 'Asia/Ho_Chi_Minh';
const path = require('path');
// [DB GUARD] Chống ghi nhầm vào DB vận hành (2026-11-27).
// [DB GUARD] Chạy trên bản sao: set DB_PATH=<file .sqlite sao>
// [DB GUARD] Ghi có chủ đích lên DB thật: node inspect-promo-snapshot2.js --allow-prod-write
const guard = require('../../src/utils/dbWriteGuard');
guard.requireSafeDb({ context: 'chỉ đọc: inspect-promo-snapshot2.js', allowWrite: false });
const db = require(path.join(__dirname, '..', '..', 'database'));

console.log('--- sales.date len 19 samples ---');
console.table(db.prepare(`SELECT id, date, sale_time, created_on, created_at FROM sales WHERE length(date)=19 LIMIT 5`).all());
console.log('--- sales.date len 10 samples ---');
console.table(db.prepare(`SELECT id, date, sale_time, created_on, created_at FROM sales WHERE length(date)=10 AND sale_time IS NOT NULL LIMIT 5`).all());
console.log('--- strftime check ---');
console.table(db.prepare(`SELECT id, date, date(date) d1, strftime('%Y', date) y, strftime('%m', date) m FROM sales WHERE length(date)=19 LIMIT 3`).all());
console.log('--- reward_history sample ---');
console.table(db.prepare(`SELECT id, customer_id, reward_tier, reward_liters, reward_yellow_liters, reward_black_liters, claimed_at, note FROM reward_history ORDER BY id DESC LIMIT 5`).all());
console.log('--- customer_monthly_stats sample ---');
console.table(db.prepare(`SELECT * FROM customer_monthly_stats ORDER BY id DESC LIMIT 5`).all());
process.exit(0);
