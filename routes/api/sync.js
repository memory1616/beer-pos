const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');
const { deleteSaleRestoringInventory } = require('../../src/services/saleDelete');
const { isValidId, isPositiveNumber, sanitizeString } = require('../../middleware/validation');

// ========== DEDUP CACHE ==========
const _processedIds = new Map();
const CACHE_TTL = 60000;

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of _processedIds) {
    if (now - timestamp > CACHE_TTL) {
      _processedIds.delete(key);
    }
  }
}, 30000);

// ========== HELPER: Slug utilities ==========
function toSlug(name) {
  if (!name) return '';
  return name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim().replace(/\s+/g, '_');
}

// Entity name → table name mapping
const ENTITY_TO_TABLE = {
  'customer': 'customers', 'product': 'products', 'sale': 'sales',
  'expense': 'expenses', 'payment': 'payments', 'keg_transaction': 'keg_transactions_log',
  'device': 'devices', 'price': 'prices', 'purchase': 'purchases',
  'purchase_item': 'purchase_items'
};

// ============ BATCH SYNC (PRIMARY) ============
// POST /api/sync/batch - Batch sync multiple items in one request
router.post('/batch', async (req, res) => {
  const { deviceId, items = [] } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.json({ success: true, results: [], summary: { total: 0, succeeded: 0, failed: 0, duplicates: 0 } });
  }

  // Limit batch size to prevent abuse
  if (items.length > 500) {
    return res.status(400).json({ success: false, error: 'Batch too large (max 500 items)' });
  }

  const results = [];
  let succeeded = 0;
  let failed = 0;
  let duplicates = 0;
  const startTime = Date.now();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const { syncId, entity, action, data, client_updated_at } = item;

    // Validate item structure
    if (!syncId || typeof syncId !== 'string') {
      results.push({ success: false, error: 'Invalid syncId' });
      failed++;
      continue;
    }
    if (!entity || !['customer', 'product', 'sale', 'expense', 'payment', 'keg_transaction'].includes(entity)) {
      results.push({ syncId, success: false, error: 'Invalid entity' });
      failed++;
      continue;
    }
    if (!action || !['create', 'update', 'delete'].includes(action)) {
      results.push({ syncId, success: false, error: 'Invalid action' });
      failed++;
      continue;
    }

    if (_processedIds.has(syncId)) {
      duplicates++;
      results.push({ syncId, success: true, duplicate: true });
      continue;
    }

    try {
      const tableName = ENTITY_TO_TABLE[entity] || (entity + 's');

      // Conflict check
      if (data?.id && client_updated_at) {
        const serverRow = db.prepare(`SELECT updated_at FROM ${tableName} WHERE id = ?`).get(data.id);
        if (serverRow?.updated_at && new Date(serverRow.updated_at) > new Date(client_updated_at)) {
          results.push({ syncId, success: false, conflict: true, reason: 'server_newer' });
          failed++;
          continue;
        }
      }

      switch (entity) {
        case 'sale': applySaleChange(action, data?.id, data); break;
        case 'customer': applyCustomerChange(action, data?.id, data); break;
        case 'product': applyProductChange(action, data?.id, data); break;
        case 'expense': applyExpenseChange(action, data?.id, data); break;
        case 'payment': applyPaymentChange(action, data?.id, data); break;
        case 'keg_transaction': applyKegTransactionChange(action, data?.id, data); break;
        default: break;
      }

      _processedIds.set(syncId, Date.now());
      results.push({ syncId, success: true });
      succeeded++;

    } catch (err) {
      logger.error(`[SYNC/BATCH] Error: ${entity}/${action}`, { syncId, error: err.message });
      results.push({ syncId, success: false, error: err.message });
      failed++;
    }
  }

  const elapsed = Date.now() - startTime;
  logger.info(`[SYNC/BATCH] ${items.length} items in ${elapsed}ms`, { succeeded, failed, duplicates });

  res.json({
    success: true,
    results,
    summary: { total: items.length, succeeded, failed, duplicates, elapsed }
  });
});

// ============ DELTA SYNC ============
// GET /api/sync/delta?since=timestamp - Get changes since timestamp
router.get('/delta', (req, res) => {
  const sinceTimestamp = parseInt(req.query.since) || 0;
  const since = new Date(sinceTimestamp).toISOString();

  try {
    const changes = {};

    // Orders since timestamp
    changes.orders = db.prepare(`
      SELECT s.id, s.uuid, s.customer_id, s.date, s.total, s.profit,
             s.deliver_kegs, s.return_kegs, s.type, s.status, s.note,
             s.created_at, s.updated_at, s.deleted,
             c.name as customer_name
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.id
      WHERE s.updated_at > datetime(?, 'unixepoch') OR s.created_at > datetime(?, 'unixepoch')
      ORDER BY s.updated_at DESC
      LIMIT 500
    `).all(sinceTimestamp / 1000, sinceTimestamp / 1000);

    // Customers since timestamp
    changes.customers = db.prepare(`
      SELECT id, uuid, name, phone, address, deposit, keg_balance, debt, lat, lng,
             horizontal_fridge, vertical_fridge, archived,
             created_at, updated_at, deleted
      FROM customers
      WHERE updated_at > datetime(?, 'unixepoch') OR created_at > datetime(?, 'unixepoch')
      ORDER BY updated_at DESC
      LIMIT 200
    `).all(sinceTimestamp / 1000, sinceTimestamp / 1000);

    // Products since timestamp
    changes.products = db.prepare(`
      SELECT id, slug, name, stock, damaged_stock, cost_price, sell_price, type,
             created_at, updated_at
      FROM products
      WHERE updated_at > datetime(?, 'unixepoch') OR created_at > datetime(?, 'unixepoch')
      ORDER BY updated_at DESC
      LIMIT 200
    `).all(sinceTimestamp / 1000, sinceTimestamp / 1000);

    // Expenses since timestamp
    changes.expenses = db.prepare(`
      SELECT id, uuid, category, type, amount, description, date, time, km,
             created_at, updated_at, deleted
      FROM expenses
      WHERE updated_at > datetime(?, 'unixepoch') OR created_at > datetime(?, 'unixepoch')
      ORDER BY updated_at DESC
      LIMIT 200
    `).all(sinceTimestamp / 1000, sinceTimestamp / 1000);

    res.json({
      success: true,
      changes,
      meta: {
        serverTime: Date.now(),
        since: sinceTimestamp,
        counts: {
          orders: changes.orders.length,
          customers: changes.customers.length,
          products: changes.products.length,
          expenses: changes.expenses.length,
        }
      }
    });
  } catch (err) {
    logger.error('[SYNC/DELTA] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ PUSH / PULL (Legacy) ============
// POST /api/sync/push - Push local changes to server
router.post('/push', (req, res) => {
  try {
    const { changes = [] } = req.body;
    let synced = 0;
    const conflicts = [];

    changes.forEach(change => {
      const { entity, entity_id, action, data, client_updated_at } = change;
      if (!entity || !action) return;

      const tableName = ENTITY_TO_TABLE[entity] || (entity + 's');
      if (entity_id && client_updated_at) {
        const serverRow = db.prepare(`SELECT updated_at FROM ${tableName} WHERE id = ?`).get(entity_id);
        if (serverRow && serverRow.updated_at && new Date(serverRow.updated_at) > new Date(client_updated_at)) {
          conflicts.push({ entity, entity_id, reason: 'server_newer' });
          return;
        }
      }

      switch (entity) {
        case 'sale': applySaleChange(action, entity_id, data); break;
        case 'customer': applyCustomerChange(action, entity_id, data); break;
        case 'product': applyProductChange(action, entity_id, data); break;
        case 'expense': applyExpenseChange(action, entity_id, data); break;
        case 'payment': applyPaymentChange(action, entity_id, data); break;
        case 'keg_transaction': applyKegTransactionChange(action, entity_id, data); break;
        default: break;
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
    const { lastSync = '1970-01-01T00:00:00.000Z' } = req.body;
    const tablesToQuery = new Set(Object.values(ENTITY_TO_TABLE));
    const changes = {};

    tablesToQuery.forEach(table => {
      try {
        const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all();
        const columnNames = tableInfo.map(col => col.name);
        const hasUpdatedAt = columnNames.includes('updated_at');
        const hasCreatedAt = columnNames.includes('created_at');

        if (!hasUpdatedAt && !hasCreatedAt) return;

        const rows = db.prepare(`
          SELECT * FROM ${table}
          WHERE (updated_at > ? AND updated_at IS NOT NULL) OR created_at > ?
          ORDER BY updated_at ASC
          LIMIT 1000
        `).all(lastSync, lastSync);

        if (rows.length > 0) changes[table] = rows;
      } catch (tableErr) {
        logger.warn(`Skipping sync for non-existent table: ${table}`);
      }
    });

    let pendingQueue = [];
    try {
      pendingQueue = db.prepare(`
        SELECT * FROM sync_queue WHERE synced = 0 ORDER BY created_at ASC LIMIT 100
      `).all();
    } catch (e) {
      logger.warn('sync_queue table not found, skipping');
    }

    res.json({ success: true, changes, pendingQueue, serverTime: new Date().toISOString(), lastSync });
  } catch (err) {
    logger.error('Sync pull error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sync/export - Lightweight export for local DB sync
router.get('/export', (req, res) => {
  try {
    const since = req.query.since || '1970-01-01T00:00:00.000Z';
    const result = {};
    const tablesToQuery = ['customers', 'products', 'sales'];

    tablesToQuery.forEach(table => {
      try {
        const rows = db.prepare(`
          SELECT * FROM ${table}
          WHERE (updated_at > ? AND updated_at IS NOT NULL) OR created_at > ?
          ORDER BY updated_at ASC
          LIMIT 2000
        `).all(since, since);

        if (rows.length > 0) result[table] = rows;
      } catch (tableErr) {}
    });

    res.json(result);
  } catch (err) {
    logger.error('Sync export error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sync/status - Check sync status
router.get('/status', (req, res) => {
  try {
    const pending = db.prepare('SELECT COUNT(*) as count FROM sync_queue WHERE synced = 0').get();
    const lastSyncMeta = db.prepare("SELECT value FROM sync_meta WHERE key = 'last_sync'").get();
    const syncedTotal = db.prepare('SELECT COUNT(*) as count FROM sync_queue WHERE synced = 1').get();

    res.json({
      pending: pending.count,
      lastSync: lastSyncMeta?.value || null,
      syncedTotal: syncedTotal.count,
      serverTime: new Date().toISOString(),
      version: '2.0',
      processedCache: _processedIds.size
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
    const result = db.prepare(`UPDATE sync_queue SET synced = 1 WHERE id IN (${placeholders})`).run(...ids);

    db.prepare(`INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_sync', ?)`).run(new Date().toISOString());

    res.json({ success: true, marked: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ APPLY CHANGE HELPERS ============

function applySaleChange(action, entity_id, data) {
  if (action === 'create' || action === 'update') {
    const exists = db.prepare('SELECT id FROM sales WHERE id = ?').get(entity_id);
    if (exists) {
      const { customer_id, date, total, profit, deliver_kegs, return_kegs, keg_balance_after, type, note, status } = data || {};
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
      const { customer_id, date, total, profit, deliver_kegs = 0, return_kegs = 0, keg_balance_after, type = 'sale', note = '', status = 'completed' } = data || {};
      db.prepare(`
        INSERT INTO sales (id, customer_id, date, total, profit, deliver_kegs, return_kegs, keg_balance_after, type, note, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(entity_id, customer_id, date, total, profit, deliver_kegs, return_kegs, keg_balance_after, type, note, status);
    }

    if (data?.items && Array.isArray(data.items)) {
      db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(entity_id);
      const insertItem = db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit, price_at_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      data.items.forEach(item => {
        insertItem.run(entity_id, item.product_id, item.product_slug, item.quantity, item.price, item.cost_price, item.profit, item.price || item.price_at_time);
      });
    }

    if (data?.customer_id && data.keg_balance_after !== undefined) {
      db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(data.keg_balance_after, data.customer_id);
    }
  } else if (action === 'delete') {
    const saleId = entity_id || data?.id;
    if (!saleId) return;
    const del = deleteSaleRestoringInventory(saleId);
    if (!del.ok && del.code === 'returned') {
      logger.warn('Sync delete sale: skipped (đơn đã trả hàng)', { saleId });
    }
  }
}

function applyCustomerChange(action, entity_id, data) {
  if (action === 'create' || action === 'update') {
    const exists = db.prepare('SELECT id FROM customers WHERE id = ?').get(entity_id);
    if (exists) {
      const { name, phone, deposit, keg_balance, debt, address, lat, lng, note, horizontal_fridge, vertical_fridge, archived } = data || {};
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
      const { name = 'Unknown', phone = '', deposit = 0, keg_balance = 0, debt = 0, address = '', lat, lng, note = '', horizontal_fridge = 0, vertical_fridge = 0, archived = 0 } = data || {};
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
      const { name, slug, stock, damaged_stock, cost_price, sell_price, type } = data || {};
      const finalSlug = slug || (name ? toSlug(name) : null);
      db.prepare(`
        UPDATE products SET
          slug = COALESCE(?, slug),
          name = COALESCE(?, name),
          stock = COALESCE(?, stock),
          damaged_stock = COALESCE(?, damaged_stock),
          cost_price = COALESCE(?, cost_price),
          sell_price = COALESCE(?, sell_price),
          type = COALESCE(?, type),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(finalSlug, name, stock, damaged_stock, cost_price, sell_price, type, entity_id);
      if (finalSlug) db.prepare('UPDATE prices SET product_slug = ? WHERE product_id = ?').run(finalSlug, entity_id);
    } else {
      const { name, slug, stock = 0, damaged_stock = 0, cost_price, sell_price, type = 'keg' } = data || {};
      const finalSlug = slug || (name ? toSlug(name) : null);
      db.prepare(`
        INSERT INTO products (id, slug, name, stock, damaged_stock, cost_price, sell_price, type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(entity_id, finalSlug, name, stock, damaged_stock, cost_price, sell_price, type);
    }
  } else if (action === 'delete') {
    db.prepare('DELETE FROM products WHERE id = ?').run(entity_id);
  }
}

function applyExpenseChange(action, entity_id, data) {
  if (action === 'create' || action === 'update') {
    const exists = db.prepare('SELECT id FROM expenses WHERE id = ?').get(entity_id);
    if (exists) {
      const { category, type, amount, description, date, time, km, order_id, is_auto } = data || {};
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
      const { category = 'other', type = '', amount, description = '', date, time, km, order_id, is_auto = 0 } = data || {};
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
      const { customer_id, amount, date, note } = data || {};
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
      const { customer_id, amount, date, note = '' } = data || {};
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
    const exists = db.prepare('SELECT id FROM keg_transactions_log WHERE id = ?').get(entity_id);
    if (exists) {
      const { customer_id, type, quantity, note, date } = data || {};
      db.prepare(`
        UPDATE keg_transactions_log SET
          customer_id = COALESCE(?, customer_id),
          type = COALESCE(?, type),
          quantity = COALESCE(?, quantity),
          note = COALESCE(?, note),
          date = COALESCE(?, date),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(customer_id, type, quantity, note, date, entity_id);
    } else {
      const { customer_id, type, quantity, note = '', date } = data || {};
      db.prepare(`
        INSERT INTO keg_transactions_log (id, customer_id, type, quantity, note, date)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(entity_id, customer_id, type, quantity, note, date);
    }
  } else if (action === 'delete') {
    db.prepare('DELETE FROM keg_transactions_log WHERE id = ?').run(entity_id);
  }
}

module.exports = router;
