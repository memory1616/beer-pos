const express = require('express');
const router = express.Router();
const db = require('../database');
const path = require('path');

const DISTRIBUTOR_NAME = 'Bia Tươi Gia Huy';

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

// GET / - Serve HTML file
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../views/dashboard.html'));
});

// GET /dashboard - Redirect to /
router.get('/dashboard', (req, res) => {
  res.redirect('/');
});

// API: Get dashboard data
router.get('/data', (req, res) => {
  // Get today's date (local time)
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const today = `${year}-${month}-${day}`;
  
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthStartStr = monthStart.getFullYear() + '-' + 
    String(monthStart.getMonth() + 1).padStart(2, '0') + '-' + 
    String(monthStart.getDate()).padStart(2, '0');
  
  // Get today's stats - optimized with single query
  const todayStats = db.prepare(`
    SELECT 
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit,
      COUNT(*) as orders,
      COALESCE((SELECT SUM(si.quantity) FROM sale_items si JOIN sales s ON si.sale_id = s.id WHERE s.date LIKE ?), 0) as units
    FROM sales WHERE type = 'sale' AND date LIKE ?
  `).get(today + '%', today + '%');
  
  // Get monthly stats - optimized with single query
  const monthStats = db.prepare(`
    SELECT 
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit,
      COALESCE((SELECT SUM(si.quantity) FROM sale_items si JOIN sales s ON si.sale_id = s.id WHERE s.type = 'sale' AND s.date >= ?), 0) as units
    FROM sales WHERE type = 'sale' AND date >= ?
  `).get(monthStartStr, monthStartStr);
  
  // Get low stock products - only needed fields, limit 10
  const lowStockProducts = db.prepare(`
    SELECT id, name, stock FROM products WHERE stock < 5 ORDER BY stock ASC LIMIT 10
  `).all();
  
  // Get keg stats - optimized with single query
  const kegStats = db.prepare(`
    SELECT 
      COALESCE((SELECT SUM(stock) FROM products WHERE type = 'keg'), 0) as inStock,
      COALESCE((SELECT SUM(keg_balance) FROM customers), 0) as atCustomers,
      COALESCE((SELECT SUM(stock) FROM products WHERE type = 'keg'), 0) + COALESCE((SELECT SUM(keg_balance) FROM customers), 0) as total
  `).get();
  
  // Get recent sales - add LIMIT 10
  const recentSales = db.prepare(`
    SELECT s.id, s.date, s.total, s.type, c.name as customer_name
    FROM sales s
    JOIN customers c ON c.id = s.customer_id
    ORDER BY s.date DESC
    LIMIT 10
  `).all();
  
  // Get monthly revenue for chart (last 6 months)
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setDate(1);
  const sixMonthsAgoStr = sixMonthsAgo.getFullYear() + '-' + 
    String(sixMonthsAgo.getMonth() + 1).padStart(2, '0') + '-' + 
    String(sixMonthsAgo.getDate()).padStart(2, '0');
  
  const monthlyRevenue = db.prepare(`
    SELECT 
      strftime('%Y-%m', date) as month,
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit
    FROM sales 
    WHERE type = 'sale' AND date >= ?
    GROUP BY strftime('%Y-%m', date)
    ORDER BY month
  `).all(sixMonthsAgoStr);
  
  // Get daily revenue for chart (last 14 days)
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 13);
  const fourteenDaysAgoStr = fourteenDaysAgo.toISOString().slice(0, 10);
  
  const dailyRevenue = db.prepare(`
    SELECT 
      date as day,
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit
    FROM sales 
    WHERE type = 'sale' AND date >= ?
    GROUP BY date(date)
    ORDER BY day
  `).all(fourteenDaysAgoStr);
  
  // Get top products this month - optimized query
  const topProducts = db.prepare(`
    SELECT p.name, SUM(si.quantity) as total_qty
    FROM sale_items si
    JOIN products p ON si.product_id = p.id
    JOIN sales s ON si.sale_id = s.id
    WHERE s.type = 'sale' AND s.date >= ?
    GROUP BY p.id
    ORDER BY total_qty DESC
    LIMIT 5
  `).all(monthStartStr);
  
  // Get top customers this month - optimized query
  const topCustomers = db.prepare(`
    SELECT c.name, SUM(s.total) as total, SUM(si.quantity) as qty
    FROM sales s
    JOIN customers c ON s.customer_id = c.id
    JOIN sale_items si ON si.sale_id = s.id
    WHERE s.type = 'sale' AND s.date >= ?
    GROUP BY c.id
    ORDER BY total DESC
    LIMIT 5
  `).all(monthStartStr);
  
  // Get customer alerts (7+ days no order) - optimized
  const customerAlerts = db.prepare(`
    SELECT id, name, phone, last_order_date,
      CAST(julianday('now') - julianday(last_order_date) AS INTEGER) as days
    FROM customers
    WHERE last_order_date IS NOT NULL
    AND julianday('now') - julianday(last_order_date) >= 7
    ORDER BY days DESC
    LIMIT 10
  `).all();
  
  // Get monthly expenses
  const monthExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date >= ?
  `).get(monthStartStr);
  
  // Get today's expenses
  const todayExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date LIKE ?
  `).get(today + '%');

  res.json({
    products: [], // Removed - not needed for dashboard display
    customers: [], // Removed - not needed for dashboard display
    todayStats,
    todayUnits: { units: todayStats.units || 0 }, // Get from combined query
    monthStats,
    monthUnits: { units: monthStats.units || 0 }, // Get from combined query
    topProducts,
    lowStockProducts,
    kegStats,
    recentSales,
    monthlyRevenue,
    dailyRevenue,
    topCustomers,
    customerAlerts,
    expenses: {
      month: monthExpenses.total || 0,
      today: todayExpenses.total || 0
    }
  });
});

module.exports = router;
