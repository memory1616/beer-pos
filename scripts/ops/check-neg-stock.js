process.env.TZ = 'Asia/Ho_Chi_Minh';
const path = require('path');
// [DB GUARD] Chống ghi nhầm vào DB vận hành (2026-11-27).
// [DB GUARD] Chạy trên bản sao: set DB_PATH=<file .sqlite sao>
// [DB GUARD] Ghi có chủ đích lên DB thật: node check-neg-stock.js --allow-prod-write
const guard = require('../../src/utils/dbWriteGuard');
guard.requireSafeDb({ context: 'chỉ đọc: check-neg-stock.js', allowWrite: false });
const db = require(path.join(__dirname, '..', '..', 'database'));

const neg = db.prepare('SELECT id, name, stock, type FROM products WHERE stock < 0').all();
console.log('Sản phẩm stock âm:', JSON.stringify(neg, null, 2));

for (const p of neg) {
  const hist = db.prepare(`
    SELECT si.sale_id, s.date, s.promo_type, si.quantity, si.price
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE si.product_id = ? AND s.archived = 0
     ORDER BY s.date DESC LIMIT 5
  `).all(p.id);
  console.log(`\n--- ${p.name} (id=${p.id}) stock=${p.stock} ---`);
  console.table(hist);
}

// Tổng kho từ warehouse
try {
  const wh = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get();
  console.log('\nKho vỏ tổng:', JSON.stringify(wh));
} catch (e) { console.log('WH err', e.message); }

db.close();
// Cron job trong `database.js` giữ event loop sống → phải exit tường minh.
process.exit(0);
