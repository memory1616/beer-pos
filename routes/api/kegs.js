const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');

// Feature #13: Sử dụng modules mới thay vì import trực tiếp
const { kegLedgerEntry, getCurrentState, getLedgerEntries, ledgerEntryExists } = require('../../src/modules/keg');
const { syncKegInventory } = require('../../src/modules/inventory');

// Feature #14: WebSocket broadcasts
const { sendDashboardStats, sendKegState, notifyKegChange, notifyAlert } = require('../../src/services/websocket');

// Alias: getKegState() = getCurrentState() để tương thích ngược
function getKegState() {
  const s = getCurrentState();
  return {
    inventory:       s.inventory,
    emptyCollected:  s.empty,
    customerHolding: s.customer,
    total:           s.inventory + s.empty + s.customer
  };
}

// =====================================================================
// API: State
// =====================================================================

// GET /api/kegs/state
router.get('/state', (req, res) => {
  try {
    res.json(getKegState());
  } catch (err) {
    logger.error('Get keg state error', { error: err.message });
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// POST /api/kegs/state — chỉnh tay inventory / empty
router.post('/state', (req, res) => {
  const { emptyCollected, inventory, note } = req.body;

  try {
    const state = getCurrentState();

    // Chỉnh empty thủ công
    if (emptyCollected !== undefined && emptyCollected !== state.empty) {
      const delta = Math.abs(parseInt(emptyCollected) - state.empty);
      const direction = parseInt(emptyCollected) > state.empty ? 'empty' : 'factory';
      kegLedgerEntry({
        sourceType: 'adjust',
        quantity: delta,
        poolFrom:  direction === 'empty' ? 'factory' : 'empty',
        poolTo:    direction === 'empty' ? 'empty'   : 'factory',
        note: note || 'Chỉnh empty thủ công'
      });
    }

    // Chỉnh inventory thủ công
    if (inventory !== undefined && inventory >= 0) {
      const diff = parseInt(inventory) - state.inventory;
      if (diff !== 0) {
        kegLedgerEntry({
          sourceType: diff > 0 ? 'import' : 'sell_empty',
          quantity: Math.abs(diff),
          poolFrom:  diff > 0 ? 'factory' : 'inventory',
          poolTo:    diff > 0 ? 'inventory' : 'factory',
          note: note || 'Chỉnh inventory thủ công'
        });
      }
    }

    res.json({
      success: true,
      message: 'Đã cập nhật trạng thái vỏ',
      state: getKegState()
    });
  } catch (err) {
    logger.error('Update keg state error', { error: err.message });
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// GET /api/kegs/sync
router.get('/sync', (req, res) => {
  try {
    const before = getKegState();
    // Đảm bảo keg_stats tồn tại
    const stats = db.prepare('SELECT id FROM keg_stats WHERE id = 1').get();
    if (!stats) {
      db.prepare('INSERT INTO keg_stats (id, inventory, empty_collected, customer_holding) VALUES (1, 0, 0, 0)').run();
    }
    res.json({
      success: true,
      message: 'Đã đồng bộ dữ liệu vỏ',
      before,
      after: getKegState()
    });
  } catch (err) {
    logger.error('Sync keg error', { error: err.message });
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// =====================================================================
// 1. DELIVER — Giao bia cho khách: inventory → customer
// =====================================================================
router.post('/deliver', (req, res) => {
  const { customerId, quantity, note } = req.body;

  if (!quantity || parseInt(quantity) < 1) {
    return res.status(400).json({ error: 'Số lượng phải lớn hơn 0' });
  }

  try {
    const state = getCurrentState();
    const qty = parseInt(quantity);

    if (state.inventory < qty) {
      return res.status(400).json({
        error: `Không đủ vỏ trong kho. Hiện có: ${state.inventory} vỏ`
      });
    }

    const customer = customerId
      ? db.prepare('SELECT id, name, keg_balance FROM customers WHERE id = ?').get(parseInt(customerId))
      : null;

    db.transaction(() => {
      // 1) Ghi ledger: inventory → customer
      kegLedgerEntry({
        sourceType: 'delivery',
        sourceId:   null,
        customerId: customerId ? parseInt(customerId) : null,
        quantity:   qty,
        poolFrom:   'inventory',
        poolTo:     'customer',
        note:       note || 'Giao bia'
      });

      // 2) Cập nhật customer.keg_balance (vẫn giữ — nhiều code cũ phụ thuộc)
      if (customerId && customer) {
        const newBalance = (customer.keg_balance || 0) + qty;
        db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?')
          .run(newBalance, parseInt(customerId));

        db.prepare(
          'INSERT INTO keg_transactions (customer_id, type, quantity, note) VALUES (?, ?, ?, ?)'
        ).run(parseInt(customerId), 'delivery', qty, note || 'Giao vỏ');
      }
    })();

    // Feature #14: Broadcast WebSocket updates
    sendKegState();

    res.json({
      success: true,
      message: `Đã giao ${qty} vỏ cho khách`,
      state: getKegState()
    });
  } catch (err) {
    logger.error('Deliver keg error', { error: err.message });
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// =====================================================================
// 2. COLLECT — Thu vỏ rỗng từ khách: customer → empty
// =====================================================================
router.post('/collect', (req, res) => {
  const { customerId, quantity, note } = req.body;

  if (!quantity || parseInt(quantity) < 1) {
    return res.status(400).json({ error: 'Số lượng phải lớn hơn 0' });
  }

  try {
    const qty = parseInt(quantity);

    // Kiểm tra khách đủ vỏ
    if (customerId) {
      const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?')
        .get(parseInt(customerId));
      if ((customer?.keg_balance || 0) < qty) {
        return res.status(400).json({
          error: `Khách không có đủ vỏ. Khách có: ${customer?.keg_balance || 0} vỏ`
        });
      }
    }

    const customer = customerId
      ? db.prepare('SELECT id, name, keg_balance FROM customers WHERE id = ?').get(parseInt(customerId))
      : null;

    db.transaction(() => {
      // 1) Ghi ledger: customer → empty
      kegLedgerEntry({
        sourceType: 'collect',
        sourceId:   null,
        customerId: customerId ? parseInt(customerId) : null,
        quantity:   qty,
        poolFrom:   'customer',
        poolTo:     'empty',
        note:       note || 'Thu vỏ rỗng'
      });

      // 2) Cập nhật customer.keg_balance
      if (customerId && customer) {
        const newBalance = Math.max(0, (customer.keg_balance || 0) - qty);
        db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?')
          .run(newBalance, parseInt(customerId));

        db.prepare(
          'INSERT INTO keg_transactions (customer_id, type, quantity, note) VALUES (?, ?, ?, ?)'
        ).run(parseInt(customerId), 'return', qty, note || 'Thu vỏ rỗng');
      }
    })();

    // Feature #14: Broadcast WebSocket updates
    sendKegState();

    res.json({
      success: true,
      message: `Đã thu ${qty} vỏ rỗng`,
      state: getKegState()
    });
  } catch (err) {
    logger.error('Collect keg error', { error: err.message });
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// =====================================================================
// 3. IMPORT — Nhập vỏ từ nhà máy: empty→inventory (đổi) + factory→inventory (mua mới)
// =====================================================================
router.post('/import', (req, res) => {
  const { exchanged = 0, purchased = 0, note } = req.body;

  const totalImported = (parseInt(exchanged) || 0) + (parseInt(purchased) || 0);
  if (totalImported < 1) {
    return res.status(400).json({ error: 'Phải nhập ít nhất 1 vỏ' });
  }

  try {
    const exQty = parseInt(exchanged) || 0;
    const purQty = parseInt(purchased) || 0;

    db.transaction(() => {
      // Đổi vỏ rỗng lấy bia đầy: empty → inventory
      if (exQty > 0) {
        kegLedgerEntry({
          sourceType: 'import',
          quantity:   exQty,
          poolFrom:   'empty',
          poolTo:     'inventory',
          note:       note || 'Nhập hàng đổi vỏ'
        });
      }

      // Mua vỏ mới từ nhà máy: factory → inventory
      if (purQty > 0) {
        kegLedgerEntry({
          sourceType: 'import',
          quantity:   purQty,
          poolFrom:   'factory',
          poolTo:     'inventory',
          note:       note || 'Nhập hàng mua vỏ mới'
        });
      }

      // Cập nhật products.stock (vẫn giữ cho code cũ)
      const kegProduct = db.prepare("SELECT id FROM products WHERE type = 'keg' LIMIT 1").get();
      if (kegProduct) {
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?')
          .run(totalImported, kegProduct.id);
      }
      syncKegInventory();
    })();

    // Feature #14: Broadcast WebSocket updates
    sendKegState();

    res.json({
      success: true,
      message: `Đã nhập ${totalImported} vỏ (đổi: ${exQty}, mua mới: ${purQty})`,
      state: getKegState()
    });
  } catch (err) {
    logger.error('Import keg error', { error: err.message });
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// =====================================================================
// 4. SELL EMPTY — Bán vỏ rỗng: empty → factory (ra khỏi hệ thống)
// =====================================================================
router.post('/sell-empty', (req, res) => {
  const { quantity, note } = req.body;

  if (!quantity || parseInt(quantity) < 1) {
    return res.status(400).json({ error: 'Số lượng phải lớn hơn 0' });
  }

  try {
    const qty = parseInt(quantity);
    const state = getCurrentState();

    if (state.empty < qty) {
      return res.status(400).json({
        error: `Không đủ vỏ rỗng. Có: ${state.empty} vỏ`
      });
    }

    // Ghi ledger: empty → factory
    kegLedgerEntry({
      sourceType: 'sell_empty',
      quantity:   qty,
      poolFrom:   'empty',
      poolTo:     'factory',
      note:       note || 'Bán vỏ rỗng'
    });

    // Feature #14: Broadcast WebSocket updates
    sendKegState();

    res.json({
      success: true,
      message: `Đã bán ${qty} vỏ rỗng`,
      state: getKegState()
    });
  } catch (err) {
    logger.error('Sell empty keg error', { error: err.message });
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// =====================================================================
// API: Ledger history (trả dữ liệu từ bảng keg_ledger)
// =====================================================================

// GET /api/kegs/ledger — danh sách ledger entries
router.get('/ledger', (req, res) => {
  try {
    const { customer_id, from, to, source_type, page = 1, limit = 50 } = req.query;
    const result = getLedgerEntries({
      customerId:  customer_id ? parseInt(customer_id) : null,
      from,
      to,
      sourceType:  source_type || null,
      page:        parseInt(page),
      limit:       parseInt(limit)
    });
    res.json(result);
  } catch (err) {
    logger.error('Get ledger error', { error: err.message });
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

// =====================================================================
// Legacy support — giữ nguyên endpoint cũ để tương thích
// =====================================================================

router.post('/', (req, res) => {
  // Chuyển POST / sang /collect
  req.body.note = (req.body.note || 'Thu vỏ');
  return router.stack.find(r => r.path === '/collect' && r.methods?.post)?.handle(req, res);
});

router.get('/stats', (req, res) => {
  res.json(getKegState());
});

router.get('/history', (req, res) => {
  const { type, customer_id, from, to, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const conditions = [];
    const params = [];
    if (type)         { conditions.push('type = ?');            params.push(type); }
    if (customer_id)  { conditions.push('customer_id = ?');     params.push(parseInt(customer_id)); }
    if (from)        { conditions.push('date >= ?');           params.push(from); }
    if (to)          { conditions.push('date <= ?');           params.push(to); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const history = db.prepare(`
      SELECT * FROM keg_transactions_log ${where}
      ORDER BY date DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    const countRow = db.prepare(`
      SELECT COUNT(*) as total FROM keg_transactions_log ${where}
    `).get(...params);

    res.json({
      data:   history,
      total:  countRow.total,
      page:   parseInt(page),
      limit:  parseInt(limit),
      pages:  Math.ceil(countRow.total / parseInt(limit))
    });
  } catch (err) {
    logger.error('Get keg history error', { error: err.message });
    res.status(500).json({ error: 'Lỗi: ' + err.message });
  }
});

router.get('/history-summary', (req, res) => {
  const { period = 'week' } = req.query;

  try {
    let dateGroup;
    if (period === 'day') {
      dateGroup = "strftime('%Y-%m-%d', date)";
    } else if (period === 'month') {
      dateGroup = "strftime('%Y-%m', date)";
    } else {
      dateGroup = "strftime('%Y-W%W', date)";
    }

    const summary = db.prepare(`
      SELECT
        ${dateGroup} as period,
        type,
        SUM(quantity) as total_quantity,
        COUNT(*) as tx_count,
        SUM(CASE WHEN type = 'deliver'     THEN quantity ELSE 0 END) as delivered,
        SUM(CASE WHEN type = 'collect'     THEN quantity ELSE 0 END) as collected,
        SUM(CASE WHEN type = 'import'      THEN quantity ELSE 0 END) as imported,
        SUM(CASE WHEN type = 'adjust'      THEN quantity ELSE 0 END) as adjusted
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
