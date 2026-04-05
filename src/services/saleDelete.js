/**
 * Xóa hóa đơn và hoàn tồn kho / vỏ — dùng chung cho DELETE /api/sales và /api/sync/push.
 */
const db = require('../../database');

/** Đơn loại này đã trừ products.stock khi tạo → cần cộng lại khi xóa (kể cả type legacy / sync). */
function shouldReverseProductStock(sale) {
  if (!sale || sale.status === 'returned') return false;
  const t = sale.type;
  if (t == null || t === '') return true;
  return (
    t === 'sale' ||
    t === 'replacement' ||
    t === 'gift' ||
    t === 'normal'
  );
}

/**
 * @param {number|string} saleId
 * @returns {{ ok: true } | { ok: false, code: 'not_found' | 'returned' }}
 */
function deleteSaleRestoringInventory(saleId) {
  const id = Number(saleId);
  if (!Number.isFinite(id)) return { ok: false, code: 'not_found' };

  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  if (!sale) return { ok: false, code: 'not_found' };
  if (sale.status === 'returned') return { ok: false, code: 'returned' };

  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(id);

  const deleteSaleTx = db.transaction(() => {
    if (shouldReverseProductStock(sale)) {
      for (const item of items) {
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
      }
    }

    if (sale.customer_id && (sale.deliver_kegs !== 0 || sale.return_kegs !== 0)) {
      const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(sale.customer_id);
      const currentBalance = customer ? customer.keg_balance : 0;
      const restoredBalance = currentBalance - sale.deliver_kegs + sale.return_kegs;
      db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(restoredBalance, sale.customer_id);
    }

    if (sale.return_kegs > 0 && sale.type !== 'gift') {
      const stats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
      if (stats) {
        const newEmpty = Math.max(0, stats.empty_collected - sale.return_kegs);
        db.prepare('UPDATE keg_stats SET empty_collected = ? WHERE id = 1').run(newEmpty);
      }
    }

    if (sale.type === 'gift') {
      const stats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
      if (stats) {
        for (const item of items) {
          const newEmpty = Math.max(0, stats.empty_collected - item.quantity);
          db.prepare('UPDATE keg_stats SET empty_collected = ? WHERE id = 1').run(newEmpty);
          stats.empty_collected = newEmpty;
        }
      }
    }

    const inventoryResult = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get();
    const totalHolding = db.prepare("SELECT COALESCE(SUM(keg_balance), 0) as total FROM customers").get();
    db.prepare(`
      UPDATE keg_stats
      SET inventory = ?, customer_holding = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(inventoryResult.total, totalHolding.total);

    db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(id);
    db.prepare('DELETE FROM sales WHERE id = ?').run(id);
  });

  deleteSaleTx();
  return { ok: true };
}

module.exports = {
  deleteSaleRestoringInventory,
  shouldReverseProductStock
};
