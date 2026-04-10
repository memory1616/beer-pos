/**
 * BeerPOS - Event Sync API
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ EVENT-BASED SYNC - Nhận và xử lý events từ client
 * 
 * POST /api/sync/events - Batch sync events
 * GET /api/sync/counts - Get server counts
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');

// ── Cache for deduplication ──────────────────────────────────────────────────
const _processedEventIds = new Map();
const CACHE_TTL = 120000; // 2 minutes

// Cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of _processedEventIds) {
    if (now - timestamp > CACHE_TTL) {
      _processedEventIds.delete(key);
    }
  }
}, 60000);

// ── Batch Event Sync (PRIMARY) ───────────────────────────────────────────────

router.post('/events', async (req, res) => {
  const { deviceId, timestamp, events, forceSync } = req.body;

  if (!events || !Array.isArray(events) || events.length === 0) {
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

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const { id: eventId, type, entity, payload, createdAt, version } = event;

    // Check deduplication
    if (_processedEventIds.has(eventId) && !forceSync) {
      duplicates++;
      results.push({
        eventId,
        success: true,
        duplicate: true,
      });
      continue;
    }

    try {
      const result = await _processEvent({
        eventId,
        type,
        entity,
        payload,
        createdAt,
        version,
        deviceId,
        forceSync,
      });

      // Mark as processed
      _processedEventIds.set(eventId, Date.now());

      results.push(result);
      
      if (result.success) succeeded++;
      else failed++;

    } catch (error) {
      logger.error(`[SYNC] Event processing error: ${type}`, {
        eventId,
        error: error.message,
      });

      results.push({
        eventId,
        success: false,
        error: error.message,
      });
      failed++;
    }
  }

  const elapsed = Date.now() - startTime;

  logger.info(`[SYNC] Batch processed: ${events.length} events in ${elapsed}ms`, {
    deviceId,
    succeeded,
    failed,
    duplicates,
  });

  res.json({
    success: true,
    results,
    summary: {
      total: events.length,
      succeeded,
      failed,
      duplicates,
      elapsed,
    },
  });
});

// ── Process Single Event ──────────────────────────────────────────────────────

async function _processEvent(event) {
  const { eventId, type, entity, payload, createdAt, version, deviceId, forceSync } = event;

  const handlers = {
    ORDER_CREATED: _handleOrderCreated,
    ORDER_UPDATED: _handleOrderUpdated,
    ORDER_DELETED: _handleOrderDeleted,
    ORDER_RETURNED: _handleOrderReturned,
    PRODUCT_UPDATED: _handleProductUpdated,
    PRODUCT_STOCK_CHANGED: _handleProductStockChanged,
    CUSTOMER_CREATED: _handleCustomerCreated,
    CUSTOMER_UPDATED: _handleCustomerUpdated,
    EXPENSE_CREATED: _handleExpenseCreated,
    EXPENSE_UPDATED: _handleExpenseUpdated,
    EXPENSE_DELETED: _handleExpenseDeleted,
    KEG_DELIVERED: _handleKegDelivered,
    KEG_COLLECTED: _handleKegCollected,
    KEG_BALANCE_UPDATED: _handleKegBalanceUpdated,
    PAYMENT_CREATED: _handlePaymentCreated,
  };

  const handler = handlers[type];
  if (!handler) {
    return {
      eventId,
      success: false,
      error: `Unknown event type: ${type}`,
    };
  }

  return handler(event);
}

// ── Event Handlers ────────────────────────────────────────────────────────────

async function _handleOrderCreated(event) {
  const { eventId, payload, deviceId } = event;
  const { id, customerId, items, total, profit, deliverKegs, returnKegs, note, type, date } = payload;

  // Check duplicate
  const existing = db.prepare('SELECT id FROM sales WHERE id = ?').get(id);
  if (existing) {
    return { eventId, success: true, duplicate: true, serverId: id };
  }

  // Insert order
  db.prepare(`
    INSERT INTO sales (id, uuid, customer_id, date, total, profit, deliver_kegs, return_kegs,
                       keg_balance_after, type, note, status, version, created_at, updated_at, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)
  `).run(id, id, customerId || null, date || db.getVietnamDateStr(), total || 0, profit || 0,
    deliverKegs || 0, returnKegs || 0, 0, type || 'sale', note || '');

  // Insert sale items
  if (items?.length > 0) {
    for (const item of items) {
      db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run(id, item.productId, item.productSlug || null, item.quantity, item.price, item.costPrice || 0, item.profit || 0);

      // Update stock
      if (type !== 'replacement') {
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(item.quantity, item.productId);
      }
    }
  }

  // Update customer keg balance
  if (customerId && (deliverKegs > 0 || returnKegs > 0)) {
    _updateCustomerKegBalance(customerId, deliverKegs || 0, returnKegs || 0);
  }

  // Broadcast to other clients
  _broadcastEvent({
    eventId,
    type: 'ORDER_CREATED',
    entity: 'orders',
    entityId: id,
    payload,
    deviceId,
    timestamp: Date.now(),
  });

  return { eventId, success: true, serverId: id };
}

async function _handleOrderUpdated(event) {
  const { eventId, payload, forceSync } = event;
  const { id, total, profit, note } = payload;

  const existing = db.prepare('SELECT version FROM sales WHERE id = ?').get(id);
  if (!existing) {
    return { eventId, success: false, error: 'Order not found' };
  }

  if (!forceSync && payload.version && payload.version < existing.version) {
    return {
      eventId,
      success: false,
      conflict: true,
      serverData: existing,
    };
  }

  db.prepare(`
    UPDATE sales SET total = ?, profit = ?, note = ?, updated_at = CURRENT_TIMESTAMP, version = version + 1
    WHERE id = ?
  `).run(total, profit, note || '', id);

  return { eventId, success: true, serverId: id };
}

async function _handleOrderDeleted(event) {
  const { eventId, payload } = event;
  const { id } = payload;

  db.prepare(`
    UPDATE sales SET deleted = 1, updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ?
  `).run(id);

  return { eventId, success: true, serverId: id };
}

async function _handleOrderReturned(event) {
  const { eventId, payload } = event;
  const { id } = payload;

  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  if (!sale) {
    return { eventId, success: false, error: 'Order not found' };
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

  return { eventId, success: true, serverId: id };
}

async function _handleProductUpdated(event) {
  const { eventId, payload } = event;
  const { id, name, costPrice, sellPrice } = payload;

  db.prepare(`
    UPDATE products SET name = ?, cost_price = ?, sell_price = ?,
    updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ?
  `).run(name, costPrice, sellPrice, id);

  return { eventId, success: true, serverId: id };
}

async function _handleProductStockChanged(event) {
  const { eventId, payload } = event;
  const { id, stock, delta } = payload;

  if (stock !== undefined) {
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(stock, id);
  } else if (delta !== undefined) {
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(delta, id);
  }

  return { eventId, success: true, serverId: id };
}

async function _handleCustomerCreated(event) {
  const { eventId, payload, deviceId } = event;
  const { id, name, phone, address, deposit, kegBalance } = payload;

  const existing = db.prepare('SELECT id FROM customers WHERE id = ?').get(id);
  if (existing) {
    return { eventId, success: true, duplicate: true, serverId: id };
  }

  db.prepare(`
    INSERT INTO customers (id, uuid, name, phone, address, deposit, keg_balance, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(id, id, name, phone || '', address || '', deposit || 0, kegBalance || 0);

  _broadcastEvent({
    eventId,
    type: 'CUSTOMER_CREATED',
    entity: 'customers',
    entityId: id,
    payload,
    deviceId,
    timestamp: Date.now(),
  });

  return { eventId, success: true, serverId: id };
}

async function _handleCustomerUpdated(event) {
  const { eventId, payload } = event;
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

  return { eventId, success: true, serverId: id };
}

async function _handleExpenseCreated(event) {
  const { eventId, payload, deviceId } = event;
  const { id, category, type, amount, description, date, km } = payload;

  const existing = db.prepare('SELECT id FROM expenses WHERE id = ?').get(id);
  if (existing) {
    return { eventId, success: true, duplicate: true, serverId: id };
  }

  db.prepare(`
    INSERT INTO expenses (id, uuid, category, type, amount, description, date, time, km, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    id, id, category, type || 'other', amount,
    description || '', date || db.getVietnamDateStr(),
    new Date().toTimeString().slice(0, 5), km || null
  );

  return { eventId, success: true, serverId: id };
}

async function _handleExpenseUpdated(event) {
  const { eventId, payload } = event;
  const { id, category, type, amount, description } = payload;

  db.prepare(`
    UPDATE expenses SET category = ?, type = ?, amount = ?, description = ?,
    updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ?
  `).run(category, type, amount, description || '', id);

  return { eventId, success: true, serverId: id };
}

async function _handleExpenseDeleted(event) {
  const { eventId, payload } = event;
  const { id } = payload;

  db.prepare('UPDATE expenses SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);

  return { eventId, success: true, serverId: id };
}

async function _handleKegDelivered(event) {
  const { eventId, payload, deviceId } = event;
  const { customerId, quantity } = payload;

  _updateCustomerKegBalance(customerId, quantity, 0);

  _broadcastEvent({
    eventId,
    type: 'KEG_DELIVERED',
    entity: 'kegs',
    entityId: customerId,
    payload,
    deviceId,
    timestamp: Date.now(),
  });

  return { eventId, success: true, serverId: customerId };
}

async function _handleKegCollected(event) {
  const { eventId, payload, deviceId } = event;
  const { customerId, quantity } = payload;

  _updateCustomerKegBalance(customerId, 0, quantity);

  _broadcastEvent({
    eventId,
    type: 'KEG_COLLECTED',
    entity: 'kegs',
    entityId: customerId,
    payload,
    deviceId,
    timestamp: Date.now(),
  });

  return { eventId, success: true, serverId: customerId };
}

async function _handleKegBalanceUpdated(event) {
  const { eventId, payload } = event;
  const { customerId, kegBalance } = payload;

  db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(kegBalance, customerId);

  return { eventId, success: true, serverId: customerId };
}

async function _handlePaymentCreated(event) {
  const { eventId, payload, deviceId } = event;
  const { id, customerId, amount, note } = payload;

  const existing = db.prepare('SELECT id FROM payments WHERE id = ?').get(id);
  if (existing) {
    return { eventId, success: true, duplicate: true, serverId: id };
  }

  db.prepare(`
    INSERT INTO payments (id, uuid, customer_id, amount, note, version)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(id, id, customerId, amount, note || '');

  return { eventId, success: true, serverId: id };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _updateCustomerKegBalance(customerId, deliverKegs, returnKegs) {
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
    logger.error('[SYNC] _updateCustomerKegBalance error', { customerId, error: error.message });
  }
}

// ── Broadcast Event ─────────────────────────────────────────────────────────

function _broadcastEvent(event) {
  // Emit to Socket.IO if available
  if (global.io) {
    global.io.emit('EVENT_BROADCAST', event);
  }
}

// ── Counts Endpoint ─────────────────────────────────────────────────────────

router.get('/counts', (req, res) => {
  try {
    const counts = {
      orders: db.prepare('SELECT COUNT(*) as count FROM sales WHERE deleted = 0').get().count,
      customers: db.prepare('SELECT COUNT(*) as count FROM customers WHERE deleted = 0').get().count,
      products: db.prepare('SELECT COUNT(*) as count FROM products').get().count,
      expenses: db.prepare('SELECT COUNT(*) as count FROM expenses WHERE deleted = 0').get().count,
    };

    res.json({
      success: true,
      counts,
      serverTime: Date.now(),
    });
  } catch (error) {
    logger.error('[SYNC] Counts error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ── Status Endpoint ───────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  res.json({
    serverTime: new Date().toISOString(),
    status: 'ok',
    version: '3.0',
    processedEvents: _processedEventIds.size,
  });
});

module.exports = router;
