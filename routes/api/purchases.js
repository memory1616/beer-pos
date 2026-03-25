const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');
const { syncKegInventory } = require('./products');

// POST /api/purchases - Tạo phiếu nhập hàng mới
router.post('/', (req, res) => {
  const { items, note } = req.body;
  
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Danh sách sản phẩm trống' });
  }
  
  try {
    // ========== BƯỚC 1: Tính tổng tiền và tổng kegs ==========
    let totalAmount = 0;
    let totalKegs = 0;
    
    logger.debug('Purchase create', { itemsCount: items.length });
    
    for (const item of items) {
      const productId = parseInt(item.product_id);
      totalAmount += (parseInt(item.quantity) || 0) * (parseFloat(item.unit_price) || 0);
      
      // Lấy type của sản phẩm
      const product = db.prepare('SELECT id, name, type FROM products WHERE id = ?').get(productId);
      logger.debug('Purchase item', { productId, product });
      
      if (product) {
        const productType = (product.type || 'keg').toLowerCase();
        if (['keg', 'box'].includes(productType)) {
          const qty = parseInt(item.quantity) || 0;
          totalKegs += qty;
          logger.debug('KEG/BOX found', { productId, qty });
        } else {
          logger.debug('PET product, skipped');
        }
      } else {
        logger.debug('Product not found', { productId });
      }
    }
    logger.debug('Purchase totals', { totalKegs, totalAmount });
    
    // ========== BƯỚC 2: Tạo phiếu nhập ==========
    const purchaseResult = db.prepare('INSERT INTO purchases (total_amount, note) VALUES (?, ?)').run(totalAmount, note || null);
    const purchaseId = purchaseResult.lastInsertRowid;
    logger.debug('Purchase created', { purchaseId, totalAmount });
    
    // ========== BƯỚC 3: Thêm chi tiết và cập nhật tồn kho ==========
    for (const item of items) {
      const productId = parseInt(item.product_id);
      const qty = parseInt(item.quantity) || 0;
      const unitPrice = parseFloat(item.unit_price) || 0;
      const totalPrice = qty * unitPrice;
      
      db.prepare('INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?)').run(purchaseId, productId, qty, unitPrice, totalPrice);
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, productId);
    }
    logger.debug('Product stock updated');
    
    // ========== BƯỚC 4: Cập nhật vỏ rỗng ==========
    // Nhập hàng từ nhà máy: dùng vỏ rỗng đi đổi bia → empty_collected GIẢM
    let stats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
    if (!stats) {
      db.prepare('INSERT INTO keg_stats (id, inventory, empty_collected, customer_holding) VALUES (1, 0, 0, 0)').run();
      stats = { empty_collected: 0 };
    }
    const currentEmpty = stats.empty_collected || 0;
    const newEmpty = Math.max(0, currentEmpty - totalKegs);

    db.prepare('UPDATE keg_stats SET empty_collected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(newEmpty);
    logger.debug('Empty kegs updated', { emptyBefore: currentEmpty, totalKegs, emptyAfter: newEmpty });

    if (totalKegs > 0) {
      db.prepare(`
        INSERT INTO keg_transactions_log (type, quantity, inventory_after, empty_after, holding_after, note)
        VALUES ('import', ?, 0, ?, 0, ?)
      `).run(totalKegs, newEmpty, 'Nhập ' + totalKegs + ' vỏ từ nhà máy');
    }
    
    // ========== BƯỚC 5: Sync keg inventory ==========
    syncKegInventory();
    
    logger.info('Purchase created successfully', { purchaseId, totalKegs, totalAmount });
    res.json({ 
      id: purchaseId, 
      total_amount: totalAmount, 
      success: true,
      kegsImported: totalKegs,
      emptyBefore: currentEmpty,
      emptyAfter: newEmpty
    });
  } catch (err) {
    logger.error('Purchase create error', { error: err.message });
    res.status(500).json({ error: 'Lỗi tạo phiếu nhập', details: err.message });
  }
});

// GET /api/purchases
router.get('/', (req, res) => {
  const purchases = db.prepare(`
    SELECT p.*, 
      (SELECT GROUP_CONCAT(pi.quantity || 'x ' || pr.name) FROM purchase_items pi JOIN products pr ON pi.product_id = pr.id WHERE pi.purchase_id = p.id) as items_summary
    FROM purchases p 
    ORDER BY p.date DESC
    LIMIT 100
  `).all();
  res.json(purchases);
});

// GET single purchase with items
router.get('/:id', (req, res) => {
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(req.params.id);
  if (!purchase) return res.status(404).json({ error: 'Not found' });
  
  const items = db.prepare(`
    SELECT pi.*, pr.name as product_name
    FROM purchase_items pi
    JOIN products pr ON pi.product_id = pr.id
    WHERE pi.purchase_id = ?
  `).all(req.params.id);
  
  res.json({ ...purchase, items });
});

// PUT update purchase
router.put('/:id', (req, res) => {
  const { items, note } = req.body;
  
  const oldPurchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(req.params.id);
  if (!oldPurchase) return res.status(404).json({ error: 'Not found' });
  
  try {
    // Get old items to reverse stock
    const oldItems = db.prepare('SELECT product_id, quantity FROM purchase_items WHERE purchase_id = ?').all(req.params.id);
    
    // Reverse old stock
    for (const item of oldItems) {
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(item.quantity, item.product_id);
    }
    
    // Delete old items
    db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(req.params.id);
    
    // Calculate new total and add new items
    let totalAmount = 0;
    if (items && items.length > 0) {
      for (const item of items) {
        const quantity = parseInt(item.quantity) || 0;
        const unitPrice = parseFloat(item.unit_price) || 0;
        const totalPrice = quantity * unitPrice;
        totalAmount += totalPrice;
        
        db.prepare('INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?)').run(
          req.params.id, item.product_id, quantity, unitPrice, totalPrice
        );
        
        // Update stock and cost_price
        if (quantity > 0) {
          db.prepare('UPDATE products SET stock = stock + ?, cost_price = ? WHERE id = ?').run(quantity, unitPrice, item.product_id);
        }
      }
    }
    
    // Sync keg inventory
    syncKegInventory();
    
    // Update purchase record
    db.prepare('UPDATE purchases SET total_amount = ?, note = ? WHERE id = ?').run(totalAmount, note || null, req.params.id);
    
    res.json({ success: true });
  } catch (err) {
    logger.error('Purchase update error', { error: err.message });
    res.status(500).json({ error: 'Lỗi cập nhật đơn nhập' });
  }
});

// DELETE purchase
router.delete('/:id', (req, res) => {
  const purchaseId = req.params.id;
  logger.debug('Purchase delete start', { purchaseId });

  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId);
  if (!purchase) {
    return res.status(404).json({ error: 'Không tìm thấy đơn nhập' });
  }

  try {
    const items = db.prepare('SELECT product_id, quantity FROM purchase_items WHERE purchase_id = ?').all(purchaseId);

    let totalKegs = 0;
    for (const item of items) {
      const product = db.prepare('SELECT type FROM products WHERE id = ?').get(item.product_id);
      const productType = (product?.type || 'keg').toLowerCase();
      if (['keg', 'box'].includes(productType)) {
        totalKegs += item.quantity;
      }
    }

    for (const item of items) {
      const currentStock = db.prepare('SELECT stock FROM products WHERE id = ?').get(item.product_id);
      const newStock = Math.max(0, currentStock.stock - item.quantity);
      db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, item.product_id);
    }

    db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(purchaseId);
    db.prepare('DELETE FROM purchases WHERE id = ?').run(purchaseId);

    if (totalKegs > 0) {
      const statsRow = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
      if (statsRow) {
        const newEmpty = statsRow.empty_collected + totalKegs;
        db.prepare('UPDATE keg_stats SET empty_collected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(newEmpty);
      }
    }

    try {
      syncKegInventory();
    } catch (syncErr) {
      logger.error('Purchase delete: syncKegInventory error', { error: syncErr.message });
    }

    logger.info('Purchase deleted', { purchaseId, totalKegs });
    res.json({ success: true });
  } catch (err) {
    logger.error('Purchase delete error', { purchaseId, error: err.message });
    res.status(500).json({ error: 'Lỗi xóa đơn nhập' });
  }
});

module.exports = router;
