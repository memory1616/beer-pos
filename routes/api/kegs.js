const express = require('express');
const router = express.Router();
const db = require('../../database');

// ========== KEG STATE: SINGLE SOURCE OF TRUTH ==========
// inventory  -> SUM(products.stock) WHERE type = 'keg'
// empty      -> keg_stats.empty_collected (manual input)
// customer   -> SUM(customers.keg_balance)
// total      -> computed

/**
 * Get REAL-time keg state from source tables
 * This is the ONLY source of truth for keg counts
 */
function getKegState() {
  // Get inventory from products (source of truth)
  const inventoryResult = db.prepare(
    "SELECT COALESCE(SUM(stock), 0) as total FROM products WHERE type = 'keg'"
  ).get();
  
  // Get customer holding from customers (source of truth)
  const customerResult = db.prepare(
    "SELECT COALESCE(SUM(keg_balance), 0) as total FROM customers"
  ).get();
  
  // Get empty collected (manual, stored value)
  const stats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
  const emptyCollected = stats?.empty_collected || 0;
  
  const inventory = inventoryResult.total;
  const customerHolding = customerResult.total;
  
  return {
    inventory,
    emptyCollected,
    customerHolding,
    total: inventory + emptyCollected + customerHolding
  };
}

/**
 * Sync keg_stats.empty_collected (only value we store)
 * Call this when user manually adjusts empty kegs
 */
function updateEmptyCollected(newValue) {
  const safeValue = Math.max(0, Math.floor(newValue || 0));
  db.prepare('UPDATE keg_stats SET empty_collected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(safeValue);
  return safeValue;
}

/**
 * Get actual inventory from products (for validation)
 */
function getActualInventory() {
  const result = db.prepare(
    "SELECT COALESCE(SUM(stock), 0) as total FROM products WHERE type = 'keg'"
  ).get();
  return result.total;
}

// ========== API ENDPOINTS ==========

// GET /api/kegs/state - Get real-time keg state
router.get('/state', (req, res) => {
  try {
    const state = getKegState();
    res.json(state);
  } catch (err) {
    console.error('Get keg state error:', err);
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// POST /api/kegs/state - Update keg state
// Only allow updating emptyCollected (inventory comes from products, customer from customers)
router.post('/state', (req, res) => {
  const { emptyCollected, inventory } = req.body;
  
  try {
    // Update empty_collected if provided
    if (emptyCollected !== undefined) {
      updateEmptyCollected(emptyCollected);
    }
    
    // If inventory is manually set, update products.stock
    // This is a special case for adjusting inventory
    if (inventory !== undefined && inventory >= 0) {
      const currentInventory = getActualInventory();
      const diff = inventory - currentInventory;
      
      if (diff !== 0) {
        // Get first keg product to adjust
        const kegProduct = db.prepare(
          "SELECT id, stock FROM products WHERE type = 'keg' LIMIT 1"
        ).get();
        
        if (kegProduct) {
          const newStock = Math.max(0, kegProduct.stock + diff);
          db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, kegProduct.id);
        }
      }
    }
    
    const state = getKegState();
    res.json({
      success: true,
      message: 'Đã cập nhật trạng thái vỏ',
      state
    });
  } catch (err) {
    console.error('Update keg state error:', err);
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// GET /api/kegs/sync - Force sync all keg data
router.get('/sync', (req, res) => {
  try {
    const beforeState = getKegState();
    
    // Verify and fix keg_stats.empty_collected
    const stats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
    if (!stats) {
      db.prepare('INSERT INTO keg_stats (id, inventory, empty_collected, customer_holding) VALUES (1, 0, 0, 0)').run();
    }
    
    const afterState = getKegState();
    
    res.json({
      success: true,
      message: 'Đã đồng bộ dữ liệu vỏ',
      before: beforeState,
      after: afterState,
      sources: {
        inventoryFrom: 'products.stock WHERE type=keg',
        emptyFrom: 'keg_stats.empty_collected',
        customerFrom: 'SUM(customers.keg_balance)'
      }
    });
  } catch (err) {
    console.error('Sync keg error:', err);
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// ========== CORE KEG FUNCTIONS ==========

// 1. DELIVER KEGS - Giao bia cho khách
router.post('/deliver', (req, res) => {
  const { customerId, quantity, note } = req.body;
  
  if (!quantity || quantity < 1) {
    return res.status(400).json({ error: 'Số lượng phải lớn hơn 0' });
  }
  
  try {
    const state = getKegState();
    
    // Check if enough inventory
    if (state.inventory < quantity) {
      return res.status(400).json({
        error: `Không đủ vỏ trong kho. Hiện có: ${state.inventory} vỏ`
      });
    }
    
    // Get keg product
    const kegProduct = db.prepare(
      "SELECT id, stock FROM products WHERE type = 'keg' LIMIT 1"
    ).get();
    
    if (!kegProduct) {
      return res.status(400).json({ error: 'Không tìm thấy sản phẩm vỏ' });
    }
    
    // Use transaction
    const deliver = db.transaction(() => {
      // Update product stock
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?')
        .run(quantity, kegProduct.id);
      
      // Update customer keg balance
      if (customerId) {
        const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(customerId);
        const newBalance = (customer?.keg_balance || 0) + quantity;
        db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(newBalance, customerId);
        
        // Log transaction
        db.prepare(
          'INSERT INTO keg_transactions (customer_id, type, quantity, note) VALUES (?, ?, ?, ?)'
        ).run(customerId, 'delivery', quantity, note || 'Giao vỏ');
      }
    });
    
    deliver();
    
    const newState = getKegState();
    
    // Log to history
    db.prepare(`
      INSERT INTO keg_transactions_log (type, quantity, inventory_after, empty_after, holding_after, note)
      VALUES ('deliver', ?, ?, ?, ?, ?)
    `).run(quantity, newState.inventory, newState.emptyCollected, newState.customerHolding, note || null);
    
    res.json({
      success: true,
      message: `Đã giao ${quantity} vỏ cho khách`,
      state: newState
    });
  } catch (err) {
    console.error('Deliver keg error:', err);
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// 2. COLLECT EMPTY KEGS - Thu vỏ rỗng từ khách
router.post('/collect', (req, res) => {
  const { customerId, quantity, note } = req.body;
  
  if (!quantity || quantity < 1) {
    return res.status(400).json({ error: 'Số lượng phải lớn hơn 0' });
  }
  
  try {
    const state = getKegState();
    
    // Check if customer has enough kegs
    if (customerId) {
      const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(customerId);
      if ((customer?.keg_balance || 0) < quantity) {
        return res.status(400).json({
          error: `Khách không có đủ vỏ. Khách có: ${customer?.keg_balance || 0} vỏ`
        });
      }
    }
    
    // Use transaction
    const collect = db.transaction(() => {
      // Update customer keg balance
      if (customerId) {
        const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(customerId);
        const newBalance = Math.max(0, (customer?.keg_balance || 0) - quantity);
        db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(newBalance, customerId);
        
        // Log transaction
        db.prepare(
          'INSERT INTO keg_transactions (customer_id, type, quantity, note) VALUES (?, ?, ?, ?)'
        ).run(customerId, 'return', quantity, note || 'Thu vỏ rỗng');
      }
      
      // Update empty collected
      updateEmptyCollected(state.emptyCollected + quantity);
    });
    
    collect();
    
    const newState = getKegState();
    
    // Log to history
    db.prepare(`
      INSERT INTO keg_transactions_log (type, quantity, inventory_after, empty_after, holding_after, note)
      VALUES ('collect', ?, ?, ?, ?, ?)
    `).run(quantity, newState.inventory, newState.emptyCollected, newState.customerHolding, note || null);
    
    res.json({
      success: true,
      message: `Đã thu ${quantity} vỏ rỗng`,
      state: newState
    });
  } catch (err) {
    console.error('Collect keg error:', err);
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// 3. IMPORT KEGS - Nhập vỏ từ nhà máy
router.post('/import', (req, res) => {
  const { exchanged = 0, purchased = 0, note } = req.body;
  
  const totalImported = exchanged + purchased;
  
  if (totalImported < 1) {
    return res.status(400).json({ error: 'Phải nhập ít nhất 1 vỏ' });
  }
  
  try {
    const state = getKegState();
    
    // Check if enough empty kegs to exchange
    if (exchanged > 0 && state.emptyCollected < exchanged) {
      return res.status(400).json({
        error: `Không đủ vỏ rỗng để đổi. Có: ${state.emptyCollected} vỏ`
      });
    }
    
    // Get keg product
    const kegProduct = db.prepare(
      "SELECT id, stock FROM products WHERE type = 'keg' LIMIT 1"
    ).get();
    
    if (!kegProduct) {
      return res.status(400).json({ error: 'Không tìm thấy sản phẩm vỏ' });
    }
    
    // Use transaction
    const importKegs = db.transaction(() => {
      // Update empty collected
      updateEmptyCollected(state.emptyCollected - exchanged);
      
      // Update product stock
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?')
        .run(totalImported, kegProduct.id);
    });
    
    importKegs();
    
    const newState = getKegState();
    
    // Log to history
    db.prepare(`
      INSERT INTO keg_transactions_log (type, quantity, exchanged, purchased, inventory_after, empty_after, holding_after, note)
      VALUES ('import', ?, ?, ?, ?, ?, ?, ?)
    `).run(totalImported, exchanged, purchased, newState.inventory, newState.emptyCollected, newState.customerHolding, note || null);
    
    res.json({
      success: true,
      message: `Đã nhập ${totalImported} vỏ (đổi: ${exchanged}, mua mới: ${purchased})`,
      state: newState
    });
  } catch (err) {
    console.error('Import keg error:', err);
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// 4. SELL EMPTY KEGS - Bán vỏ rỗng (optional)
router.post('/sell-empty', (req, res) => {
  const { quantity, note } = req.body;
  
  if (!quantity || quantity < 1) {
    return res.status(400).json({ error: 'Số lượng phải lớn hơn 0' });
  }
  
  try {
    const state = getKegState();
    
    if (state.emptyCollected < quantity) {
      return res.status(400).json({
        error: `Không đủ vỏ rỗng. Có: ${state.emptyCollected} vỏ`
      });
    }
    
    // Use transaction
    const sellEmpty = db.transaction(() => {
      updateEmptyCollected(state.emptyCollected - quantity);
    });
    
    sellEmpty();
    
    const newState = getKegState();
    
    // Log to history
    db.prepare(`
      INSERT INTO keg_transactions_log (type, quantity, inventory_after, empty_after, holding_after, note)
      VALUES ('sell_empty', ?, ?, ?, ?, ?)
    `).run(quantity, newState.inventory, newState.emptyCollected, newState.customerHolding, note || null);
    
    res.json({
      success: true,
      message: `Đã bán ${quantity} vỏ rỗng`,
      state: newState
    });
  } catch (err) {
    console.error('Sell empty keg error:', err);
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// ========== LEGACY SUPPORT ==========

// POST /api/kegs - Legacy endpoint
router.post('/', (req, res) => {
  const { customerId, quantity, note } = req.body;
  if (!customerId || !quantity || quantity < 1) {
    return res.status(400).json({ error: 'Invalid data' });
  }
  // Redirect to collect
  req.body.note = note || 'Thu vỏ';
  return router.stack.find(r => r.path === '/collect' && r.methods?.post)?.handle(req, res);
});

// GET /api/kegs/stats - Legacy endpoint
router.get('/stats', (req, res) => {
  const state = getKegState();
  res.json(state);
});

// GET /api/kegs/history - Transaction history
router.get('/history', (req, res) => {
  const history = db.prepare(`
    SELECT k.*, c.name as customer_name
    FROM keg_transactions k
    LEFT JOIN customers c ON c.id = k.customer_id
    ORDER BY k.date DESC
    LIMIT 100
  `).all();
  res.json(history);
});

module.exports = router;
