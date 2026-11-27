process.env.TZ = 'Asia/Ho_Chi_Minh';
const path = require('path');
// [DB GUARD] Chống ghi nhầm vào DB vận hành (2026-11-27).
// [DB GUARD] Chạy trên bản sao: set DB_PATH=<file .sqlite sao>
// [DB GUARD] Ghi có chủ đích lên DB thật: node check-archived-audit.js --allow-prod-write
const guard = require('../../src/utils/dbWriteGuard');
guard.requireSafeDb({ context: 'chỉ đọc: check-archived-audit.js', allowWrite: false });
const db = require(path.join(__dirname, '..', '..', 'database'));

console.log('=== SCHEMA product_audit_log ===');
console.log(db.prepare("PRAGMA table_info(product_audit_log)").all().map(c => c.name).join(', '));

const archived = db.prepare(`
  SELECT s.id, s.date, s.customer_id, c.name, s.archived, s.promo_type,
         s.deliver_kegs, s.promo_free_liters,
         (SELECT COALESCE(SUM(quantity),0) FROM sale_items WHERE sale_id = s.id AND price = 0) AS gift
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
   WHERE s.promo_type = 'NEW_SHOP'
     AND EXISTS (SELECT 1 FROM sale_items WHERE sale_id = s.id AND price = 0 AND quantity > 0)
   ORDER BY s.id
`).all();

console.log('\n=== TẤT CẢ đơn NEW_SHOP còn lít tặng (kể cả archived) ===');
console.table(archived);

for (const s of archived) {
  console.log('\n--- ĐƠN ' + s.id + ' (archived=' + s.archived + ', gift=' + s.gift + 'L) ---');

  const logs = db.prepare(`
    SELECT * FROM product_audit_log
     WHERE ref_id = ? AND ref_type = 'sale'
     ORDER BY id
  `).all(s.id);
  console.log('audit log (' + logs.length + ' dòng):');
  if (logs.length) {
    console.table(logs.map(l => ({
      id: l.id, product_id: l.product_id, type: l.type, quantity: l.quantity,
      reason: l.reason, note: (l.note || '').substring(0, 40),
    })));
  }

  const items = db.prepare(`
    SELECT si.id, si.quantity, si.price, p.name, p.stock
      FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ? ORDER BY si.id
  `).all(s.id);
  console.table(items.map(i => ({ id: i.id, product: i.name, qty: i.quantity, price: i.price, stock_now: i.stock })));
}

db.close();
