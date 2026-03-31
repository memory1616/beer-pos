const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');
const { syncKegInventory } = require('./products');

// ========== KEG STATE: SINGLE SOURCE OF TRUTH ==========
// inventory  -> SUM(stock>0) keg (hiển thị ô Kho)
// total      -> SUM(stock) keg + empty + customer (đại số kho, có âm)
// empty      -> keg_stats.empty_collected
// customer   -> SUM(customers.keg_balance)

/**
 * Get REAL-time keg state from source tables
 * This is the ONLY source of truth for keg counts
 */
function getKegState() {
  const inventoryPositive = db.prepare(db.SQL_KEG_WAREHOUSE_POSITIVE_STOCK).get();
  const inventoryRaw = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get();
  const customerResult = db.prepare(
    "SELECT COALESCE(SUM(keg_balance), 0) as total FROM customers"
  ).get();
  const stats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
  const emptyCollected = stats?.empty_collected || 0;
  const customerHolding = customerResult.total;
  const inventory = inventoryPositive.total;
  return {
    inventory,
    emptyCollected,
    customerHolding,
    total: inventoryRaw.total + emptyCollected + customerHolding
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
  const result = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get();
  return result.total;
}

// ========== API ENDPOINTS ==========

// GET /api/kegs/state - Get real-time keg state
router.get('/state', (req, res) => {
  try {
    const state = getKegState();
    res.json(state);
  } catch (err) {
    logger.error('Get keg state error', { error: err.message });
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// POST /api/kegs/state - Update keg state
// Only allow updating emptyCollected (inventory comes from products, customer from customers)
router.post('/state', (req, res) => {
  const { emptyCollected, inventory, note } = req.body;

  try {
    const beforeState = getKegState();
    let didAdjust = false;

    // Update empty_collected if provided
    if (emptyCollected !== undefined) {
      updateEmptyCollected(emptyCollected);
      didAdjust = true;
    }

    // If inventory is manually set, update products.stock
    if (inventory !== undefined && inventory >= 0) {
      const currentInventory = getActualInventory();
      const diff = inventory - currentInventory;

      if (diff !== 0) {
        const kegProduct = db.prepare(
          "SELECT id, stock FROM products WHERE type = 'keg' LIMIT 1"
        ).get();

        if (kegProduct) {
          const newStock = Math.max(0, kegProduct.stock + diff);
          db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, kegProduct.id);
        }
      }
    }

    const newState = getKegState();

    // Log adjust transaction
    if (didAdjust) {
      logKegTransaction('adjust', newState.emptyCollected, newState, { note });
    }

    res.json({
      success: true,
      message: 'Đã cập nhật trạng thái vỏ',
      state: newState
    });
  } catch (err) {
    logger.error('Update keg state error', { error: err.message });
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
    logger.error('Sync keg error', { error: err.message });
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

/**
 * Log a keg transaction to the history log (keg_transactions_log)
 */
function logKegTransaction(type, quantity, state, opts = {}) {
  const { exchanged = 0, purchased = 0, customerId = null, customerName = null, note = null } = opts;
  db.prepare(`
    INSERT INTO keg_transactions_log
      (type, quantity, exchanged, purchased, customer_id, customer_name, inventory_after, empty_after, holding_after, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(type, quantity, exchanged, purchased, customerId, customerName,
         state.inventory, state.emptyCollected, state.customerHolding, note);
}

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
    
    const customer = customerId
      ? db.prepare('SELECT id, name, keg_balance FROM customers WHERE id = ?').get(customerId)
      : null;

    const deliver = db.transaction(() => {
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?')
        .run(quantity, kegProduct.id);

      if (customerId && customer) {
        const newBalance = (customer.keg_balance || 0) + quantity;
        db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(newBalance, customerId);
        // (logKegTransaction already called below after transaction)
      }

      // Sync inventory vì products.stock vừa thay đổi
      syncKegInventory();
    });

    deliver();

    const newState = getKegState();
    logKegTransaction('deliver', quantity, newState, {
      customerId, customerName: customer?.name, note
    });

    res.json({
      success: true,
      message: `Đã giao ${quantity} vỏ cho khách`,
      state: newState
    });
  } catch (err) {
    logger.error('Deliver keg error', { error: err.message });
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
    
    const customer = customerId
      ? db.prepare('SELECT id, name, keg_balance FROM customers WHERE id = ?').get(customerId)
      : null;

    const collect = db.transaction(() => {
      if (customerId && customer) {
        const newBalance = Math.max(0, (customer.keg_balance || 0) - quantity);
        db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(newBalance, customerId);
        // (logKegTransaction already called below after transaction)
      }

      updateEmptyCollected(state.emptyCollected + quantity);
    });

    collect();

    const newState = getKegState();
    logKegTransaction('collect', quantity, newState, {
      customerId, customerName: customer?.name, note
    });

    res.json({
      success: true,
      message: `Đã thu ${quantity} vỏ rỗng`,
      state: newState
    });
  } catch (err) {
    logger.error('Collect keg error', { error: err.message });
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
    
    // Calculate actual used from empty kegs (never negative)
    const usedFromEmpty = Math.min(state.emptyCollected, exchanged);
    const newEmptyCollected = Math.max(0, state.emptyCollected - usedFromEmpty);
    
    // Get keg product
    const kegProduct = db.prepare(
      "SELECT id, stock FROM products WHERE type = 'keg' LIMIT 1"
    ).get();
    
    if (!kegProduct) {
      return res.status(400).json({ error: 'Không tìm thấy sản phẩm vỏ' });
    }
    
    const importKegs = db.transaction(() => {
      updateEmptyCollected(newEmptyCollected);
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?')
        .run(totalImported, kegProduct.id);
      syncKegInventory();
    });

    importKegs();

    const newState = getKegState();
    logKegTransaction('import', totalImported, newState, {
      exchanged: usedFromEmpty, purchased, note
    });

    res.json({
      success: true,
      message: `Đã nhập ${totalImported} vỏ (đổi: ${usedFromEmpty}, mua mới: ${purchased})`,
      state: newState
    });
  } catch (err) {
    logger.error('Import keg error', { error: err.message });
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// 4. SELL EMPTY KEGS - Bán vỏ rỗng (bán đi, ra khỏi hệ thống)
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

    const sellEmpty = db.transaction(() => {
      updateEmptyCollected(state.emptyCollected - quantity);
      // Sync inventory để dashboard hiển thị đúng (inventory luôn = products.stock)
      syncKegInventory();
    });

    sellEmpty();

    const newState = getKegState();
    logKegTransaction('sell_empty', quantity, newState, { note });

    res.json({
      success: true,
      message: `Đã bán ${quantity} vỏ rỗng`,
      state: newState
    });
  } catch (err) {
    logger.error('Sell empty keg error', { error: err.message });
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

// GET /api/kegs/history - Transaction history from log table
router.get('/history', (req, res) => {
  const { type, customer_id, from, to, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    let where = [];
    let params = [];

    if (type) { where.push('type = ?'); params.push(type); }
    if (customer_id) { where.push('customer_id = ?'); params.push(parseInt(customer_id)); }
    if (from) { where.push('date >= ?'); params.push(from); }
    if (to) { where.push('date <= ?'); params.push(to); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const history = db.prepare(`
      SELECT * FROM keg_transactions_log
      ${whereClause}
      ORDER BY date DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    const countRow = db.prepare(`
      SELECT COUNT(*) as total FROM keg_transactions_log ${whereClause}
    `).get(...params);

    res.json({
      data: history,
      total: countRow.total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(countRow.total / parseInt(limit))
    });
  } catch (err) {
    logger.error('Get keg history error', { error: err.message });
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// GET /api/kegs/history-summary - Daily/weekly/monthly summary
router.get('/history-summary', (req, res) => {
  const { period = 'week' } = req.query; // day | week | month

  try {
    let dateGroup, dateFormat;
    if (period === 'day') {
      dateGroup = "strftime('%Y-%m-%d', date)";
      dateFormat = '%Y-%m-%d';
    } else if (period === 'month') {
      dateGroup = "strftime('%Y-%m', date)";
      dateFormat = '%Y-%m';
    } else {
      dateGroup = "strftime('%Y-W%W', date)";
      dateFormat = '%Y-W%W';
    }

    const summary = db.prepare(`
      SELECT
        ${dateGroup} as period,
        type,
        SUM(quantity) as total_quantity,
        COUNT(*) as tx_count,
        SUM(CASE WHEN type = 'deliver' THEN quantity ELSE 0 END) as delivered,
        SUM(CASE WHEN type = 'collect' THEN quantity ELSE 0 END) as collected,
        SUM(CASE WHEN type = 'import' THEN quantity ELSE 0 END) as imported,
        SUM(CASE WHEN type = 'adjust' THEN quantity ELSE 0 END) as adjusted
      FROM keg_transactions_log
      GROUP BY ${dateGroup}, type
      ORDER BY period DESC
      LIMIT 30
    `).all();

    res.json({ data: summary, period });
  } catch (err) {
    logger.error('Get keg summary error', { error: err.message });
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

module.exports = router;
