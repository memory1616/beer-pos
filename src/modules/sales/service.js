/**
 * Beer POS - Sales Service
 * Feature #13: Tách Sales/Keg/Inventory thành 3 module rõ ràng
 *
 * Nghiệp vụ Sales:
 * - Tạo đơn hàng mới với items
 * - Cập nhật đơn hàng
 * - Xóa/Hủy đơn hàng
 * - Tính total, profit
 * - Gọi Keg Module để cập nhật vỏ bình
 */

const db = require('../../../database');
const logger = require('../../utils/logger');
const { KEG_POOL, KEG_SOURCE } = require('../../constants');

// Lazy import để tránh circular dependency
let _kegService = null;
let _inventoryService = null;

function getKegService() {
  if (!_kegService) _kegService = require('../keg/service');
  return _kegService;
}
function getInventoryService() {
  if (!_inventoryService) _inventoryService = require('../inventory/service');
  return _inventoryService;
}

/**
 * Tạo đơn hàng mới
 * @param {Object} data - { customerId, items, deliverKegs, returnKegs, note, date }
 * @param {Object} req - Express request (để audit)
 * @returns {Object} { saleId, total, profit }
 */
function createSale(data, req = {}) {
  const { customerId, items, deliverKegs = 0, returnKegs = 0, note = null, date = null, type = 'sale' } = data;

  const tx = db.transaction(() => {
    // 1. Tính total và profit
    let total = 0;
    let profit = 0;

    const processedItems = items.map(item => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
      if (!product) throw new Error(`Sản phẩm ${item.productId} không tồn tại`);

      // Lấy giá: custom price > product sell_price
      let price = item.price || 0;
      if (!price && customerId) {
        const customPrice = db.prepare('SELECT price FROM prices WHERE customer_id = ? AND product_id = ?').get(customerId, item.productId);
        price = customPrice?.price || product.sell_price;
      }
      if (!price) price = product.sell_price;

      const itemTotal = price * item.quantity;
      const itemCost = (product.cost_price || 0) * item.quantity;
      const itemProfit = itemTotal - itemCost;

      total += itemTotal;
      profit += itemProfit;

      return {
        productId: item.productId,
        quantity: item.quantity,
        price: price,
        costPrice: product.cost_price || 0,
        profit: itemProfit,
        priceAtTime: price
      };
    });

    // 2. Tạo sale record
    const saleResult = db.prepare(`
      INSERT INTO sales (customer_id, date, total, profit, deliver_kegs, return_kegs, note, type, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', CURRENT_TIMESTAMP)
    `).run(
      customerId || null,
      date || new Date().toISOString(),
      total,
      profit,
      deliverKegs,
      returnKegs,
      note,
      type
    );
    const saleId = saleResult.lastInsertRowid;

    // 3. Tạo sale_items
    const insertItem = db.prepare(`
      INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price, profit, price_at_time, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    processedItems.forEach(item => {
      insertItem.run(saleId, item.productId, item.quantity, item.price, item.costPrice, item.profit, item.priceAtTime);
    });

    // 4. Cập nhật keg balance nếu có vỏ bình
    let kegResult = null;
    if ((deliverKegs > 0 || returnKegs > 0) && customerId) {
      try {
        const kegService = getKegService();
        kegResult = kegService.updateCustomerKegBalanceTx(
          customerId,
          deliverKegs,
          returnKegs,
          KEG_SOURCE.SALE,
          saleId
        );
      } catch (e) {
        logger.warn('Keg update failed during sale creation:', e.message);
      }
    }

    // 5. Cập nhật tồn kho
    try {
      const inventoryService = getInventoryService();
      processedItems.forEach(item => {
        inventoryService.updateStock(item.productId, -item.quantity, `Sale #${saleId}`);
      });
    } catch (e) {
      logger.warn('Inventory update failed during sale creation:', e.message);
    }

    // 6. Cập nhật last_order_date cho khách
    if (customerId) {
      db.prepare('UPDATE customers SET last_order_date = ? WHERE id = ?')
        .run(date || new Date().toISOString(), customerId);
    }

    // 7. Audit log (Feature #12)
    try {
      const { logAudit } = require('../../services/audit');
      logAudit({
        entityType: 'sale',
        entityId: saleId,
        action: 'create',
        oldValue: null,
        newValue: { customerId, total, profit, items: processedItems, deliverKegs, returnKegs }
      }, req);
    } catch (e) {
      // Audit không ảnh hưởng flow chính
    }

    return { saleId, total, profit, kegBalance: kegResult?.newBalance };
  });

  return tx();
}

/**
 * Cập nhật đơn hàng
 * @param {number} saleId
 * @param {Object} data - Các field cần cập nhật
 * @param {Object} req
 * @returns {Object}
 */
function updateSale(saleId, data, req = {}) {
  const tx = db.transaction(() => {
    // Lấy sale cũ
    const oldSale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!oldSale) throw new Error('Đơn hàng không tồn tại');

    const { items, deliverKegs, returnKegs, note, status } = data;

    // Recalculate total/profit nếu có items mới
    let total = oldSale.total;
    let profit = oldSale.profit;

    if (items && Array.isArray(items) && items.length > 0) {
      // Xóa items cũ
      db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(saleId);

      total = 0;
      profit = 0;

      const insertItem = db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price, profit, price_at_time, updated_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `);

      items.forEach(item => {
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
        if (!product) throw new Error(`Sản phẩm ${item.productId} không tồn tại`);

        let price = item.price || product.sell_price;
        const itemTotal = price * item.quantity;
        const itemCost = (product.cost_price || 0) * item.quantity;
        const itemProfit = itemTotal - itemCost;

        total += itemTotal;
        profit += itemProfit;

        insertItem.run(saleId, item.productId, item.quantity, price, product.cost_price || 0, itemProfit, price);
      });
    }

    // Cập nhật sale
    db.prepare(`
      UPDATE sales SET
        total = ?,
        profit = ?,
        deliver_kegs = COALESCE(?, deliver_kegs),
        return_kegs = COALESCE(?, return_kegs),
        note = COALESCE(?, note),
        status = COALESCE(?, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(total, profit, deliverKegs, returnKegs, note, status, saleId);

    // Audit log
    try {
      const { logAudit } = require('../../services/audit');
      logAudit({
        entityType: 'sale',
        entityId: saleId,
        action: 'update',
        oldValue: oldSale,
        newValue: { ...oldSale, ...data, total, profit }
      }, req);
    } catch (e) {}

    return db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  });

  return tx();
}

/**
 * Xóa đơn hàng (soft delete - chuyển status)
 * @param {number} saleId
 * @param {Object} req
 */
function deleteSale(saleId, req = {}) {
  const tx = db.transaction(() => {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) throw new Error('Đơn hàng không tồn tại');

    // Chuyển status thành cancelled
    db.prepare("UPDATE sales SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(saleId);

    // Hoàn tác keg balance nếu có
    if ((sale.deliver_kegs > 0 || sale.return_kegs > 0) && sale.customer_id) {
      try {
        const kegService = getKegService();
        // Hoàn tác: deliver_kegs thì thu về, return_kegs thì giao lại
        kegService.updateCustomerKegBalanceTx(
          sale.customer_id,
          sale.return_kegs,  // thu về thì giao lại cho khách
          sale.deliver_kegs, // giao đi thì thu về
          KEG_SOURCE.RETURN_SALE,
          saleId
        );
      } catch (e) {
        logger.warn('Keg reversal failed:', e.message);
      }
    }

    // Hoàn tác tồn kho
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
    try {
      const inventoryService = getInventoryService();
      items.forEach(item => {
        inventoryService.updateStock(item.product_id, item.quantity, `Sale #${saleId} cancelled`);
      });
    } catch (e) {
      logger.warn('Inventory reversal failed:', e.message);
    }

    // Audit log
    try {
      const { logAudit } = require('../../services/audit');
      logAudit({
        entityType: 'sale',
        entityId: saleId,
        action: 'delete',
        oldValue: sale,
        newValue: null
      }, req);
    } catch (e) {}
  });

  tx();
}

/**
 * Lấy chi tiết đơn hàng
 * @param {number} saleId
 * @returns {Object}
 */
function getSale(saleId) {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return null;

  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
  const customer = sale.customer_id
    ? db.prepare('SELECT id, name, phone, address FROM customers WHERE id = ?').get(sale.customer_id)
    : null;

  return { ...sale, items, customer };
}

/**
 * Lấy danh sách đơn hàng với filter
 * @param {Object} options
 * @returns {Array}
 */
function getSales(options = {}) {
  const { customerId, status, fromDate, toDate, page = 1, limit = 50 } = options;

  const conditions = [];
  const params = [];

  if (customerId) {
    conditions.push('s.customer_id = ?');
    params.push(customerId);
  }
  if (status) {
    conditions.push('s.status = ?');
    params.push(status);
  }
  if (fromDate) {
    conditions.push('s.date >= ?');
    params.push(fromDate);
  }
  if (toDate) {
    conditions.push('s.date <= ?');
    params.push(toDate);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

  const sales = db.prepare(`
    SELECT s.*, c.name as customer_name, c.phone as customer_phone
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    ${where}
    ORDER BY s.date DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  return { data: sales, page: parseInt(page), limit: parseInt(limit) };
}

module.exports = {
  createSale,
  updateSale,
  deleteSale,
  getSale,
  getSales
};
