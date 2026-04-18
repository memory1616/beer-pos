const express = require('express');
const router = express.Router();
const db = require('../../database');

// POST /api/orders — Create a new order (sale)
router.post('/', (req, res) => {
  const { customerId, items, total, profit, deliverKegs = 0, returnKegs = 0, type = 'sale', note = '' } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Danh sách sản phẩm trống' });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO sales (customer_id, date, total, profit, deliver_kegs, return_kegs, type, note, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    const result = stmt.run(customerId || null, new Date().toISOString(), total || 0, profit || 0, deliverKegs, returnKegs, type, note);

    const saleId = result.lastInsertRowid;

    // Insert sale items
    const itemStmt = db.prepare(`
      INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      itemStmt.run(saleId, item.productId, item.quantity, item.price || 0, item.costPrice || 0);
    }

    res.status(201).json({ success: true, id: saleId, message: 'Tạo đơn hàng thành công' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders — Get all orders (sales) - excludes archived
router.get('/', (req, res) => {
  try {
    const since = req.query.since || null; // ISO timestamp for incremental sync

    let whereClause = "WHERE s.type IN ('sale', 'replacement', 'damage_return') AND s.archived = 0";
    let params = [];

    if (since) {
      whereClause += " AND (s.updated_at > ? OR s.created_at > ?)";
      params.push(since, since);
    }

    const sales = db.prepare(`
      SELECT s.*, COALESCE(c.name, 'Khách lẻ') as customer_name,
        (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id) as items_qty
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.id
      ${whereClause}
      ORDER BY datetime(s.date) DESC
    `).all(...params);

    const items = db.prepare(`
      SELECT si.*, p.name as product_name
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      WHERE si.sale_id IN (SELECT id FROM sales s WHERE s.archived = 0)
    `).all();

    const orders = sales.map(sale => ({
      ...sale,
      items: items.filter(i => i.sale_id === sale.id).map(i => ({
        productId: i.product_id,
        productName: i.product_name,
        quantity: i.quantity,
        price: i.price,
        costPrice: i.cost_price
      }))
    }));

    res.json({ orders, count: orders.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
