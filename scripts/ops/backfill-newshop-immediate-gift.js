/**
 * BACKFILL: Gỡ lít tặng NGAY của KM quán mới (bug tặng trùng)
 * ─────────────────────────────────────────────────────────────────────────────
 * BỐI CẢNH (2026-11-23):
 *   `routes/api/sales.js` (create + update) gọi `calculateNewShopPromotion()`
 *   → cộng lít tặng (sale_items price=0) NGAY vào đơn + `deliver_kegs` +
 *   trừ kho. Sau đó tháng sau auto-claim gắn thêm 1 lần nữa
 *   (promo_type='NEW_SHOP_BONUS') → TẶNG TRÙNG 2 LẦN cho cùng 1 tháng.
 *
 *   Nguyên tắc đúng (giống thưởng doanh số):
 *   "N tặng M" của tháng mở quán được trả vào ĐƠN ĐẦU TIÊN THÁNG KẾ TIẾP.
 *
 * VIỆC CẦN LÀM:
 *   Với mỗi đơn `promo_type='NEW_SHOP'` có lít tặng (price=0):
 *     1. Xoá sale_items lít tặng (price = 0) của đơn đó
 *     2. Hoàn kho (products.stock += gift liters)
 *     3. Trừ lại `deliver_kegs` (vỏ giao đã bị cộng lít tặng)
 *     4. Trừ `customers.keg_balance` (vỏ đã bị cộng lít tặng)
 *     5. `promo_free_liters = 0`, `reward_liters_used = 0`
 *     6. Tính lại `sales.profit` (vì bỏ lít tặng = bỏ cả COGS của nó)
 *     7. Giữ `promo_type='NEW_SHOP'` (nhãn "đơn thuộc tháng mở quán")
 *
 * ⚠️ KHÔNG đụng phần MUA THẬT (price > 0) → sản lượng tháng KHÔNG đổi.
 * ⚠️ KHÔNG đụng `customer_monthly_stats` (chỉ lít mua thật mới tính vào đó).
 *
 * CHẠY: node scripts/ops/backfill-newshop-immediate-gift.js [--dry-run]
 */
process.env.TZ = 'Asia/Ho_Chi_Minh';

const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'database'));

const DRY_RUN = process.argv.includes('--dry-run');

/** Lấy tên bia để phân loại vàng/đen (dùng cùng logic với PromotionService). */
const BLACK_KEYWORDS = ['guinness', 'kilkenny', 'murphy', 'black', 'đen', 'smithwick'];
function classifyBeer(name) {
  if (!name) return 'gold';
  const n = String(name).toLowerCase();
  for (const k of BLACK_KEYWORDS) if (n.indexOf(k) !== -1) return 'black';
  return 'gold';
}

// ── Tìm đơn bị ảnh hưởng ────────────────────────────────────────────────────
const affected = db.prepare(`
  SELECT s.id, s.customer_id, s.date, s.promo_type, s.promo_free_liters,
         s.deliver_kegs, s.return_kegs, s.profit, s.reward_liters_used,
         c.name AS customer_name, c.keg_balance
    FROM sales s
    JOIN customers c ON c.id = s.customer_id
   WHERE s.promo_type = 'NEW_SHOP'
     AND s.archived = 0
     AND s.type = 'sale'
   ORDER BY s.id
`).all();

const results = [];

for (const sale of affected) {
  // Lít tặng = sale_items có price = 0 (chỉ trong đơn này)
  const giftItems = db.prepare(`
    SELECT si.id, si.product_id, si.quantity, p.name AS product_name, p.cost_price
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ? AND si.price = 0 AND si.quantity > 0
  `).all(sale.id);

  if (giftItems.length === 0) {
    results.push({ id: sale.id, customer: sale.customer_name, status: 'skip_no_gift' });
    continue;
  }

  const giftLiters = giftItems.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
  const giftCost = giftItems.reduce((s, r) => s + (Number(r.quantity) || 0) * (Number(r.cost_price) || 0), 0);

  if (DRY_RUN) {
    results.push({
      id: sale.id, customer: sale.customer_name, date: sale.date,
      status: 'would_fix', giftLiters, giftCost,
      deliver_before: sale.deliver_kegs, keg_balance_before: sale.keg_balance,
    });
    continue;
  }

  const tx = db.transaction(() => {
    // 1. Hoàn kho
    for (const g of giftItems) {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(g.quantity, g.product_id);
    }

    // 2. Xoá sale_items lít tặng
    db.prepare('DELETE FROM sale_items WHERE sale_id = ? AND price = 0 AND quantity > 0').run(sale.id);

    // 3. Trừ vỏ giao (đã bị cộng lít tặng)
    db.prepare('UPDATE sales SET deliver_kegs = MAX(0, deliver_kegs - ?) WHERE id = ?').run(giftLiters, sale.id);

    // 4. Trừ keg_balance của khách
    if (sale.customer_id) {
      db.prepare('UPDATE customers SET keg_balance = MAX(0, keg_balance - ?) WHERE id = ?').run(giftLiters, sale.customer_id);
    }

    // 5. Xoá dấu vết lít tặng
    db.prepare(`
      UPDATE sales
         SET promo_free_liters = 0,
             reward_liters_used = 0
       WHERE id = ?
    `).run(sale.id);

    // 6. Tính lại profit (bỏ lít tặng = bỏ luôn COGS của lít tặng)
    const profitCalc = db.prepare(`
      SELECT COALESCE(SUM(quantity * price - quantity * cost_price), 0) AS profit
        FROM sale_items WHERE sale_id = ?
    `).get(sale.id);
    db.prepare('UPDATE sales SET profit = ? WHERE id = ?').run(profitCalc ? profitCalc.profit : 0, sale.id);

    // 7. Đồng bộ keg_stats (tồn kho vỏ tổng)
    try {
      const inventoryResult = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get();
      const totalHolding = db.prepare('SELECT COALESCE(SUM(keg_balance), 0) AS total FROM customers').get();
      db.prepare(`
        UPDATE keg_stats SET inventory = ?, customer_holding = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1
      `).run(inventoryResult.total, totalHolding.total);
    } catch (e) {
      console.warn('  ! keg_stats sync failed:', e.message);
    }
  });

  try {
    tx();
    results.push({
      id: sale.id, customer: sale.customer_name, date: sale.date,
      status: 'fixed', giftLiters, giftCost,
    });
  } catch (e) {
    results.push({
      id: sale.id, customer: sale.customer_name, date: sale.date,
      status: 'ERROR', error: e.message,
    });
  }
}

// ── Báo cáo ────────────────────────────────────────────────────────────────
console.log(DRY_RUN ? '=== DRY RUN (không ghi DB) ===' : '=== ĐÃ SỬA ===');
console.table(results);

const fixed = results.filter(r => r.status === 'fixed');
if (fixed.length) {
  const totalGift = fixed.reduce((s, r) => s + r.giftLiters, 0);
  console.log(`\nTổng lít tặng đã gỡ: ${totalGift}L trên ${fixed.length} đơn.`);
  console.log('→ Thưởng này sẽ được trả lại đúng quy tắc: gắn vào ĐƠN ĐẦU TIÊN THÁNG KẾ TIẾP.');
}

db.close();
