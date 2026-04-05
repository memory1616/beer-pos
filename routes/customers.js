const express = require('express');
const router = express.Router();
const db = require('../database');
const path = require('path');

// GET /customers - Serve HTML file
router.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, '../views/customers.html'));
});

// GET /customers/data - Get customers page data
router.get('/data', (req, res) => {
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;
  const currentMonthStr = currentMonth.toString().padStart(2, '0');

  // Pagination: page=1&limit=5 (default 5 per page)
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 5));
  const offset = (page - 1) * limit;
  const tab = req.query.tab || 'active';

  const whereClause = tab === 'archived' ? 'c.archived = 1' : 'c.archived = 0';
  const baseQuery = `
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
    WHERE ${whereClause}
    ORDER BY c.name
  `;

  if (tab === 'archived') {
    const totalResult = db.prepare(`SELECT COUNT(*) as total FROM customers c WHERE c.archived = 1`).get();
    const total = totalResult.total;
    const totalPages = Math.ceil(total / limit);
    const archived = db.prepare(baseQuery + ' LIMIT ? OFFSET ?').all(currentYear.toString(), currentMonthStr, limit, offset);
    return res.json({ customers: [], archived, total, page, totalPages, limit, archivedTotal: total });
  } else {
    const totalResult = db.prepare(`SELECT COUNT(*) as total FROM customers c WHERE c.archived = 0`).get();
    const total = totalResult.total;
    const totalPages = Math.ceil(total / limit);
    const customers = db.prepare(baseQuery + ' LIMIT ? OFFSET ?').all(currentYear.toString(), currentMonthStr, limit, offset);
    return res.json({ customers, archived: [], total, page, totalPages, limit, activeTotal: total });
  }
});

// GET /customers/:id - Customer detail page
router.get('/:id', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, '../views/customer-detail.html'));
});

module.exports = router;
