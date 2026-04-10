/**
 * BeerPOS - Sync V2 API (Optimized)
 * ─────────────────────────────────────────────────────────────────────────────
 * ✅ Batch sync - xử lý nhiều items 1 request
 * ✅ Deduplication - tránh xử lý trùng
 * ✅ Delta sync - chỉ trả về changes
 * ✅ Transaction grouping - batch operations
 * 
 * 📥 POST /api/sync-v2 - Single sync
 * 📥 POST /api/sync-v2/batch - Batch sync (QUAN TRỌNG)
 * 📤 GET /api/sync-v2/delta?since=timestamp - Delta changes
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');

// ── Cache for deduplication ──────────────────────────────────────────────────
const _processedSyncIds = new Map(); // syncId → timestamp
const CACHE_TTL = 60000; // 1 minute

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of _processedSyncIds) {
    if (now - timestamp > CACHE_TTL) {
      _processedSyncIds.delete(key);
    }
  }
}, 30000);

// ── Action Handlers ───────────────────────────────────────────────────────────

const ACTION_HANDLERS = {
  CREATE_ORDER: handleCreateOrder,
  UPDATE_ORDER: handleUpdateOrder,
  DELETE_ORDER: handleDeleteOrder,
  RETURN_ORDER: handleReturnOrder,
  UPDATE_PRODUCT: handleUpdateProduct,
  UPDATE_STOCK: handleUpdateStock,
  CREATE_CUSTOMER: handleCreateCustomer,
  UPDATE_CUSTOMER: handleUpdateCustomer,
  UPDATE_KEG_BALANCE: handleUpdateKegBalance,
  CREATE_EXPENSE: handleCreateExpense,
  UPDATE_EXPENSE: handleUpdateExpense,
  DELETE_EXPENSE: handleDeleteExpense,
  CREATE_PAYMENT: handleCreatePayment,
  DELIVER_KEG: handleDeliverKeg,
  COLLECT_KEG: handleCollectKeg,
};

// ── Batch Endpoint (PRIMARY) ──────────────────────────────────────────────────

router.post('/batch', async (req, res) => {
  const { deviceId, timestamp, items } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.json({
      success: true,
      results: [],
      summary: { total: 0, succeeded: 0, failed: 0, duplicates: 0 }
    });
  }

  const results = [];
  let succeeded = 0;
  let failed = 0;
  let duplicates = 0;
  const startTime = Date.now();

  // Process in order (respects priority from client)
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const { syncId, type, payload, priority } = item;

    // Check deduplication
    if (_processedSyncIds.has(syncId)) {
      duplicates++;
      results.push({
        syncId,
        success: true,
        duplicate: true,
      });
      continue;
    }

    try {
      const handler = ACTION_HANDLERS[type];
      if (!handler) {
        results.push({
          syncId,
          success: false,
          error: `Unknown action type: ${type}`,
        });
        failed++;
        continue;
      }

      // Execute handler
      const result = await handler(payload, {
        deviceId,
        syncId,
        priority,
        req,
      });

      // Mark as processed
      _processedSyncIds.set(syncId, Date.now());

      results.push({
        syncId,
        success: result.success,
        serverId: result.serverId,
        duplicate: result.duplicate,
        conflict: result.conflict,
        data: result.data,
        error: result.error,
      });

      if (result.success) succeeded++;
      else failed++;

    } catch (error) {
      logger.error(`[SYNC-V2] Batch handler error: ${type}`, {
        syncId,
        payload,
        error: error.message,
      });

      results.push({
        syncId,
        success: false,
        error: error.message,
      });
      failed++;
    }
  }

  const elapsed = Date.now() - startTime;

  logger.info(`[SYNC-V2] Batch processed: ${items.length} items in ${elapsed}ms`, {
    deviceId,
    succeeded,
    failed,
    duplicates,
  });

  res.json({
    success: true,
    results,
    summary: {
      total: items.length,
      succeeded,
      failed,
      duplicates,
      elapsed,
    },
  });
});

// ── Single Sync Endpoint ──────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { syncId, type, payload, deviceId, forceSync } = req.body;

  if (!type) {
    return res.status(400).json({
      success: false,
      error: 'Missing action type',
    });
  }

  if (!payload || !payload.id) {
    return res.status(400).json({
      success: false,
      error: 'Missing payload or id',
    });
  }

  // Check deduplication
  if (_processedSyncIds.has(syncId)) {
    return res.json({
      success: true,
      duplicate: true,
      syncId,
    });
  }

  const handler = ACTION_HANDLERS[type];
  if (!handler) {
    return res.status(400).json({
      success: false,
      error: `Unknown action type: ${type}`,
    });
  }

  try {
    const result = await handler(payload, {
      deviceId,
      syncId,
      forceSync,
      req,
    });

    // Mark as processed
    _processedSyncIds.set(syncId, Date.now());

    res.json({
      success: result.success,
      serverId: result.serverId,
      duplicate: result.duplicate,
      conflict: result.conflict,
      data: result.data,
      error: result.error,
    });

  } catch (error) {
    logger.error(`[SYNC-V2] Handler error: ${type}`, {
      syncId,
      payload,
      error: error.message,
    });

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ── Delta Sync Endpoint ───────────────────────────────────────────────────────

router.get('/delta', (req, res) => {
  const { since, deviceId } = req.query;
  const sinceTimestamp = parseInt(since) || 0;

  logger.info(`[SYNC-V2] Delta sync requested`, {
    deviceId,
    since: new Date(sinceTimestamp).toISOString(),
  });

  try {
    const changes = {};

    // Orders updated since timestamp
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

    // Customers updated since timestamp
    changes.customers = db.prepare(`
      SELECT id, uuid, name, phone, address, deposit, keg_balance, debt, lat, lng,
             created_at, updated_at, deleted
      FROM customers
      WHERE updated_at > datetime(?, 'unixepoch') OR created_at > datetime(?, 'unixepoch')
      ORDER BY updated_at DESC
      LIMIT 200
    `).all(sinceTimestamp / 1000, sinceTimestamp / 1000);

    // Products updated since timestamp
    changes.products = db.prepare(`
      SELECT id, slug, name, stock, cost_price, sell_price, type,
             created_at, updated_at
      FROM products
      WHERE updated_at > datetime(?, 'unixepoch') OR created_at > datetime(?, 'unixepoch')
      ORDER BY updated_at DESC
      LIMIT 200
    `).all(sinceTimestamp / 1000, sinceTimestamp / 1000);

    // Expenses updated since timestamp
    changes.expenses = db.prepare(`
      SELECT id, uuid, category, type, amount, description, date, time, km,
             created_at, updated_at, deleted
      FROM expenses
      WHERE updated_at > datetime(?, 'unixepoch') OR created_at > datetime(?, 'unixepoch')
      ORDER BY updated_at DESC
      LIMIT 200
    `).all(sinceTimestamp / 1000, sinceTimestamp / 1000);

    // Server timestamp
    const serverTime = Date.now();

    res.json({
      success: true,
      changes,
      meta: {
        serverTime,
        since: sinceTimestamp,
        counts: {
          orders: changes.orders.length,
          customers: changes.customers.length,
          products: changes.products.length,
          expenses: changes.expenses.length,
        },
      },
    });

  } catch (error) {
    logger.error('[SYNC-V2] Delta sync error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ── Status Endpoint ───────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  const deviceId = req.headers['x-device-id'];

  res.json({
    serverTime: new Date().toISOString(),
    deviceId,
    status: 'ok',
    version: '2.0',
  });
});

// ── ACTION HANDLERS ──────────────────────────────────────────────────────────

async function handleCreateOrder(payload, context) {
  const { id, customerId, items, total, profit, deliverKegs, returnKegs, note, type } = payload;

  // Check duplicate (idempotency)
  const existing = db.prepare('SELECT id FROM sales WHERE id = ?').get(id);
  if (existing) {
    return {
      success: true,
      serverId: existing.id,
      duplicate: true,
    };
  }

  const date = db.getVietnamDateStr();

  // Calculate keg quantity
  let kegQuantity = 0;
  if (items?.length > 0) {
    const productIds = items.map(i => i.productId).filter(Boolean);
    const products = productIds.length > 0
      ? db.prepare(`SELECT id, type FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`).all(...productIds)
      : [];
    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });

    for (const item of items) {
      const product = productMap[item.productId];
      if (product && product.type !== 'pet') {
        kegQuantity += item.quantity;
      }
    }
  }

  const finalDeliverKegs = deliverKegs || kegQuantity;

  // Insert order
  db.prepare(`
    INSERT INTO sales (id, uuid, customer_id, date, total, profit, deliver_kegs, return_kegs, 
                       keg_balance_after, type, note, status, version, created_at, updated_at, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)
  `).run(id, id, customerId || null, date, total || 0, profit || 0,
    finalDeliverKegs, returnKegs || 0, 0, type || 'sale', note || '');

  // Insert sale items + update stock
  if (items?.length > 0) {
    for (const item of items) {
      db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run(id, item.productId, item.productSlug || null, item.quantity, item.price, item.costPrice || 0, item.profit || 0);

      if (type !== 'replacement') {
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(item.quantity, item.productId);
      }
    }
  }

  // Update customer keg balance
  if (customerId && (finalDeliverKegs > 0 || returnKegs > 0)) {
    updateCustomerKegBalance(customerId, finalDeliverKegs, returnKegs);
  }

  return {
    success: true,
    serverId: id,
    data: { id, total, profit, date },
  };
}

async function handleUpdateOrder(payload, context) {
  const { id, total, profit, note } = payload;

  const existing = db.prepare('SELECT version FROM sales WHERE id = ?').get(id);
  if (!existing) {
    return { success: false, error: 'Order not found' };
  }

  if (!context.forceSync && payload.version && payload.version < existing.version) {
    return {
      success: false,
      conflict: true,
      serverData: existing,
      data: existing,
    };
  }

  db.prepare(`
    UPDATE sales SET total = ?, profit = ?, note = ?, updated_at = CURRENT_TIMESTAMP, version = version + 1
    WHERE id = ?
  `).run(total, profit, note || '', id);

  return { success: true, serverId: id };
}

async function handleDeleteOrder(payload, context) {
  const { id } = payload;

  db.prepare(`
    UPDATE sales SET deleted = 1, updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ?
  `).run(id);

  return { success: true, serverId: id };
}

async function handleReturnOrder(payload, context) {
  const { id } = payload;

  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  if (!sale) {
    return { success: false, error: 'Order not found' };
  }

  // Return stock
  const saleItems = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(id);
  for (const item of saleItems) {
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
  }

  db.prepare(`
    UPDATE sales SET status = 'returned', total = 0, profit = 0, 
    updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ?
  `).run(id);

  return { success: true, serverId: id };
}

async function handleUpdateProduct(payload, context) {
  const { id, name, costPrice, sellPrice } = payload;

  db.prepare(`
    UPDATE products SET name = ?, cost_price = ?, sell_price = ?,
    updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ?
  `).run(name, costPrice, sellPrice, id);

  return { success: true, serverId: id };
}

async function handleUpdateStock(payload, context) {
  const { productId, stock, delta } = payload;

  if (stock !== undefined) {
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(stock, productId);
  } else if (delta !== undefined) {
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(delta, productId);
  }

  return { success: true, serverId: productId };
}

async function handleCreateCustomer(payload, context) {
  const { id, name, phone, address, deposit, kegBalance } = payload;

  const existing = db.prepare('SELECT id FROM customers WHERE id = ?').get(id);
  if (existing) {
    return { success: true, serverId: existing.id, duplicate: true };
  }

  db.prepare(`
    INSERT INTO customers (id, uuid, name, phone, address, deposit, keg_balance, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(id, id, name, phone || '', address || '', deposit || 0, kegBalance || 0);

  return { success: true, serverId: id };
}

async function handleUpdateCustomer(payload, context) {
  const { id, ...updates } = payload;

  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && ['name', 'phone', 'address', 'deposit', 'keg_balance', 'lat', 'lng'].includes(key)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length > 0) {
    fields.push('updated_at = CURRENT_TIMESTAMP');
    fields.push('version = version + 1');
    values.push(id);
    db.prepare(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  return { success: true, serverId: id };
}

async function handleUpdateKegBalance(payload, context) {
  const { customerId, kegBalance, deliver, returned } = payload;

  if (kegBalance !== undefined) {
    db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(kegBalance, customerId);
  } else if (deliver !== undefined || returned !== undefined) {
    updateCustomerKegBalance(customerId, deliver || 0, returned || 0);
  }

  return { success: true, serverId: customerId };
}

async function handleCreateExpense(payload, context) {
  const { id, category, type, amount, description, date, km } = payload;

  const existing = db.prepare('SELECT id FROM expenses WHERE id = ?').get(id);
  if (existing) {
    return { success: true, serverId: existing.id, duplicate: true };
  }

  db.prepare(`
    INSERT INTO expenses (id, uuid, category, type, amount, description, date, time, km, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    id, id, category, type || 'other', amount,
    description || '', date || db.getVietnamDateStr(),
    new Date().toTimeString().slice(0, 5), km || null
  );

  return { success: true, serverId: id };
}

async function handleUpdateExpense(payload, context) {
  const { id, category, type, amount, description } = payload;

  db.prepare(`
    UPDATE expenses SET category = ?, type = ?, amount = ?, description = ?,
    updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ?
  `).run(category, type, amount, description || '', id);

  return { success: true, serverId: id };
}

async function handleDeleteExpense(payload, context) {
  const { id } = payload;
  db.prepare('UPDATE expenses SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  return { success: true, serverId: id };
}

async function handleCreatePayment(payload, context) {
  const { id, customerId, amount, note } = payload;

  const existing = db.prepare('SELECT id FROM payments WHERE id = ?').get(id);
  if (existing) {
    return { success: true, serverId: existing.id, duplicate: true };
  }

  db.prepare(`
    INSERT INTO payments (id, uuid, customer_id, amount, note, version)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(id, id, customerId, amount, note || '');

  return { success: true, serverId: id };
}

async function handleDeliverKeg(payload, context) {
  const { customerId, quantity, note } = payload;
  updateCustomerKegBalance(customerId, quantity, 0);

  return { success: true, serverId: customerId };
}

async function handleCollectKeg(payload, context) {
  const { customerId, quantity, note } = payload;
  updateCustomerKegBalance(customerId, 0, quantity);

  return { success: true, serverId: customerId };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function updateCustomerKegBalance(customerId, deliverKegs, returnKegs) {
  try {
    const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(customerId);
    if (!customer) return;

    const currentBalance = customer.keg_balance || 0;
    const newBalance = currentBalance + (deliverKegs || 0) - (returnKegs || 0);

    db.prepare(`
      UPDATE customers SET keg_balance = ?, updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ?
    `).run(newBalance, customerId);

    return newBalance;
  } catch (error) {
    logger.error('[SYNC-V2] updateCustomerKegBalance error', { customerId, error: error.message });
  }
}

module.exports = router;
