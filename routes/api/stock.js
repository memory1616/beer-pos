const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');
const { syncKegInventory } = require('./products');
const socketServer = require('../../src/socket/socketServer');

// Validate ID parameter
function validateId(id) {
  const parsed = parseInt(id);
  if (isNaN(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

// Validate stock input
function validateStockInput(body) {
  const errors = [];

  if (!body) {
    errors.push('Dữ liệu yêu cầu trống');
    return { valid: false, errors };
  }

  const { productId, quantity, stock } = body;

  // For stock import
  if (quantity !== undefined) {
    const qty = parseInt(quantity);
    if (isNaN(qty) || qty <= 0) {
      errors.push('Số lượng nhập phải lớn hơn 0');
    }
  }

  // For stock set
  if (stock !== undefined) {
    const s = parseInt(stock);
    if (isNaN(s) || s < 0) {
      errors.push('Tồn kho không được âm');
    }
  }

  // Validate productId
  const prodId = validateId(productId);
  if (!prodId) {
    errors.push('ID sản phẩm không hợp lệ');
  }

  return { valid: errors.length === 0, errors };
}

// GET /api/stock/alerts - Lấy cảnh báo tồn kho thấp
router.get('/alerts', (req, res) => {
  try {
    const threshold = parseInt(req.query.threshold) || 10;
    const products = db.prepare(`
      SELECT id, name, stock, type
      FROM products
      WHERE stock <= ?
      ORDER BY stock ASC
    `).all(threshold);

    res.json({
      count: products.length,
      threshold: threshold,
      products: products
    });
  } catch (err) {
    logger.error('Error fetching stock alerts', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi lấy cảnh báo tồn kho' });
  }
});

// GET /api/stock/history - Lịch sử nhập/xuất kho
router.get('/history', (req, res) => {
  try {
    const productId = req.query.productId;
    const limit = parseInt(req.query.limit) || 100;

    if (!productId) {
      return res.status(400).json({ error: 'Thiếu productId' });
    }

    const prodId = validateId(productId);
    if (!prodId) {
      return res.status(400).json({ error: 'ID sản phẩm không hợp lệ' });
    }

    // Get import history (from purchases) — include purchase note
    const imports = db.prepare(`
      SELECT pi.id, pi.quantity, pi.unit_price, pi.total_price, p.date,
             'import' as type, p.note, NULL as customer_name
      FROM purchase_items pi
      JOIN purchases p ON pi.purchase_id = p.id
      WHERE pi.product_id = ?
      ORDER BY p.date DESC
      LIMIT ?
    `).all(prodId, limit);

    // Get export history (from sales) — include customer name
    const exports = db.prepare(`
      SELECT si.id, si.quantity, si.price as unit_price, si.quantity * si.price as total_price,
             s.date, 'export' as type, s.note, c.name as customer_name
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      LEFT JOIN customers c ON s.customer_id = c.id
      WHERE si.product_id = ?
      ORDER BY s.date DESC
      LIMIT ?
    `).all(prodId, limit);

    // Combine and sort by date descending
    const history = [...imports, ...exports].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, limit);

    res.json(history);
  } catch (err) {
    logger.error('Error fetching stock history', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi lấy lịch sử kho' });
  }
});

// POST /api/stock - Nhập hàng (cộng dồn)
router.post('/', (req, res) => {
  const validation = validateStockInput(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.errors.join(', ') });
  }

  try {
    const { productId, quantity } = req.body;
    const prodId = validateId(productId);
    const qty = parseInt(quantity);

    // Check if product exists
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(prodId);
    if (!product) {
      return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    }

    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, prodId);
    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(prodId);
    socketServer.emitInventoryUpdated({ product: updated });
    res.json(updated);
  } catch (err) {
    logger.error('Error importing stock', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi nhập kho' });
  }
});

// POST /api/stock/set - Đặt trực tiếp số lượng tồn kho
router.post('/set', (req, res) => {
  const { productId, stock } = req.body;

  const prodId = validateId(productId);
  if (!prodId) {
    return res.status(400).json({ error: 'ID sản phẩm không hợp lệ' });
  }

  if (stock === undefined || stock === null || isNaN(parseInt(stock)) || parseInt(stock) < 0) {
    return res.status(400).json({ error: 'Tồn kho không hợp lệ' });
  }

  try {
    // Check if product exists
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(prodId);
    if (!product) {
      return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    }

    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(parseInt(stock), prodId);
    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(prodId);
    socketServer.emitInventoryUpdated({ product: updated });
    res.json(updated);
  } catch (err) {
    logger.error('Error setting stock', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật tồn kho' });
  }
});

// POST /api/stock/multiple - Nhập kho nhiều sản phẩm (cũng lưu lịch sử nhập hàng)
router.post('/multiple', (req, res) => {
  const { items, note } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Danh sách sản phẩm trống' });
  }

  try {
    // Tính tổng tiền
    let totalAmount = 0;
    const validItems = [];
    
    for (const item of items) {
      const prodId = validateId(item.productId);
      const qty = parseInt(item.quantity);
      const costPrice = parseFloat(item.costPrice) || 0;

      if (!prodId || isNaN(qty) || qty <= 0) {
        continue;
      }

      totalAmount += qty * costPrice;
      validItems.push({ productId: prodId, quantity: qty, unitPrice: costPrice });
    }

    if (validItems.length === 0) {
      return res.status(400).json({ error: 'Danh sách sản phẩm không hợp lệ' });
    }

    // Tạo phiếu nhập hàng
    const purchaseResult = db.prepare('INSERT INTO purchases (total_amount, note) VALUES (?, ?)').run(totalAmount, note || 'Nhập kho');
    const purchaseId = purchaseResult.lastInsertRowid;

    // Cập nhật tồn kho và lưu chi tiết
    const updateStmt = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
    const insertItemStmt = db.prepare('INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?)');
    const results = [];

    for (const item of validItems) {
      updateStmt.run(item.quantity, item.productId);
      insertItemStmt.run(purchaseId, item.productId, item.quantity, item.unitPrice, item.quantity * item.unitPrice);

      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
      if (product) {
        results.push(product);
      }
    }

    // ========== Cập nhật vỏ rỗng ==========
    // Nhập hàng từ nhà máy: dùng vỏ rỗng đi đổi bia → empty_collected GIẢM
    let totalKegs = 0;
    for (const item of validItems) {
      const product = db.prepare('SELECT type FROM products WHERE id = ?').get(item.productId);
      const productType = (product?.type || 'keg').toLowerCase();
      if (['keg', 'box'].includes(productType)) {
        totalKegs += item.quantity;
      }
    }

    if (totalKegs > 0) {
      let stats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
      if (!stats) {
        db.prepare('INSERT INTO keg_stats (id, inventory, empty_collected, customer_holding) VALUES (1, 0, 0, 0)').run();
        stats = { empty_collected: 0 };
      }
      const currentEmpty = stats.empty_collected || 0;
      const newEmpty = Math.max(0, currentEmpty - totalKegs);

      db.prepare('UPDATE keg_stats SET empty_collected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(newEmpty);

      db.prepare(`
        INSERT INTO keg_transactions_log (type, quantity, inventory_after, empty_after, holding_after, note)
        VALUES ('import', ?, 0, ?, 0, ?)
      `).run(totalKegs, newEmpty, 'Nhập kho từ trang stock');

      logger.debug('Stock multiple import', { emptyBefore: currentEmpty, totalKegs, emptyAfter: newEmpty });
    }

    // Sync keg inventory
    syncKegInventory();

    socketServer.emitInventoryUpdated({ purchaseId });
    socketServer.emitReportUpdated({ reason: 'purchase', purchaseId });

    res.json({ purchase_id: purchaseId, total_amount: totalAmount, items: results });
  } catch (err) {
    logger.error('Error bulk importing stock', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi nhập kho' });
  }
});

module.exports = router;
