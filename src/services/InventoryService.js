/**
 * InventoryService - Business logic cho inventory
 */
const db = require('../../database');
const logger = require('../utils/logger');

class InventoryService {
  getStockSummary() {
    const products = db.prepare(`
      SELECT id, name, stock, damaged_stock, cost_price, sell_price, type
      FROM products WHERE archived = 0
    `).all();

    const totalStock = products.reduce((sum, p) => sum + (p.stock > 0 ? p.stock : 0), 0);
    const totalDamaged = products.reduce((sum, p) => sum + (p.damaged_stock || 0), 0);

    return { products, totalStock, totalDamaged };
  }

  import(data) {
    const { items, note } = data;
    if (!items || items.length === 0) {
      return { success: false, error: 'Danh sách trống' };
    }

    let totalAmount = 0;
    const createImport = db.transaction(() => {
      const date = db.getVietnamDateStr();
      const result = db.prepare(`
        INSERT INTO purchases (date, total_amount, note) VALUES (?, 0, ?)
      `).run(date, note || '');
      const purchaseId = result.lastInsertRowid;

      for (const item of items) {
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
        if (!product) continue;

        const totalPrice = item.quantity * item.unitPrice;
        totalAmount += totalPrice;

        db.prepare(`
          INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_price, total_price)
          VALUES (?, ?, ?, ?, ?)
        `).run(purchaseId, item.productId, item.quantity, item.unitPrice, totalPrice);

        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.productId);

        db.prepare(`
          INSERT INTO product_audit_log (product_id, type, quantity, reason, ref_id, ref_type, note)
          VALUES (?, 'import', ?, 'purchase', ?, 'purchase', ?)
        `).run(item.productId, item.quantity, purchaseId, note || '');
      }

      db.prepare('UPDATE purchases SET total_amount = ? WHERE id = ?').run(totalAmount, purchaseId);

      return purchaseId;
    });

    const purchaseId = createImport();
    return { success: true, purchaseId, totalAmount };
  }
}

module.exports = InventoryService;
