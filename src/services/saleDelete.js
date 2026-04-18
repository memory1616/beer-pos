/**
 * Xóa hóa đơn và hoàn tồn kho / vỏ — dùng chung cho DELETE /api/sales và /api/sync/push.
 * 
 * CRITICAL FIX: Sử dụng SOFT-DELETE (archived = 1) thay vì hard-delete.
 * Điều này đảm bảo:
 * 1. Revenue được loại bỏ khỏi báo cáo (vì queries có filter archived = 0)
 * 2. Inventory được restore
 * 3. Data có thể khôi phục nếu cần
 * 4. Audit trail được bảo tồn
 * 5. Transaction atomic để không có partial state
 */
const db = require('../../database');
const logger = require('../../src/utils/logger');

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
 * Core function: Xóa đơn hàng với đầy đủ rollback và logging.
 * SỬ DỤNG SOFT-DELETE: Thay vì xóa row, set archived = 1
 * 
 * @param {number|string} saleId
 * @returns {{ ok: true } | { ok: false, code: 'not_found' | 'returned' | 'already_deleted' }}
 */
function deleteSaleRestoringInventory(saleId) {
  const id = Number(saleId);
  if (!Number.isFinite(id)) {
    console.log('[ORDER DELETE] ❌ Invalid saleId:', saleId);
    return { ok: false, code: 'not_found' };
  }

  console.log('[ORDER DELETE] 🔍 Starting soft-delete for saleId:', id);

  // Kiểm tra sale tồn tại
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  console.log('[ORDER DELETE] Sale found:', JSON.stringify(sale));
  if (!sale) {
    console.log('[ORDER DELETE] ❌ Sale not found:', id);
    return { ok: false, code: 'not_found' };
  }
  
  // Kiểm tra đã archived chưa (tránh xóa 2 lần)
  if (sale.archived === 1) {
    console.log('[ORDER DELETE] ⚠️ Sale already archived, skipping:', id);
    return { ok: false, code: 'already_deleted' };
  }
  
  // Kiểm tra đã returned chưa
  if (sale.status === 'returned') {
    console.log('[ORDER DELETE] ⚠️ Sale already returned, skipping delete:', id);
    return { ok: false, code: 'returned' };
  }

  // Lấy items trước khi xóa
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(id);
  console.log('[ORDER DELETE] Items to restore:', items.length);
  console.log('[ORDER DELETE] Sale total to be removed from revenue:', sale.total);
  console.log('[ORDER DELETE] Sale profit to be removed:', sale.profit);

  // Bắt đầu transaction
  const deleteSaleTx = db.transaction(() => {
    try {
      // ===== A. RESTORE PRODUCT STOCK =====
      if (shouldReverseProductStock(sale)) {
        console.log('[ORDER DELETE tx] 🔄 Restoring product stock for', items.length, 'items');
        for (const item of items) {
          const r = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
          console.log('[ORDER DELETE tx] ✅ Restored stock: product', item.product_id, '+' + item.quantity, '| changes:', r.changes);

          // Audit log — stock restored when sale is deleted
          const customer = sale.customer_id
            ? db.prepare('SELECT name FROM customers WHERE id = ?').get(sale.customer_id)
            : null;
          db.prepare(`
            INSERT INTO product_audit_log (product_id, type, quantity, reason, ref_id, ref_type, customer_name, note)
            VALUES (?, 'restore', ?, 'sale_delete', ?, 'sale', ?, ?)
          `).run(item.product_id, item.quantity, id, customer ? customer.name : null, 'Hoàn kho do xóa đơn');
        }
        console.log('[ORDER DELETE tx] ✅ Product stock restoration complete');
      } else {
        console.log('[ORDER DELETE tx] ⏭️ Skipping product stock restore — shouldReverse:', shouldReverseProductStock(sale), 'type:', sale.type);
      }

      // ===== B. RESTORE KEG BALANCE (nếu có customer) =====
      if (sale.customer_id && (sale.deliver_kegs !== 0 || sale.return_kegs !== 0)) {
        console.log('[ORDER DELETE tx] 🔄 Restoring keg balance:', sale.deliver_kegs, sale.return_kegs);
        const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(sale.customer_id);
        const currentBalance = customer ? customer.keg_balance : 0;
        // Khi xóa đơn: khách phải trả lại số vỏ đã giao, và nhận lại số vỏ đã thu
        const restoredBalance = currentBalance - sale.deliver_kegs + sale.return_kegs;
        console.log('[ORDER DELETE tx] ✅ Keg balance:', currentBalance, '→', restoredBalance);
        db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(restoredBalance, sale.customer_id);
      }

      // ===== C. RESTORE EMPTY COLLECTED (keg_stats) =====
      if (sale.return_kegs > 0 && sale.type !== 'gift') {
        const stats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
        if (stats) {
          const newEmpty = Math.max(0, stats.empty_collected - sale.return_kegs);
          console.log('[ORDER DELETE tx] 🔄 Restoring empty_collected:', stats.empty_collected, '→', newEmpty);
          db.prepare('UPDATE keg_stats SET empty_collected = ? WHERE id = 1').run(newEmpty);
        }
      }

      // Gift: restore empty_collected for each item
      if (sale.type === 'gift') {
        const stats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
        if (stats) {
          for (const item of items) {
            const newEmpty = Math.max(0, stats.empty_collected - item.quantity);
            console.log('[ORDER DELETE tx] 🔄 Gift item - restoring empty_collected:', stats.empty_collected, '→', newEmpty);
            db.prepare('UPDATE keg_stats SET empty_collected = ? WHERE id = 1').run(newEmpty);
            stats.empty_collected = newEmpty;
          }
        }
      }

      // ===== D. SYNC KEG STATS =====
      const inventoryResult = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get();
      const totalHolding = db.prepare("SELECT COALESCE(SUM(keg_balance), 0) as total FROM customers").get();
      db.prepare(`
        UPDATE keg_stats
        SET inventory = ?, customer_holding = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run(inventoryResult.total, totalHolding.total);

      // ===== E. SOFT DELETE: Set archived = 1 (thay vì hard-delete) =====
      // Revenue sẽ tự động bị loại khỏi báo cáo vì tất cả queries đều có filter archived = 0
      console.log('[ORDER DELETE tx] 🗄️ Soft deleting sale:', id, '| total:', sale.total, '| profit:', sale.profit);
      db.prepare('UPDATE sales SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
      
      // NOTE: Không xóa sale_items - giữ lại để có thể khôi phục nếu cần
      // Hoặc có thể xóa nếu muốn tiết kiệm storage:
      // db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(id);

      console.log('[ORDER DELETE tx] ✅ Transaction committed successfully');
      console.log('[REVENUE UPDATED] Sale #' + id + ' archived — removed from reports (archived=1, total: ' + sale.total + ', profit: ' + sale.profit + ')');
      console.log('[STOCK RESTORED] ' + items.length + ' items restored to inventory');
      
    } catch (err) {
      console.error('[ORDER DELETE tx] ❌ Transaction failed:', err.message);
      console.error('[ORDER DELETE tx] Stack:', err.stack);
      throw err; // Re-throw to trigger rollback
    }
  });

  try {
    deleteSaleTx();
    logger.info('[ORDER DELETE] ✅ Sale archived successfully', { saleId: id, total: sale.total, profit: sale.profit, itemsCount: items.length });
    return { ok: true };
  } catch (err) {
    logger.error('[ORDER DELETE] ❌ Delete failed', { saleId: id, error: err.message });
    return { ok: false, code: 'transaction_failed' };
  }
}

module.exports = {
  deleteSaleRestoringInventory,
  shouldReverseProductStock
};
