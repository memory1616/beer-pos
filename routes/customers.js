const express = require('express');
const router = express.Router();
const db = require('../database');
const path = require('path');

// GET /customers - Serve HTML file
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../views/customers.html'));
});

// GET /customers/data - Get customers page data
router.get('/data', (req, res) => {
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;
  
  // Calculate daily average from last 30 days of sales (only type='sale')
  const customers = db.prepare(`
    SELECT c.*, 
      (SELECT GROUP_CONCAT(p.name || ': ' || pr.price) FROM prices pr JOIN products p ON pr.product_id = p.id WHERE pr.customer_id = c.id) as prices,
      c.last_order_date as last_sale_date,
      COALESCE(cm.quantity, 0) as monthly_liters,
      COALESCE(cm.revenue, 0) as monthly_revenue,
      COALESCE(cs.total_revenue, 0) as total_revenue,
      COALESCE(daily.avg_daily, 0) as daily_avg,
      CASE 
        WHEN c.last_order_date IS NULL THEN NULL
        ELSE CAST(julianday('now') - julianday(c.last_order_date) AS INTEGER)
      END as days_since_last_order
    FROM customers c
    LEFT JOIN customer_monthly cm ON cm.customer_id = c.id AND cm.year = ? AND cm.month = ?
    LEFT JOIN (
      SELECT customer_id, COALESCE(SUM(total), 0) as total_revenue 
      FROM sales WHERE type = 'sale' GROUP BY customer_id
    ) cs ON cs.customer_id = c.id
    LEFT JOIN (
      SELECT customer_id, 
        CAST(COALESCE(SUM(si.quantity), 0) AS REAL) / 30.0 as avg_daily
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE s.type = 'sale' AND s.date >= date('now', '-30 days')
      GROUP BY customer_id
    ) daily ON daily.customer_id = c.id
    ORDER BY c.name
  `).all(currentYear, currentMonth);

  res.json({ customers });
});

// GET /customers/:id - Customer detail page
router.get('/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '../views/customer-detail.html'));
});

module.exports = router;
