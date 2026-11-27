process.env.TZ = 'Asia/Ho_Chi_Minh';
const path = require('path');
// [DB GUARD] Chống ghi nhầm vào DB vận hành (2026-11-27).
// [DB GUARD] Chạy trên bản sao: set DB_PATH=<file .sqlite sao>
// [DB GUARD] Ghi có chủ đích lên DB thật: node check-order-1145.js --allow-prod-write
const guard = require('../../src/utils/dbWriteGuard');
guard.requireSafeDb({ context: 'chỉ đọc: check-order-1145.js', allowWrite: false });
const db = require(path.join(__dirname, '..', '..', 'database'));

const s = db.prepare(`
  SELECT s.*, c.name AS customer_name, c.created_at AS cust_created
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
   WHERE s.id = 1145
`).get();
console.log('=== ĐƠN 1145 ===');
console.log(JSON.stringify(s, null, 2));

if (s) {
  const items = db.prepare(`
    SELECT si.*, p.name AS product_name, p.type, p.cost_price
      FROM sale_items si LEFT JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = 1145 ORDER BY si.id
  `).all();
  console.log('\n--- sale_items ---');
  console.table(items.map(i => ({
    id: i.id, product: i.product_name, type: i.type,
    qty: i.quantity, price: i.price, cost: i.cost_price,
    isGift: i.price === 0 ? 'GIFT' : '',
  })));

  const rh = db.prepare('SELECT * FROM reward_history WHERE customer_id = ? ORDER BY id DESC LIMIT 10').all(s.customer_id);
  console.log('\n--- reward_history ---');
  console.table(rh);
}

db.close();
// Cron job trong `database.js` giữ event loop sống → phải exit tường minh.
process.exit(0);
