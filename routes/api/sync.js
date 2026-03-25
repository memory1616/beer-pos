const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');

// ============ OFFLINE-FIRST SYNC ============
// Hệ thống đồng bộ đa thiết bị:
// - Khi offline: ghi vào sync_queue local
// - Khi online: push lên server chính
// - Conflict resolution: last-write-wins (dựa trên updated_at)

// Entity name → table name mapping
const ENTITY_TO_TABLE = {
  'customer': 'customers', 'product': 'products', 'sale': 'sales',
  'expense': 'expenses', 'payment': 'payments', 'keg_transaction': 'keg_transactions',
  'keg_ledger': 'keg_ledger',
  'device': 'devices', 'price': 'prices', 'purchase': 'purchases',
  'purchase_item': 'purchase_items'
};

// POST /api/sync/push - Push local changes to server
router.post('/push', (req, res) => {
  try {
    const { changes = [] } = req.body;
    let synced = 0;
    const conflicts = [];

    changes.forEach(change => {
      const { entity, entity_id, action, data, client_updated_at } = change;
      if (!entity || !action) return;

      // Check for conflict - if server record is newer, skip
      const tableName = ENTITY_TO_TABLE[entity] || (entity + 's');
      if (entity_id && client_updated_at) {
        const serverRow = db.prepare(`SELECT updated_at FROM ${tableName} WHERE id = ?`).get(entity_id);
        if (serverRow && serverRow.updated_at && new Date(serverRow.updated_at) > new Date(client_updated_at)) {
          conflicts.push({ entity, entity_id, reason: 'server_newer' });
          return;
        }
      }

      // Apply change to local database
      switch (entity) {
        case 'sale':
          applySaleChange(action, entity_id, data);
          break;
        case 'customer':
          applyCustomerChange(action, entity_id, data);
          break;
        case 'product':
          applyProductChange(action, entity_id, data);
          break;
        case 'expense':
          applyExpenseChange(action, entity_id, data);
          break;
        case 'payment':
          applyPaymentChange(action, entity_id, data);
          break;
        case 'keg_transaction':
          applyKegTransactionChange(action, entity_id, data);
          break;
        case 'keg_ledger':
          applyKegLedgerChange(action, entity_id, data);
          break;
        default:
          // Generic handler for other entities
          break;
      }
      synced++;
    });

    res.json({ success: true, synced, conflicts, synced_at: new Date().toISOString() });
  } catch (err) {
    logger.error('Sync push error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/pull - Pull changes from server since last sync
router.post('/pull', (req, res) => {
  try {
    const { lastSync = '1970-01-01T00:00:00.000Z', deviceId } = req.body;

    // Get all changes since lastSync
    const tablesToQuery = new Set(Object.values(ENTITY_TO_TABLE));
    const changes = {};

    tablesToQuery.forEach(table => {
      try {
        // Check if table exists and has required columns before querying
        const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all();
        const columnNames = tableInfo.map(col => col.name);
        const hasUpdatedAt = columnNames.includes('updated_at');
        const hasCreatedAt = columnNames.includes('created_at');

        if (!hasUpdatedAt && !hasCreatedAt) return; // Skip tables without sync columns

        const rows = db.prepare(`
          SELECT * FROM ${table}
          WHERE (updated_at > ? AND updated_at IS NOT NULL) OR created_at > ?
          ORDER BY updated_at ASC
          LIMIT 1000
        `).all(lastSync, lastSync);

        if (rows.length > 0) {
          changes[table] = rows;
        }
      } catch (tableErr) {
        // Table doesn't exist, skip silently
        logger.warn(`Skipping sync for non-existent table: ${table}`);
      }
    });

    // Get pending changes from sync_queue for this device
    const pendingQueue = db.prepare(`
      SELECT * FROM sync_queue
      WHERE synced = 0
      ORDER BY created_at ASC
      LIMIT 100
    `).all();

    res.json({
      success: true,
      changes,
      pendingQueue,
      serverTime: new Date().toISOString(),
      lastSync
    });
  } catch (err) {
    logger.error('Sync pull error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sync/status - Check sync status
router.get('/status', (req, res) => {
  try {
    const pending = db.prepare('SELECT COUNT(*) as count FROM sync_queue WHERE synced = 0').get();

    // Get last sync time from meta
    const lastSyncMeta = db.prepare("SELECT value FROM sync_meta WHERE key = 'last_sync'").get();
    const lastSync = lastSyncMeta ? lastSyncMeta.value : null;

    // Get total synced count
    const syncedTotal = db.prepare('SELECT COUNT(*) as count FROM sync_queue WHERE synced = 1').get();

    res.json({
      pending: pending.count,
      lastSync,
      syncedTotal: syncedTotal.count,
      serverTime: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/mark - Mark items as synced
router.post('/mark', (req, res) => {
  try {
    const { ids = [] } = req.body;
    if (ids.length === 0) return res.json({ success: true });

    const placeholders = ids.map(() => '?').join(',');
    const result = db.prepare(`
      UPDATE sync_queue SET synced = 1 WHERE id IN (${placeholders})
    `).run(...ids);

    // Update last sync time
    db.prepare(`
      INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_sync', ?)
    `).run(new Date().toISOString());

    res.json({ success: true, marked: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ APPLY CHANGE HELPERS ============

function applySaleChange(action, entity_id, data) {
  if (action === 'create' || action === 'update') {
    // Check if exists
    const exists = db.prepare('SELECT id FROM sales WHERE id = ?').get(entity_id);
    if (exists) {
      // Update
      const { customer_id, date, total, profit, deliver_kegs, return_kegs, keg_balance_after, type, note, status } = data;
      db.prepare(`
        UPDATE sales SET
          customer_id = COALESCE(?, customer_id),
          date = COALESCE(?, date),
          total = COALESCE(?, total),
          profit = COALESCE(?, profit),
          deliver_kegs = COALESCE(?, deliver_kegs),
          return_kegs = COALESCE(?, return_kegs),
          keg_balance_after = COALESCE(?, keg_balance_after),
          type = COALESCE(?, type),
          note = COALESCE(?, note),
          status = COALESCE(?, status),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(customer_id, date, total, profit, deliver_kegs, return_kegs, keg_balance_after, type, note, status, entity_id);
    } else {
      // Insert
      const { customer_id, date, total, profit, deliver_kegs = 0, return_kegs = 0, keg_balance_after, type = 'normal', note = '', status = 'completed' } = data;
      db.prepare(`
        INSERT INTO sales (id, customer_id, date, total, profit, deliver_kegs, return_kegs, keg_balance_after, type, note, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(entity_id, customer_id, date, total, profit, deliver_kegs, return_kegs, keg_balance_after, type, note, status);
    }

    // Update sale items if provided
    if (data.items && Array.isArray(data.items)) {
      // Remove old items
      db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(entity_id);
      // Insert new items
      const insertItem = db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price, profit)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      data.items.forEach(item => {
        insertItem.run(entity_id, item.product_id, item.quantity, item.price, item.cost_price, item.profit);
      });
    }

    // Update customer keg balance if customer_id provided
    if (data.customer_id && data.keg_balance_after !== undefined) {
      db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(data.keg_balance_after, data.customer_id);
    }
  } else if (action === 'delete') {
    db.prepare('DELETE FROM sales WHERE id = ?').run(entity_id);
    db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(entity_id);
  }
}

function applyCustomerChange(action, entity_id, data) {
  if (action === 'create' || action === 'update') {
    const exists = db.prepare('SELECT id FROM customers WHERE id = ?').get(entity_id);
    if (exists) {
      const { name, phone, deposit, keg_balance, debt, address, lat, lng, note, horizontal_fridge, vertical_fridge, archived } = data;
      db.prepare(`
        UPDATE customers SET
          name = COALESCE(?, name),
          phone = COALESCE(?, phone),
          deposit = COALESCE(?, deposit),
          keg_balance = COALESCE(?, keg_balance),
          debt = COALESCE(?, debt),
          address = COALESCE(?, address),
          lat = COALESCE(?, lat),
          lng = COALESCE(?, lng),
          note = COALESCE(?, note),
          horizontal_fridge = COALESCE(?, horizontal_fridge),
          vertical_fridge = COALESCE(?, vertical_fridge),
          archived = COALESCE(?, archived),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(name, phone, deposit, keg_balance, debt, address, lat, lng, note, horizontal_fridge, vertical_fridge, archived, entity_id);
    } else {
      const { name = 'Unknown', phone = '', deposit = 0, keg_balance = 0, debt = 0, address = '', lat, lng, note = '', horizontal_fridge = 0, vertical_fridge = 0, archived = 0 } = data;
      db.prepare(`
        INSERT INTO customers (id, name, phone, deposit, keg_balance, debt, address, lat, lng, note, horizontal_fridge, vertical_fridge, archived)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(entity_id, name, phone, deposit, keg_balance, debt, address, lat, lng, note, horizontal_fridge, vertical_fridge, archived);
    }
  } else if (action === 'delete') {
    db.prepare('DELETE FROM customers WHERE id = ?').run(entity_id);
  }
}

function applyProductChange(action, entity_id, data) {
  if (action === 'create' || action === 'update') {
    const exists = db.prepare('SELECT id FROM products WHERE id = ?').get(entity_id);
    if (exists) {
      const { name, stock, damaged_stock, cost_price, sell_price, type } = data;
      db.prepare(`
        UPDATE products SET
          name = COALESCE(?, name),
          stock = COALESCE(?, stock),
          damaged_stock = COALESCE(?, damaged_stock),
          cost_price = COALESCE(?, cost_price),
          sell_price = COALESCE(?, sell_price),
          type = COALESCE(?, type),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(name, stock, damaged_stock, cost_price, sell_price, type, entity_id);
    } else {
      const { name, stock = 0, damaged_stock = 0, cost_price, sell_price, type = 'keg' } = data;
      db.prepare(`
        INSERT INTO products (id, name, stock, damaged_stock, cost_price, sell_price, type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(entity_id, name, stock, damaged_stock, cost_price, sell_price, type);
    }
  } else if (action === 'delete') {
    db.prepare('DELETE FROM products WHERE id = ?').run(entity_id);
  }
}

function applyExpenseChange(action, entity_id, data) {
  if (action === 'create' || action === 'update') {
    const exists = db.prepare('SELECT id FROM expenses WHERE id = ?').get(entity_id);
    if (exists) {
      const { category, type, amount, description, date, time, km, order_id, is_auto } = data;
      db.prepare(`
        UPDATE expenses SET
          category = COALESCE(?, category),
          type = COALESCE(?, type),
          amount = COALESCE(?, amount),
          description = COALESCE(?, description),
          date = COALESCE(?, date),
          time = COALESCE(?, time),
          km = COALESCE(?, km),
          order_id = COALESCE(?, order_id),
          is_auto = COALESCE(?, is_auto),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(category, type, amount, description, date, time, km, order_id, is_auto, entity_id);
    } else {
      const { category = 'other', type = '', amount, description = '', date, time, km, order_id, is_auto = 0 } = data;
      db.prepare(`
        INSERT INTO expenses (id, category, type, amount, description, date, time, km, order_id, is_auto)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(entity_id, category, type, amount, description, date, time, km, order_id, is_auto);
    }
  } else if (action === 'delete') {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(entity_id);
  }
}

function applyPaymentChange(action, entity_id, data) {
  if (action === 'create' || action === 'update') {
    const exists = db.prepare('SELECT id FROM payments WHERE id = ?').get(entity_id);
    if (exists) {
      const { customer_id, amount, date, note } = data;
      db.prepare(`
        UPDATE payments SET
          customer_id = COALESCE(?, customer_id),
          amount = COALESCE(?, amount),
          date = COALESCE(?, date),
          note = COALESCE(?, note),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(customer_id, amount, date, note, entity_id);
    } else {
      const { customer_id, amount, date, note = '' } = data;
      db.prepare(`
        INSERT INTO payments (id, customer_id, amount, date, note)
        VALUES (?, ?, ?, ?, ?)
      `).run(entity_id, customer_id, amount, date, note);
    }
  } else if (action === 'delete') {
    db.prepare('DELETE FROM payments WHERE id = ?').run(entity_id);
  }
}

function applyKegTransactionChange(action, entity_id, data) {
  if (action === 'create' || action === 'update') {
    const exists = db.prepare('SELECT id FROM keg_transactions WHERE id = ?').get(entity_id);
    if (exists) {
      const { customer_id, type, quantity, note, date } = data;
      db.prepare(`
        UPDATE keg_transactions SET
          customer_id = COALESCE(?, customer_id),
          type = COALESCE(?, type),
          quantity = COALESCE(?, quantity),
          note = COALESCE(?, note),
          date = COALESCE(?, date),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(customer_id, type, quantity, note, date, entity_id);
    } else {
      const { customer_id, type, quantity, note = '', date } = data;
      db.prepare(`
        INSERT INTO keg_transactions (id, customer_id, type, quantity, note, date)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(entity_id, customer_id, type, quantity, note, date);
    }
  } else if (action === 'delete') {
    db.prepare('DELETE FROM keg_transactions WHERE id = ?').run(entity_id);
  }
}

/**
 * Sync keg_ledger entries từ thiết bị khác.
 * Ledger entries là immutable (chỉ INSERT, không UPDATE/DELETE vì đã có balance snapshot).
 */
function applyKegLedgerChange(action, entity_id, data) {
  if (action === 'create') {
    // Kiểm tra đã tồn tại chưa (theo source_type + source_id)
    if (data.source_type && data.source_id) {
      const exists = db.prepare(
        'SELECT id FROM keg_ledger WHERE source_type = ? AND source_id = ? LIMIT 1'
      ).get(data.source_type, data.source_id);
      if (exists) return; // Đã có, bỏ qua
    }
    const {
      source_type, source_id = null, customer_id = null,
      quantity, pool_from, pool_to,
      balance_after_inventory, balance_after_empty, balance_after_customer,
      note = null, date = null
    } = data;
    db.prepare(`
      INSERT INTO keg_ledger
        (source_type, source_id, customer_id, quantity, pool_from, pool_to,
         balance_after_inventory, balance_after_empty, balance_after_customer, note, date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      source_type, source_id, customer_id,
      quantity, pool_from, pool_to,
      balance_after_inventory || 0, balance_after_empty || 0, balance_after_customer || 0,
      note, date
    );
    // Sync keg_stats sau khi nhận ledger entry
    const { syncKegStats } = require('../../src/keg/ledger');
    syncKegStats({
      inventory: balance_after_inventory || 0,
      empty:     balance_after_empty     || 0,
      customer:  balance_after_customer  || 0
    });
  }
  // NOTE: 'update' và 'delete' không áp dụng cho ledger vì entries là immutable
}

module.exports = router;
