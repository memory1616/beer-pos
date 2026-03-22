const express = require('express');
const router = express.Router();
const db = require('../../database');

// POST /api/purchases - Tạo phiếu nhập hàng mới
router.post('/', (req, res) => {
  const { items, note, deductKegs = 0 } = req.body;
  
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Danh sách sản phẩm trống' });
  }
  
  try {
    // Tính tổng tiền
    let totalAmount = 0;
    for (const item of items) {
      totalAmount += item.quantity * item.unit_price;
    }
    
    // Tạo phiếu nhập
    const purchaseResult = db.prepare('INSERT INTO purchases (total_amount, note) VALUES (?, ?)').run(totalAmount, note || null);
    const purchaseId = purchaseResult.lastInsertRowid;
    
    // Thêm chi tiết và cập nhật tồn kho
    for (const item of items) {
      const totalPrice = item.quantity * item.unit_price;
      db.prepare('INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?)').run(purchaseId, item.product_id, item.quantity, item.unit_price, totalPrice);
      
      // Cập nhật tồn kho sản phẩm
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
    }
    
    // Nếu có đặt hàng vỏ (dùng vỏ thu về để đặt), trừ kho vỏ
    let inventoryBalance = null;
    if (deductKegs && deductKegs > 0) {
      const balanceSetting = db.prepare("SELECT value FROM settings WHERE key = 'keg_inventory_balance'").get();
      const currentBalance = balanceSetting ? parseInt(balanceSetting.value) : 0;
      
      if (currentBalance >= deductKegs) {
        const newBalance = currentBalance - deductKegs;
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('keg_inventory_balance', ?)").run(newBalance.toString());
        
        // Ghi log kho vỏ
        db.prepare(`
          INSERT INTO keg_inventory (type, quantity, balance_after, source, note)
          VALUES ('outgoing', ?, ?, 'Đặt hàng nhà máy', ?)
        `).run(deductKegs, newBalance, note || 'Đặt hàng nhà máy');
        
        inventoryBalance = newBalance;
      }
    }
    
    res.json({ 
      id: purchaseId, 
      total_amount: totalAmount, 
      success: true,
      inventoryBalance
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lỗi tạo phiếu nhập' });
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
  const items = db.prepare('SELECT product_id, quantity FROM purchase_items WHERE purchase_id = ?').all(req.params.id);
  
  for (const item of items) {
    db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(item.quantity, item.product_id);
  }
  
  db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(req.params.id);
  db.prepare('DELETE FROM purchases WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
