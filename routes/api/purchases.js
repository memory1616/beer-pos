const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');
const { syncKegInventory } = require('./products');
const socketServer = require('../../src/socket/socketServer');

// ========== HELPER: Resolve product by id (numeric) or slug ==========
function resolveProduct(query) {
  if (!query) return null;
  const numId = parseInt(query);
  if (!isNaN(numId) && numId > 0) {
    return db.prepare('SELECT id, name, type FROM products WHERE id = ?').get(numId);
  }
  return db.prepare('SELECT id, name, type FROM products WHERE slug = ?').get(String(query));
}

// POST /api/purchases - Tạo phiếu nhập hàng mới
router.post('/', (req, res) => {
  const { items, note } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Danh sách sản phẩm trống' });
  }

  try {
    let totalAmount = 0;
    let totalKegs = 0;

    logger.debug('Purchase create', { itemsCount: items.length });

    // Resolve all products first (avoid N queries in loop)
    const resolvedItems = [];
    for (const item of items) {
      const product = resolveProduct(item.product_id || item.productSlug);
      if (!product) {
        return res.status(400).json({ error: 'Không tìm thấy sản phẩm: ' + (item.product_id || item.productSlug) });
      }
      const qty = parseInt(item.quantity) || 0;
      const unitPrice = parseFloat(item.unit_price) || 0;
      totalAmount += qty * unitPrice;

      const productType = (product.type || 'keg').toLowerCase();
      if (['keg', 'box'].includes(productType)) {
        totalKegs += qty;
      }
      resolvedItems.push({ ...item, resolvedProduct: product, qty, unitPrice });
    }
    logger.debug('Purchase totals', { totalKegs, totalAmount });

    // ========== BƯỚC 2: Tạo phiếu nhập ==========
    const purchaseResult = db.prepare('INSERT INTO purchases (total_amount, note) VALUES (?, ?)').run(totalAmount, note || null);
    const purchaseId = purchaseResult.lastInsertRowid;
    logger.debug('Purchase created', { purchaseId, totalAmount });

    // ========== BƯỚC 3: Thêm chi tiết và cập nhật tồn kho ==========
    for (const item of resolvedItems) {
      db.prepare('INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?)')
        .run(purchaseId, item.resolvedProduct.id, item.qty, item.unitPrice, item.qty * item.unitPrice);
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.qty, item.resolvedProduct.id);
    }
    logger.debug('Product stock updated');

    // ========== BƯỚC 4: Cập nhật vỏ rỗng ==========
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

    socketServer.emitInventoryUpdated({ purchaseId });
    socketServer.emitReportUpdated({ reason: 'purchase', purchaseId });

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
    SELECT pi.*, pr.name as product_name, pr.slug as product_slug
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
        const product = resolveProduct(item.product_id || item.productSlug);
        if (!product) {
          return res.status(400).json({ error: 'Không tìm thấy sản phẩm: ' + (item.product_id || item.productSlug) });
        }
        const quantity = parseInt(item.quantity) || 0;
        const unitPrice = parseFloat(item.unit_price) || 0;
        const totalPrice = quantity * unitPrice;
        totalAmount += totalPrice;

        db.prepare('INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?)')
          .run(req.params.id, product.id, quantity, unitPrice, totalPrice);

        // Update stock and cost_price
        if (quantity > 0) {
          db.prepare('UPDATE products SET stock = stock + ?, cost_price = ? WHERE id = ?').run(quantity, unitPrice, product.id);
        }
      }
    }

    // Sync keg inventory
    syncKegInventory();

    // Update purchase record
    db.prepare('UPDATE purchases SET total_amount = ?, note = ? WHERE id = ?').run(totalAmount, note || null, req.params.id);

    socketServer.emitInventoryUpdated({ purchaseId: req.params.id });

    res.json({ success: true });
  } catch (err) {
    logger.error('Purchase update error', { error: err.message });
    res.status(500).json({ error: 'Lỗi cập nhật đơn nhập' });
  }
});

// DELETE purchase (soft delete)
router.delete('/:id', (req, res) => {
  const purchaseId = req.params.id;
  logger.debug('Purchase soft delete start', { purchaseId });

  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId);
  if (!purchase) {
    return res.status(404).json({ error: 'Không tìm thấy đơn nhập' });
  }

  try {
    // Soft delete: set archived = 1 instead of hard delete
    db.prepare('UPDATE purchases SET archived = 1 WHERE id = ?').run(purchaseId);
    socketServer.emitInventoryUpdated({ purchaseId, archived: true });
    logger.info('Purchase soft deleted (archived)', { purchaseId });
    res.json({ success: true, message: 'Đã xóa đơn nhập (có thể khôi phục)', archived: true });
  } catch (err) {
    logger.error('Purchase soft delete error', { purchaseId, error: err.message });
    res.status(500).json({ error: 'Lỗi xóa đơn nhập' });
  }
});

// GET /api/purchases/archived - Get archived purchases
router.get('/archived/list', (req, res) => {
  try {
    const purchases = db.prepare(`
      SELECT p.*,
        (SELECT GROUP_CONCAT(pi.quantity || 'x ' || pr.name) FROM purchase_items pi JOIN products pr ON pi.product_id = pr.id WHERE pi.purchase_id = p.id) as items_summary
      FROM purchases p
      WHERE p.archived = 1
      ORDER BY p.date DESC
      LIMIT 100
    `).all();
    res.json(purchases);
  } catch (err) {
    logger.error('Error fetching archived purchases', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi lấy danh sách đơn nhập đã xóa' });
  }
});

// POST /api/purchases/:id/restore - Restore archived purchase
router.post('/:id/restore', (req, res) => {
  const purchaseId = req.params.id;
  logger.debug('Purchase restore start', { purchaseId });

  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ? AND archived = 1').get(purchaseId);
  if (!purchase) {
    return res.status(404).json({ error: 'Không tìm thấy đơn nhập đã xóa' });
  }

  try {
    // Restore archived purchase
    db.prepare('UPDATE purchases SET archived = 0 WHERE id = ?').run(purchaseId);
    socketServer.emitInventoryUpdated({ purchaseId, archived: false });
    logger.info('Purchase restored from archive', { purchaseId });
    res.json({ success: true, message: 'Đã khôi phục đơn nhập', archived: false });
  } catch (err) {
    logger.error('Purchase restore error', { purchaseId, error: err.message });
    res.status(500).json({ error: 'Lỗi khôi phục đơn nhập' });
  }
});

module.exports = router;
