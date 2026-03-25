const express = require('express');
const router = express.Router();
const db = require('../database');
const path = require('path');
const { requireAuth, getSession, AUTH_CONFIG } = require('../middleware/auth');

const DISTRIBUTOR_NAME = 'Bia Tươi Gia Huy';

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

// GET / - Serve HTML file
router.get('/', (req, res) => {
  // Server-side auth check: if valid cookie exists, serve dashboard
  const token = req.cookies?.[AUTH_CONFIG.cookieName] ||
                req.headers.authorization?.replace('Bearer ', '') ||
                req.query?.token;
  if (!token || !getSession(token)) {
    return res.redirect('/login');
  }
  res.sendFile(path.join(__dirname, '../views/dashboard.html'));
});

// GET /dashboard - Redirect to /
router.get('/dashboard', (req, res) => {
  res.redirect('/');
});

// API: Get dashboard data (cached for 60s)
router.get('/data', requireAuth, (req, res) => {
  // Try cache first
  const cached = db.getCached('dashboard');
  if (cached) return res.json(cached);

  // Cache miss — compute all stats
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const today = `${year}-${month}-${day}`;

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthStartStr = monthStart.getFullYear() + '-' +
    String(monthStart.getMonth() + 1).padStart(2, '0') + '-' +
    String(monthStart.getDate()).padStart(2, '0');

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setDate(1);
  const sixMonthsAgoStr = sixMonthsAgo.getFullYear() + '-' +
    String(sixMonthsAgo.getMonth() + 1).padStart(2, '0') + '-' +
    String(sixMonthsAgo.getDate()).padStart(2, '0');

  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 13);
  const fourteenDaysAgoStr = fourteenDaysAgo.toISOString().slice(0, 10);

  // ===== SETTINGS (1 query) =====
  const settings = db.prepare("SELECT key, value FROM settings WHERE key IN ('stock_low_threshold','customer_alert_days','monthly_expected')").all();
  const settingsMap = {};
  settings.forEach(s => { settingsMap[s.key] = s.value; });

  const stockLowThreshold = parseInt(settingsMap['stock_low_threshold']) || 10;
  const customerAlertDays = parseInt(settingsMap['customer_alert_days']) || 7;
  const monthlyExpected   = parseFloat(settingsMap['monthly_expected'])   || 300;
  const daysElapsed       = now.getDate();
  const daysInMonth       = new Date(year, month, 0).getDate();
  const expectedUnits     = Math.round(monthlyExpected * daysElapsed / daysInMonth);

  // ===== KEG STATS (1 query) =====
  const kegData = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(stock), 0) FROM products WHERE type = 'keg') as inventory,
      (SELECT COALESCE(SUM(keg_balance), 0) FROM customers) as customerHolding,
      COALESCE((SELECT empty_collected FROM keg_stats WHERE id = 1), 0) as emptyCollected
  `).get();

  const todayData = db.prepare(`
    SELECT
      COALESCE(SUM(s.total), 0) as revenue,
      COALESCE(SUM(s.profit), 0) as profit,
      COUNT(*) as orders,
      COALESCE((SELECT SUM(si.quantity) FROM sale_items si WHERE si.sale_id IN (SELECT id FROM sales WHERE type = 'sale' AND date LIKE ?)), 0) as units
    FROM sales s WHERE s.type = 'sale' AND s.date LIKE ?
  `).get(today + '%', today + '%');

  const monthData = db.prepare(`
    SELECT
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit,
      COALESCE((SELECT SUM(si.quantity) FROM sale_items si WHERE si.sale_id IN (SELECT id FROM sales WHERE type = 'sale' AND date >= ?)), 0) as units
    FROM sales WHERE type = 'sale' AND date >= ?
  `).get(monthStartStr, monthStartStr);

  // ===== MERGE: today + month stats into single objects =====
  const kegState = {
    inventory:      kegData.inventory,
    emptyCollected: kegData.emptyCollected,
    customerHolding: kegData.customerHolding,
    total:          kegData.inventory + kegData.emptyCollected + kegData.customerHolding
  };
  const todayStatsM = {
    revenue: todayData.revenue,
    profit:  todayData.profit,
    orders:  todayData.orders,
    units:   todayData.units || 0
  };
  const monthStatsM = {
    revenue: monthData.revenue,
    profit:  monthData.profit,
    units:   monthData.units || 0
  };

  // ===== CHARTS (2 queries) =====
  const monthlyRevenue = db.prepare(`
    SELECT strftime('%Y-%m', s.date) as month,
      COALESCE(SUM(s.total), 0) as revenue,
      COALESCE(SUM(s.profit), 0) as profit
    FROM sales s
    WHERE s.type = 'sale' AND s.date >= ?
    GROUP BY 1 ORDER BY 1
  `).all(sixMonthsAgoStr);

  const dailyRevenue = db.prepare(`
    SELECT date(s.date) as day,
      COALESCE(SUM(s.total), 0) as revenue,
      COALESCE(SUM(s.profit), 0) as profit
    FROM sales s
    WHERE s.type = 'sale' AND s.date >= ?
    GROUP BY date(s.date) ORDER BY day
  `).all(fourteenDaysAgoStr);

  // ===== EXPENSES (3 queries) =====
  const todayExpensesByType = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total, type FROM expenses WHERE date = ? GROUP BY type
  `).all(today);

  const expensesByType = { fuel: 0, food: 0, repair: 0, other: 0 };
  todayExpensesByType.forEach(e => {
    const t = e.type || 'other';
    if (expensesByType[t] !== undefined) expensesByType[t] = e.total;
  });

  const monthExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date >= ?
  `).get(monthStartStr);

  const expensesChart = db.prepare(`
    SELECT strftime('%Y-%m', date) as month, COALESCE(SUM(amount), 0) as total
    FROM expenses WHERE date >= ? GROUP BY 1 ORDER BY 1
  `).all(sixMonthsAgoStr);

  const dailyExpenses = db.prepare(`
    SELECT date as day, COALESCE(SUM(amount), 0) as total
    FROM expenses WHERE date >= ? GROUP BY date ORDER BY date
  `).all(fourteenDaysAgoStr);

  // Merge expenses into revenue charts
  const monthExpenseMap = {};
  expensesChart.forEach(e => { monthExpenseMap[e.month] = e.total; });
  monthlyRevenue.forEach(d => { d.expenses = monthExpenseMap[d.month] || 0; });

  const expenseMap = {};
  dailyExpenses.forEach(e => { expenseMap[e.day] = e.total; });
  dailyRevenue.forEach(d => { d.expenses = expenseMap[d.day] || 0; });

  // ===== LISTS (5 queries) =====
  const lowStockProducts = db.prepare(`
    SELECT id, name, stock FROM products WHERE stock < ? ORDER BY stock ASC LIMIT 10
  `).all(stockLowThreshold);

  const recentSales = db.prepare(`
    SELECT s.id, s.date, s.total, s.type, COALESCE(c.name, 'Khách lẻ') as customer_name
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
    ORDER BY s.date DESC LIMIT 10
  `).all();

  const topProducts = db.prepare(`
    SELECT p.name, SUM(si.quantity) as total_qty
    FROM sale_items si
    JOIN products p ON si.product_id = p.id
    JOIN sales s ON si.sale_id = s.id
    WHERE s.type = 'sale' AND s.date >= ?
    GROUP BY p.id ORDER BY total_qty DESC LIMIT 5
  `).all(monthStartStr);

  const topCustomers = db.prepare(`
    SELECT c.name, SUM(s.total) as total, SUM(si.quantity) as qty
    FROM sales s
    JOIN customers c ON s.customer_id = c.id
    JOIN sale_items si ON si.sale_id = s.id
    WHERE s.type = 'sale' AND s.date >= ?
    GROUP BY c.id ORDER BY total DESC LIMIT 5
  `).all(monthStartStr);

  const customerAlerts = db.prepare(`
    SELECT id, name, phone, last_order_date,
      CAST(julianday('now') - julianday(last_order_date) AS INTEGER) as days
    FROM customers
    WHERE archived = 0
    AND last_order_date IS NOT NULL
    AND julianday('now') - julianday(last_order_date) >= ?
    ORDER BY days DESC LIMIT 10
  `).all(customerAlertDays);

  const kpiAlerts = db.prepare(`
    SELECT c.id, c.name, c.phone, c.last_order_date,
      COALESCE(mc.monthly_qty, 0) as monthly_qty,
      ROUND(?) - COALESCE(mc.monthly_qty, 0) as shortfall
    FROM customers c
    LEFT JOIN (
      SELECT s.customer_id, SUM(si.quantity) as monthly_qty
      FROM sales s JOIN sale_items si ON si.sale_id = s.id
      WHERE s.type = 'sale' AND s.date >= ?
      GROUP BY s.customer_id
    ) mc ON mc.customer_id = c.id
    WHERE c.archived = 0
    AND ROUND(?) - COALESCE(mc.monthly_qty, 0) > 0
    ORDER BY shortfall DESC LIMIT 10
  `).all(expectedUnits, monthStartStr, expectedUnits);

  const data = {
    todayStats: todayStatsM,
    todayUnits: { units: todayStatsM.units },
    monthStats: monthStatsM,
    monthUnits: { units: monthStatsM.units },
    topProducts,
    lowStockProducts,
    stockLowThreshold,
    customerAlertDays,
    monthlyExpected,
    expectedUnits,
    daysElapsed,
    daysInMonth,
    kpiAlerts,
    kegState,
    recentSales,
    monthlyRevenue,
    dailyRevenue,
    topCustomers,
    customerAlerts,
    expenses: {
      month: monthExpenses.total || 0,
      today: Object.values(expensesByType).reduce((a, b) => a + b, 0),
      todayByType: expensesByType
    }
  };

  // Store in cache (60s TTL)
  db.setCache('dashboard', data);

  res.json(data);
});

module.exports = router;
