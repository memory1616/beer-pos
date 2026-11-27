process.env.TZ = 'Asia/Ho_Chi_Minh';
const path = require('path');
// [DB GUARD] Chống ghi nhầm vào DB vận hành (2026-11-27).
// [DB GUARD] Chạy trên bản sao: set DB_PATH=<file .sqlite sao>
// [DB GUARD] Ghi có chủ đích lên DB thật: node check-reward-history.js --allow-prod-write
const guard = require('../../src/utils/dbWriteGuard');
guard.requireSafeDb({ context: 'chỉ đọc: check-reward-history.js', allowWrite: false });
const db = require(path.join(__dirname, '..', '..', 'database'));

console.log('=== REWARD_HISTORY có NEW_SHOP ===');
const ns = db.prepare(`
  SELECT * FROM reward_history WHERE reward_tier LIKE 'NEW_SHOP%' OR note LIKE '%quán mới%' OR note LIKE '%Quan moi%'
`).all();
console.log('số dòng:', ns.length);
console.table(ns);

console.log('\n=== REWARD_HISTORY tất cả (10 dòng cuối) ===');
console.table(db.prepare('SELECT * FROM reward_history ORDER BY id DESC LIMIT 10').all());

console.log('\n=== PENDING_REWARDS có mode NEW_SHOP ===');
console.table(db.prepare("SELECT * FROM pending_rewards WHERE mode = 'NEW_SHOP'").all());
console.log('tất cả pending:', db.prepare('SELECT COUNT(*) c FROM pending_rewards').get().c);

console.log('\n=== SALES có promo_type NEW_SHOP_BONUS (mọi trạng thái) ===');
console.table(db.prepare(`
  SELECT s.id, s.date, s.customer_id, c.name, s.promo_type, s.archived, s.reward_liters_used, s.note
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
   WHERE s.promo_type = 'NEW_SHOP_BONUS' ORDER BY s.id
`).all());

console.log('\n=== Doanh số tháng của các khách bị ảnh hưởng (tháng mở quán) ===');
const custs = db.prepare(`
  SELECT DISTINCT s.customer_id, c.name, c.created_at, s.date
    FROM sales s JOIN customers c ON c.id = s.customer_id
   WHERE s.promo_type = 'NEW_SHOP'
`).all();
for (const cu of custs) {
  const stats = db.prepare(`
    SELECT year, month, purchased_liters, reward_claimed, reward_claimed_liters
      FROM customer_monthly_stats WHERE customer_id = ? ORDER BY year, month
  `).all(cu.customer_id);
  console.log(`--- ${cu.name} (id=${cu.customer_id}, created=${cu.created_at}) ---`);
  console.table(stats);
}

db.close();
