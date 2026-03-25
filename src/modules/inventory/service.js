/**
 * Beer POS - Inventory Service
 * Feature #13: Tách Sales/Keg/Inventory thành 3 module rõ ràng
 *
 * Nghiệp vụ Inventory:
 * - Quản lý tồn kho sản phẩm (stock)
 * - Nhập/xuất kho
 * - Kiểm tra tồn kho
 * - Cảnh báo hết hàng
 */

const db = require('../../../database');
const logger = require('../../utils/logger');

/**
 * Cập nhật tồn kho sản phẩm
 * @param {number} productId - ID sản phẩm
 * @param {number} delta - Số lượng thay đổi (dương = nhập, âm = xuất)
 * @param {string} note - Ghi chú
 * @param {string} type - Loại: 'import', 'sale', 'adjust', 'damaged'
 * @returns {Object} { oldStock, newStock, product }
 */
function updateStock(productId, delta, note = null, type = 'adjust') {
  const tx = db.transaction(() => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new Error(`Sản phẩm ${productId} không tồn tại`);

    const oldStock = product.stock || 0;
    const newStock = Math.max(0, oldStock + parseInt(delta));

    // Update stock
    db.prepare('UPDATE products SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStock, productId);

    // Log vào stock_history (tạo bảng nếu chưa có)
    try {
      db.prepare(`
        INSERT INTO stock_history (product_id, change, stock_after, type, note, created_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(productId, delta, newStock, type, note);
    } catch (e) {
      // stock_history có thể chưa có, ignore
    }

    // Nếu là keg, sync với keg_stats
    if (product.type === 'keg') {
      syncKegInventory();
    }

    return { oldStock, newStock, product };
  });

  return tx();
}

/**
 * Set tồn kho tuyệt đối (thay vì cộng/trừ)
 * @param {number} productId
 * @param {number} newStock
 * @param {string} note
 */
function setStock(productId, newStock, note = null) {
  const tx = db.transaction(() => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new Error(`Sản phẩm ${productId} không tồn tại`);

    const delta = parseInt(newStock) - (product.stock || 0);

    db.prepare('UPDATE products SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStock, productId);

    // Log
    try {
      db.prepare(`
        INSERT INTO stock_history (product_id, change, stock_after, type, note, created_at)
        VALUES (?, ?, ?, 'set', ?, CURRENT_TIMESTAMP)
      `).run(productId, delta, newStock, note);
    } catch (e) {}

    // Nếu là keg, sync với keg_stats
    if (product.type === 'keg') {
      syncKegInventory();
    }

    return { oldStock: product.stock, newStock };
  });

  return tx();
}

/**
 * Sync keg inventory từ products sang keg_stats
 * (Dùng cho keg type)
 */
function syncKegInventory() {
  try {
    const inventory = db.prepare(
      "SELECT COALESCE(SUM(stock), 0) as n FROM products WHERE type = 'keg'"
    ).get().n || 0;

    db.prepare(`
      UPDATE keg_stats
      SET inventory = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(inventory);

    return inventory;
  } catch (e) {
    logger.warn('syncKegInventory error:', e.message);
    return null;
  }
}

/**
 * Lấy tất cả sản phẩm với tồn kho
 * @param {Object} options
 * @returns {Array}
 */
function getInventory(options = {}) {
  const { type = null, lowStock = false, includeOutOfStock = true } = options;

  let query = 'SELECT * FROM products WHERE 1=1';
  const params = [];

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  if (!includeOutOfStock) {
    query += ' AND stock > 0';
  }

  if (lowStock) {
    // Cảnh báo: stock <= 5
    query += ' AND stock <= 5';
  }

  query += ' ORDER BY name ASC';

  const products = db.prepare(query).all(...params);

  return products.map(p => ({
    ...p,
    isLowStock: p.stock <= 5,
    isOutOfStock: p.stock <= 0
  }));
}

/**
 * Lấy chi tiết tồn kho một sản phẩm
 * @param {number} productId
 * @returns {Object}
 */
function getProductStock(productId) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return null;

  // Lấy lịch sử tồn kho (nếu có)
  let history = [];
  try {
    history = db.prepare(`
      SELECT * FROM stock_history
      WHERE product_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(productId);
  } catch (e) {
    // stock_history có thể chưa có
  }

  return {
    ...product,
    history,
    isLowStock: product.stock <= 5,
    isOutOfStock: product.stock <= 0
  };
}

/**
 * Thống kê tồn kho tổng quan
 * @returns {Object}
 */
function getInventoryStats() {
  const products = db.prepare('SELECT * FROM products').all();

  const stats = {
    totalProducts: products.length,
    lowStock: products.filter(p => p.stock <= 5 && p.stock > 0).length,
    outOfStock: products.filter(p => p.stock <= 0).length,
    totalValue: 0,
    byType: {}
  };

  products.forEach(p => {
    stats.totalValue += (p.stock || 0) * (p.cost_price || 0);

    if (!stats.byType[p.type]) {
      stats.byType[p.type] = { count: 0, stock: 0, value: 0 };
    }
    stats.byType[p.type].count++;
    stats.byType[p.type].stock += p.stock || 0;
    stats.byType[p.type].value += (p.stock || 0) * (p.cost_price || 0);
  });

  return stats;
}

/**
 * Tạo bảng stock_history nếu chưa có
 */
function ensureStockHistoryTable() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS stock_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        change INTEGER NOT NULL,
        stock_after INTEGER NOT NULL,
        type TEXT DEFAULT 'adjust',
        note TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_history_product ON stock_history(product_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_history_date ON stock_history(created_at)`);
  } catch (e) {
    // Table có thể đã tồn tại
  }
}

// Auto-ensure table on module load
ensureStockHistoryTable();

module.exports = {
  updateStock,
  setStock,
  syncKegInventory,
  getInventory,
  getProductStock,
  getInventoryStats,
  ensureStockHistoryTable
};
