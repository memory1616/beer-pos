/**
 * BeerPOS - State API
 * ─────────────────────────────────────────────────────────────────────────────
 * API endpoint cho full state và delta state sync
 * 
 * GET /api/state/full - Lấy full state
 * GET /api/state/delta?lastSync=timestamp - Lấy thay đổi kể từ lastSync
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');

// ── GET /api/state/full ──────────────────────────────────────────────────────

router.get('/full', (req, res) => {
  try {
    const { entities = 'all' } = req.query;

    const state = {};

    // Customers
    if (entities === 'all' || entities.includes('customers')) {
      state.customers = db.prepare(`
        SELECT id, uuid, name, phone, address, lat, lng, debt, deposit,
               keg_balance, last_order_date, horizontal_fridge, vertical_fridge,
               monthly_expected, exclude_expected, archived, note,
               created_at, updated_at, version
        FROM customers
        WHERE deleted = 0 OR deleted IS NULL
        ORDER BY name
      `).all();
    }

    // Products
    if (entities === 'all' || entities.includes('products')) {
      state.products = db.prepare(`
        SELECT id, uuid, slug, name, stock, damaged_stock, cost_price, sell_price,
               type, created_at, updated_at, version
        FROM products
        WHERE deleted = 0 OR deleted IS NULL
        ORDER BY name
      `).all();
    }

    // Today's Sales
    const today = db.getVietnamDateStr();
    if (entities === 'all' || entities.includes('sales')) {
      state.sales = db.prepare(`
        SELECT s.id, s.uuid, s.customer_id, s.date, s.total, s.profit,
               s.deliver_kegs, s.return_kegs, s.keg_balance_after,
               s.type, s.status, s.note, s.distance_km, s.duration_min,
               s.returned_amount, s.returned_quantity,
               c.name as customer_name,
               created_at, updated_at, version
        FROM sales s
        LEFT JOIN customers c ON s.customer_id = c.id
        WHERE s.date = ? AND (s.deleted = 0 OR s.deleted IS NULL)
        ORDER BY s.id DESC
      `).all(today);
    }

    // Today's Expenses
    if (entities === 'all' || entities.includes('expenses')) {
      state.expenses = db.prepare(`
        SELECT id, uuid, category, type, amount, description, date, time, km,
               order_id, is_auto, created_at, updated_at, version
        FROM expenses
        WHERE date = ? AND (deleted = 0 OR deleted IS NULL)
        ORDER BY time DESC
      `).all(today);
    }

    // Keg Stats
    if (entities === 'all' || entities.includes('kegs')) {
      state.kegStats = db.prepare(`
        SELECT * FROM keg_stats WHERE id = 1
      `).get();
    }

    // Products for prices
    if (entities === 'all' || entities.includes('prices')) {
      state.prices = db.prepare(`
        SELECT id, customer_id, product_id, product_slug, price,
               created_at, updated_at
        FROM prices
      `).all();
    }

    // Metadata
    state.meta = {
      timestamp: new Date().toISOString(),
      date: today,
      serverVersion: '2.0',
    };

    res.json({
      success: true,
      ...state,
    });

  } catch (error) {
    logger.error('Error fetching full state', { error: error.message });
    res.status(500).json({ error: 'Lỗi khi lấy dữ liệu' });
  }
});

// ── GET /api/state/delta ─────────────────────────────────────────────────────

router.get('/delta', (req, res) => {
  try {
    const { lastSync } = req.query;

    if (!lastSync) {
      return res.status(400).json({ error: 'Thiếu tham số lastSync' });
    }

    const sinceDate = new Date(parseInt(lastSync)).toISOString();

    const delta = {};

    // Changes since lastSync
    delta.customers = db.prepare(`
      SELECT id, uuid, name, phone, address, lat, lng, debt, deposit,
             keg_balance, last_order_date, horizontal_fridge, vertical_fridge,
             monthly_expected, exclude_expected, archived, note,
             created_at, updated_at, version, deleted
      FROM customers
      WHERE updated_at >= ? OR created_at >= ?
    `).all(sinceDate, sinceDate);

    delta.products = db.prepare(`
      SELECT id, uuid, slug, name, stock, damaged_stock, cost_price, sell_price,
             type, created_at, updated_at, version, deleted
      FROM products
      WHERE updated_at >= ? OR created_at >= ?
    `).all(sinceDate, sinceDate);

    delta.sales = db.prepare(`
      SELECT id, uuid, customer_id, date, total, profit,
             deliver_kegs, return_kegs, keg_balance_after,
             type, status, note, distance_km, duration_min,
             returned_amount, returned_quantity,
             created_at, updated_at, version, deleted
      FROM sales
      WHERE updated_at >= ? OR created_at >= ?
    `).all(sinceDate, sinceDate);

    delta.expenses = db.prepare(`
      SELECT id, uuid, category, type, amount, description, date, time, km,
             order_id, is_auto, created_at, updated_at, version, deleted
      FROM expenses
      WHERE updated_at >= ? OR created_at >= ?
    `).all(sinceDate, sinceDate);

    // Keg changes
    delta.kegStats = db.prepare(`
      SELECT * FROM keg_stats WHERE id = 1
    `).get();

    // Action logs since lastSync
    delta.actionLogs = db.prepare(`
      SELECT uuid, action, entity, entity_id, payload, created_at
      FROM action_logs
      WHERE created_at >= ?
      ORDER BY created_at ASC
      LIMIT 100
    `).all(sinceDate);

    delta.meta = {
      timestamp: new Date().toISOString(),
      lastSync: sinceDate,
      changes: {
        customers: delta.customers.length,
        products: delta.products.length,
        sales: delta.sales.length,
        expenses: delta.expenses.length,
      },
    };

    res.json({
      success: true,
      ...delta,
    });

  } catch (error) {
    logger.error('Error fetching delta', { error: error.message });
    res.status(500).json({ error: 'Lỗi khi lấy thay đổi' });
  }
});

// ── GET /api/state/entities ──────────────────────────────────────────────────

router.get('/entities', (req, res) => {
  const { ids, entity } = req.query;

  if (!entity || !ids) {
    return res.status(400).json({ error: 'Thiếu tham số' });
  }

  try {
    const idList = ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));

    if (idList.length === 0) {
      return res.json({ success: true, items: [] });
    }

    const placeholders = idList.map(() => '?').join(',');

    let items;
    switch (entity) {
      case 'customers':
        items = db.prepare(`
          SELECT * FROM customers WHERE id IN (${placeholders})
        `).all(...idList);
        break;

      case 'products':
        items = db.prepare(`
          SELECT * FROM products WHERE id IN (${placeholders})
        `).all(...idList);
        break;

      case 'sales':
        items = db.prepare(`
          SELECT s.*, c.name as customer_name
          FROM sales s
          LEFT JOIN customers c ON s.customer_id = c.id
          WHERE s.id IN (${placeholders})
        `).all(...idList);
        break;

      case 'expenses':
        items = db.prepare(`
          SELECT * FROM expenses WHERE id IN (${placeholders})
        `).all(...idList);
        break;

      default:
        return res.status(400).json({ error: 'Entity không hợp lệ' });
    }

    res.json({
      success: true,
      entity,
      items,
    });

  } catch (error) {
    logger.error('Error fetching entities', { error: error.message });
    res.status(500).json({ error: 'Lỗi khi lấy dữ liệu' });
  }
});

// ── POST /api/state/batch ────────────────────────────────────────────────────

router.post('/batch', (req, res) => {
  const { operations } = req.body;

  if (!operations || !Array.isArray(operations)) {
    return res.status(400).json({ error: 'Thiếu danh sách operations' });
  }

  const results = [];

  const batchTransaction = db.transaction(() => {
    for (const op of operations) {
      try {
        const { action, entity, data } = op;
        let result;

        switch (`${entity}:${action}`) {
          case 'expense:create':
            const expResult = db.prepare(`
              INSERT INTO expenses (uuid, category, type, amount, description, date, time, version)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            `).run(
              generateUUID(),
              data.category,
              data.type || 'other',
              data.amount,
              data.description,
              db.getVietnamDateStr(),
              new Date().toTimeString().slice(0, 5)
            );
            result = { success: true, id: expResult.lastInsertRowid };
            break;

          case 'sale:update':
            db.prepare(`
              UPDATE sales SET total = ?, profit = ?, updated_at = CURRENT_TIMESTAMP,
                             version = version + 1
              WHERE id = ?
            `).run(data.total, data.profit, data.id);
            result = { success: true, id: data.id };
            break;

          default:
            result = { success: false, error: 'Unknown operation' };
        }

        results.push({ op, result });
      } catch (error) {
        results.push({
          op,
          result: { success: false, error: error.message }
        });
      }
    }
  });

  try {
    batchTransaction();
    res.json({ success: true, results });
  } catch (error) {
    logger.error('Batch operation failed', { error: error.message });
    res.status(500).json({ error: 'Batch operation failed' });
  }
});

// ── Helper ────────────────────────────────────────────────────────────────────

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

module.exports = router;
