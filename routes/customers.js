const express = require('express');
const router = express.Router();
const db = require('../database');
const path = require('path');
const { requireAuth } = require('../middleware/auth');

// GET /customers - Serve HTML file
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../views/customers.html'));
});

// GET /customers/data - Get customers page data
router.get('/data', requireAuth, (req, res) => {
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;
  const currentMonthStr = currentMonth.toString().padStart(2, '0');

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  // Active customers (paginated)
  const customers = db.prepare(`
    SELECT c.*,
      (SELECT GROUP_CONCAT(p.name || ': ' || pr.price) FROM prices pr JOIN products p ON pr.product_id = p.id WHERE pr.customer_id = c.id) as prices,
      c.last_order_date as last_sale_date,
      COALESCE(cm.monthly_kegs, 0) as monthly_liters,
      COALESCE(cm.monthly_revenue, 0) as monthly_revenue,
      COALESCE(cs.total_revenue, 0) as total_revenue,
      CASE
        WHEN c.last_order_date IS NULL THEN NULL
        ELSE CAST(julianday(date('now','localtime')) - julianday(date(c.last_order_date)) AS INTEGER)
      END as days_since_last_order
    FROM customers c
    LEFT JOIN (
      SELECT customer_id,
        COALESCE(SUM(si.quantity), 0) as monthly_kegs,
        SUM(s.total) as monthly_revenue
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE s.type = 'sale' AND strftime('%Y', s.date) = ? AND strftime('%m', s.date) = ?
      GROUP BY customer_id
    ) cm ON cm.customer_id = c.id
    LEFT JOIN (
      SELECT customer_id, COALESCE(SUM(total), 0) as total_revenue
      FROM sales WHERE type = 'sale' GROUP BY customer_id
    ) cs ON cs.customer_id = c.id
    WHERE c.archived = 0
    ORDER BY c.name
    LIMIT ? OFFSET ?
  `).all(currentYear.toString(), currentMonthStr, limit, offset);

  const totalRow = db.prepare('SELECT COUNT(*) as total FROM customers WHERE archived = 0').get();
  const total = totalRow ? totalRow.total : 0;

  // Archived customers (all, no pagination needed for small lists)
  const archived = db.prepare(`
    SELECT c.*,
      (SELECT GROUP_CONCAT(p.name || ': ' || pr.price) FROM prices pr JOIN products p ON pr.product_id = p.id WHERE pr.customer_id = c.id) as prices,
      c.last_order_date as last_sale_date,
      COALESCE(cm.monthly_kegs, 0) as monthly_liters,
      COALESCE(cm.monthly_revenue, 0) as monthly_revenue,
      COALESCE(cs.total_revenue, 0) as total_revenue,
      CASE
        WHEN c.last_order_date IS NULL THEN NULL
        ELSE CAST(julianday(date('now','localtime')) - julianday(date(c.last_order_date)) AS INTEGER)
      END as days_since_last_order
    FROM customers c
    LEFT JOIN (
      SELECT customer_id,
        COALESCE(SUM(si.quantity), 0) as monthly_kegs,
        SUM(s.total) as monthly_revenue
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE s.type = 'sale' AND strftime('%Y', s.date) = ? AND strftime('%m', s.date) = ?
      GROUP BY customer_id
    ) cm ON cm.customer_id = c.id
    LEFT JOIN (
      SELECT customer_id, COALESCE(SUM(total), 0) as total_revenue
      FROM sales WHERE type = 'sale' GROUP BY customer_id
    ) cs ON cs.customer_id = c.id
    WHERE c.archived = 1
    ORDER BY c.name
  `).all(currentYear.toString(), currentMonthStr);

  res.json({ customers, archived, total, page, pages: Math.ceil(total / limit) });
});

// GET /customers/:id - Customer detail page
router.get('/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '../views/customer-detail.html'));
});

module.exports = router;
