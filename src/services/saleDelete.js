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
    return { ok: false, code: 'not_found' };
  }

  // Check if sale exists
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  if (!sale) {
    return { ok: false, code: 'not_found' };
  }

  // Check if already archived (prevent double-delete)
  if (sale.archived === 1) {
    return { ok: false, code: 'already_deleted' };
  }

  // Check if already returned
  if (sale.status === 'returned') {
    return { ok: false, code: 'returned' };
  }

  // Get items before delete
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(id);

  // Begin transaction
  const deleteSaleTx = db.transaction(() => {
    try {
      // ===== A. RESTORE PRODUCT STOCK =====
      if (shouldReverseProductStock(sale)) {
        for (const item of items) {
          db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);

          // Audit log — stock restored when sale is deleted
          const customer = sale.customer_id
            ? db.prepare('SELECT name FROM customers WHERE id = ?').get(sale.customer_id)
            : null;
          db.prepare(`
            INSERT INTO product_audit_log (product_id, type, quantity, reason, ref_id, ref_type, customer_name, note)
            VALUES (?, 'restore', ?, 'sale_delete', ?, 'sale', ?, ?)
          `).run(item.product_id, item.quantity, id, customer ? customer.name : null, 'Hoàn kho do xóa đơn');
        }
      }

      // ===== B. RESTORE monthly_purchased_liters (chỉ restore items keg có giá > 0, loại trừ pet/box và lít tặng) =====
      if (sale.customer_id && sale.type === 'sale' && sale.promo_type !== 'MONTHLY_BONUS') {
        const paidKegItems = db.prepare(`
          SELECT COALESCE(SUM(si.quantity), 0) as total
          FROM sale_items si
          JOIN products p ON p.id = si.product_id
          WHERE si.sale_id = ? AND si.price > 0 AND p.type = 'keg'
        `).get(sale.id);
        const paidLiters = paidKegItems ? paidKegItems.total : 0;
        if (paidLiters > 0) {
          db.prepare('UPDATE customers SET monthly_purchased_liters = MAX(0, monthly_purchased_liters - ?) WHERE id = ?').run(paidLiters, sale.customer_id);
        }
      }

      // ===== B2. REVERT reward_claimed nếu xóa MONTHLY_BONUS =====
      if (sale.customer_id && sale.promo_type === 'MONTHLY_BONUS') {
        db.prepare("UPDATE customers SET reward_claimed = 0, reward_claimed_at = NULL WHERE id = ?").run(sale.customer_id);
        db.prepare("DELETE FROM reward_history WHERE customer_id = ? AND claimed_at >= date('now', '-1 day')").run(sale.customer_id);
      }

      // ===== C. RESTORE KEG BALANCE (nếu có customer) =====
      if (sale.customer_id && (sale.deliver_kegs !== 0 || sale.return_kegs !== 0)) {
        const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(sale.customer_id);
        const currentBalance = customer ? customer.keg_balance : 0;
        const restoredBalance = currentBalance - sale.deliver_kegs + sale.return_kegs;
        db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(restoredBalance, sale.customer_id);
      }

      // ===== D. SYNC KEG STATS =====
      const inventoryResult = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get();
      const totalHolding = db.prepare("SELECT COALESCE(SUM(keg_balance), 0) as total FROM customers").get();
      db.prepare(`
        UPDATE keg_stats
        SET inventory = ?, customer_holding = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run(inventoryResult.total, totalHolding.total);

      // ===== E. SOFT DELETE =====
      db.prepare('UPDATE sales SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);

    } catch (err) {
      throw err;
    }
  });

  try {
    deleteSaleTx();
    logger.info('[ORDER DELETE] Sale archived', { saleId: id, total: sale.total, profit: sale.profit, itemsCount: items.length });
    return { ok: true };
  } catch (err) {
    logger.error('[ORDER DELETE] Delete failed', { saleId: id, error: err.message });
    return { ok: false, code: 'transaction_failed' };
  }
}

module.exports = {
  deleteSaleRestoringInventory,
  shouldReverseProductStock
};
