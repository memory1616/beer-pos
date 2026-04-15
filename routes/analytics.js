const express = require('express');
const router = express.Router();
const db = require('../database');

// GET /analytics - Serve analytics page
router.get('/', (req, res) => {
  res.sendFile(require('path').join(__dirname, '../views', 'analytics.html'));
});

// GET /analytics/summary - Get analytics summary data (used by analytics.html page)
router.get('/summary', (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const todayStats = db.prepare(`
      SELECT 
        COALESCE(SUM(total), 0) as revenue,
        COALESCE(SUM(profit), 0) as profit
      FROM sales WHERE date LIKE ?
    `).get(today + '%');

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    const startOfMonthStr = startOfMonth.toISOString().split('T')[0];

    const monthStats = db.prepare(`
      SELECT 
        COALESCE(SUM(total), 0) as revenue,
        COALESCE(SUM(profit), 0) as profit 
      FROM sales WHERE date >= ?
    `).get(startOfMonthStr);

    const topProducts = db.prepare(`
      SELECT p.name, SUM(si.quantity) as qty
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      JOIN sales s ON s.id = si.sale_id
      WHERE s.date >= ?
      GROUP BY p.id
      ORDER BY qty DESC
      LIMIT 5
    `).all(startOfMonthStr);

    const topCustomers = db.prepare(`
      SELECT c.name, SUM(s.total) as revenue
      FROM sales s
      JOIN customers c ON c.id = s.customer_id
      WHERE c.archived = 0
      GROUP BY c.id
      ORDER BY revenue DESC
      LIMIT 5
    `).all();

    const monthlyRaw = db.prepare(`
      SELECT
        strftime('%Y-%m', date) as month,
        SUM(total) as revenue,
        SUM(profit) as profit
      FROM sales
      WHERE date >= date('now', '-6 months', 'start of month')
      GROUP BY month
      ORDER BY month ASC
    `).all();

    const monthly = monthlyRaw.map(m => ({
      month: new Date(m.month + '-01').toLocaleDateString('vi-VN', { month: 'short', year: 'numeric' }),
      revenue: m.revenue || 0,
      profit: m.profit || 0
    }));

    res.json({
      today: todayStats,
      month: monthStats,
      topProducts,
      topCustomers,
      monthly
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;