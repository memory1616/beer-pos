const express = require('express');
const router = express.Router();
const db = require('../../database');
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
    
    console.log('[PURCHASE POST] ===== START =====');
    console.log('[PURCHASE POST] Items received:', JSON.stringify(items));
    
    for (const item of items) {
      const productId = parseInt(item.product_id);
      totalAmount += (parseInt(item.quantity) || 0) * (parseFloat(item.unit_price) || 0);
      
      // Lấy type của sản phẩm
      const product = db.prepare('SELECT id, name, type FROM products WHERE id = ?').get(productId);
      console.log('[PURCHASE POST] Product ID', productId, ':', product);
      
      if (product) {
        const productType = (product.type || 'keg').toLowerCase();
        if (['keg', 'can'].includes(productType)) {
          const qty = parseInt(item.quantity) || 0;
          totalKegs += qty;
          console.log('[PURCHASE POST] KEG/CAN found, added quantity:', qty);
        } else {
          console.log('[PURCHASE POST] PET product, skipped');
        }
      } else {
        console.log('[PURCHASE POST] Product not found for ID:', productId);
      }
    }
    console.log('[PURCHASE POST] Final totalKegs:', totalKegs);
    console.log('[PURCHASE POST] Final totalAmount:', totalAmount);
    
    // ========== BƯỚC 2: Tạo phiếu nhập ==========
    const purchaseResult = db.prepare('INSERT INTO purchases (total_amount, note) VALUES (?, ?)').run(totalAmount, note || null);
    const purchaseId = purchaseResult.lastInsertRowid;
    console.log('[PURCHASE POST] Created purchase ID:', purchaseId);
    
    // ========== BƯỚC 3: Thêm chi tiết và cập nhật tồn kho ==========
    for (const item of items) {
      const productId = parseInt(item.product_id);
      const qty = parseInt(item.quantity) || 0;
      const unitPrice = parseFloat(item.unit_price) || 0;
      const totalPrice = qty * unitPrice;
      
      db.prepare('INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?)').run(purchaseId, productId, qty, unitPrice, totalPrice);
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, productId);
    }
    console.log('[PURCHASE POST] Updated product stock');
    
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
    console.log('[PURCHASE POST] Empty before:', currentEmpty, '| totalKegs:', totalKegs, '| Empty after:', newEmpty);

    if (totalKegs > 0) {
      db.prepare(`
        INSERT INTO keg_transactions_log (type, quantity, inventory_after, empty_after, holding_after, note)
        VALUES ('import', ?, 0, ?, 0, ?)
      `).run(totalKegs, newEmpty, 'Nhập ' + totalKegs + ' vỏ từ nhà máy');
    }
    
    // ========== BƯỚC 5: Sync keg inventory ==========
    syncKegInventory();
    
    console.log('[PURCHASE POST] ===== END =====');
    res.json({ 
      id: purchaseId, 
      total_amount: totalAmount, 
      success: true,
      kegsImported: totalKegs,
      emptyBefore: currentEmpty,
      emptyAfter: newEmpty
    });
  } catch (err) {
    console.error('[PURCHASE POST] ERROR:', err);
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
    console.error(err);
    res.status(500).json({ error: 'Lỗi cập nhật đơn nhập' });
  }
});

// DELETE purchase
router.delete('/:id', (req, res) => {
  const purchaseId = req.params.id;
  console.log(`[DELETE PURCHASE] Starting delete for purchase ${purchaseId}`);
  
  // Kiểm tra đơn có tồn tại không
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId);
  if (!purchase) {
    console.log(`[DELETE PURCHASE] Purchase ${purchaseId} not found`);
    return res.status(404).json({ error: 'Không tìm thấy đơn nhập' });
  }
  console.log(`[DELETE PURCHASE] Found purchase:`, purchase);
  
  try {
    // Lấy thông tin đơn nhập trước khi xóa
    const items = db.prepare('SELECT product_id, quantity FROM purchase_items WHERE purchase_id = ?').all(purchaseId);
    console.log(`[DELETE PURCHASE] Found ${items.length} items to reverse`);
    
    // Tính số kegs trong đơn (chỉ keg và can, không tính pet)
    let totalKegs = 0;
    for (const item of items) {
      const product = db.prepare('SELECT type FROM products WHERE id = ?').get(item.product_id);
      const productType = (product?.type || 'keg').toLowerCase();
      if (['keg', 'can'].includes(productType)) {
        totalKegs += item.quantity;
      }
    }
    console.log(`[DELETE PURCHASE] Total kegs to restore: ${totalKegs}`);
    
    // Reverse stock (ensure stock doesn't go negative)
    for (const item of items) {
      const currentStock = db.prepare('SELECT stock FROM products WHERE id = ?').get(item.product_id);
      const newStock = Math.max(0, currentStock.stock - item.quantity);
      console.log(`[DELETE PURCHASE] Reversing stock for product ${item.product_id}: ${currentStock.stock} - ${item.quantity} = ${newStock}`);
      db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, item.product_id);
    }
    console.log(`[DELETE PURCHASE] Stock reversed for all items`);
    
    // Delete purchase items first (due to foreign key)
    db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(purchaseId);
    console.log(`[DELETE PURCHASE] Deleted purchase_items`);
    
    db.prepare('DELETE FROM purchases WHERE id = ?').run(purchaseId);
    console.log(`[DELETE PURCHASE] Deleted purchase record`);
    
    // Khôi phục empty_collected khi xóa đơn nhập (đảo ngược: nhập trừ → xóa cộng)
    if (totalKegs > 0) {
      const statsRow = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
      if (statsRow) {
        const newEmpty = statsRow.empty_collected + totalKegs;
        db.prepare('UPDATE keg_stats SET empty_collected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(newEmpty);
        console.log(`[DELETE PURCHASE] Restored empty_collected + ${totalKegs}, new value: ${newEmpty}`);
      }
    }
    
    // Sync keg inventory
    try {
      console.log(`[DELETE PURCHASE] Calling syncKegInventory...`);
      syncKegInventory();
      console.log(`[DELETE PURCHASE] syncKegInventory completed`);
    } catch (syncErr) {
      console.error('[DELETE PURCHASE] Sync keg inventory error:', syncErr);
    }
    
    console.log(`[DELETE PURCHASE] Delete completed successfully`);
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE PURCHASE] ERROR:', err);
    res.status(500).json({ error: 'Lỗi xóa đơn nhập', details: err.message, stack: err.stack });
  }
});

module.exports = router;
