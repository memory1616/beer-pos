const express = require('express');
const router = express.Router();
const db = require('../database');
const path = require('path');

const DISTRIBUTOR_NAME = 'Bia Tươi Gia Huy';

function formatVND(amount) {
  if (amount === null || amount === undefined || amount === '') return '0 đ';
  const num = Number(amount);
  if (isNaN(num)) return '0 đ';
  return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
}

// Helper: get Vietnam date string (YYYY-MM-DD) - fix timezone for cloud servers
function getVietnamDateStr() {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000); // UTC+7
  return vn.getUTCFullYear() + '-' +
    String(vn.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(vn.getUTCDate()).padStart(2, '0');
}

// Get first day of current month in Vietnam timezone
function getVietnamMonthStart() {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return vn.getUTCFullYear() + '-' +
    String(vn.getUTCMonth() + 1).padStart(2, '0') + '-01';
}

// Get N days ago date string in Vietnam timezone
function getVietnamDaysAgo(days) {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  vn.setUTCDate(vn.getUTCDate() - days);
  return vn.getUTCFullYear() + '-' +
    String(vn.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(vn.getUTCDate()).padStart(2, '0');
}

// GET /dashboard - Redirect to /
router.get('/dashboard', (req, res) => {
  res.redirect('/');
});

// Serve HTML with no-cache headers to prevent browser/PWA caching stale pages
function sendNoCacheHtml(res, filePath) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, filePath));
}

// GET / - Serve HTML file
router.get('/', (req, res) => {
  sendNoCacheHtml(res, '../views/dashboard.html');
});

// API: Get dashboard data
router.get('/data', (req, res) => {
  // Set no-cache headers for this JSON endpoint (app-level middleware may miss mounted sub-paths)
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');

  try {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const today = getVietnamDateStr();
  const monthStartStr = getVietnamMonthStart();
  const fourteenDaysAgoStr = getVietnamDaysAgo(13); // 13 days ago = last 14 days

  // Get today's stats
  const todayStats = db.prepare(`
    SELECT
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit,
      COUNT(*) as orders,
      COALESCE((SELECT SUM(si.quantity) FROM sale_items si JOIN sales ss ON si.sale_id = ss.id WHERE ss.type = 'sale' AND date(ss.date) = ?), 0) as units
    FROM sales WHERE type = 'sale' AND date(date) = ?
  `).get(today, today);

  // Get monthly stats
  const monthStats = db.prepare(`
    SELECT
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit,
      COALESCE((SELECT SUM(si.quantity) FROM sale_items si JOIN sales ss ON si.sale_id = ss.id WHERE ss.type = 'sale' AND date(ss.date) >= ?), 0) as units
    FROM sales WHERE type = 'sale' AND date(date) >= ?
  `).get(monthStartStr, monthStartStr);
  
  // Get low stock threshold from settings (default: 10)
  const stockThresholdSetting = db.prepare("SELECT value FROM settings WHERE key = 'stock_low_threshold'").get();
  const stockLowThreshold = stockThresholdSetting ? parseInt(stockThresholdSetting.value) : 10;

  // Get low stock products - using configurable threshold
  const lowStockProducts = db.prepare(`
    SELECT id, name, stock FROM products WHERE stock < ? ORDER BY stock ASC LIMIT 10
  `).all(stockLowThreshold);
  
  // Get keg state - ALWAYS sync from source tables
  const inventoryPositive = db.prepare(db.SQL_KEG_WAREHOUSE_POSITIVE_STOCK).get();
  const inventoryRaw = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get();
  const customerResult = db.prepare("SELECT COALESCE(SUM(keg_balance), 0) as total FROM customers").get();
  const kegStats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
  const emptyCollected = kegStats?.empty_collected || 0;
  const customerHolding = customerResult.total;
  // Kho: chỉ hiện tồn dương. Tổng vỏ: cộng đại số kho (trừ nợ âm) + khách + rỗng
  const kegState = {
    inventory: inventoryPositive.total,
    emptyCollected,
    customerHolding,
    total: inventoryRaw.total + emptyCollected + customerHolding
  };
  
  // Get recent sales - add LIMIT 10
  const recentSales = db.prepare(`
    SELECT s.id, s.date, s.total, s.type, COALESCE(c.name, 'Khách lẻ') as customer_name
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    ORDER BY s.date DESC
    LIMIT 10
  `).all();
  
  // Get monthly revenue for chart (last 6 months)
  const sixMonthsAgoDate = new Date();
  sixMonthsAgoDate.setMonth(sixMonthsAgoDate.getMonth() - 5);
  sixMonthsAgoDate.setDate(1);
  const sixMonthsAgoStr = `${sixMonthsAgoDate.getFullYear()}-${String(sixMonthsAgoDate.getMonth() + 1).padStart(2, '0')}-01`;

  const monthlyRevenue = db.prepare(`
    SELECT
      strftime('%Y-%m', date(date)) as month,
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit
    FROM sales
    WHERE type = 'sale' AND date(date) >= ?
    GROUP BY strftime('%Y-%m', date(date))
    ORDER BY month
  `).all(sixMonthsAgoStr);

  // Get monthly expenses for the same period
  const monthlyExpenses = db.prepare(`
    SELECT strftime('%Y-%m', date(date)) as month, COALESCE(SUM(amount), 0) as total
    FROM expenses
    WHERE date(date) >= ?
    GROUP BY strftime('%Y-%m', date(date))
    ORDER BY month
  `).all(sixMonthsAgoStr);

  // Merge monthly expenses into monthlyRevenue
  const monthExpenseMap = {};
  monthlyExpenses.forEach(e => { monthExpenseMap[e.month] = e.total; });
  monthlyRevenue.forEach(d => { d.expenses = monthExpenseMap[d.month] || 0; });
  
  // Get daily revenue for chart (last 14 days)
  const dailyRevenue = db.prepare(`
    SELECT
      date(date) as day,
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit
    FROM sales
    WHERE type = 'sale' AND date(date) >= ?
    GROUP BY date(date)
    ORDER BY day
  `).all(fourteenDaysAgoStr);

  // Get daily expenses for the same period (for net profit calculation)
  const dailyExpenses = db.prepare(`
    SELECT date(date) as day, COALESCE(SUM(amount), 0) as total
    FROM expenses
    WHERE date(date) >= ?
    GROUP BY date(date)
    ORDER BY day
  `).all(fourteenDaysAgoStr);

  // Merge daily expenses into dailyRevenue
  const expenseMap = {};
  dailyExpenses.forEach(e => { expenseMap[e.day] = e.total; });
  dailyRevenue.forEach(d => { d.expenses = expenseMap[d.day] || 0; });
  
  // Get top products this month - optimized query
  const topProducts = db.prepare(`
    SELECT p.name, SUM(si.quantity) as total_qty
    FROM sale_items si
    JOIN products p ON si.product_id = p.id
    JOIN sales s ON si.sale_id = s.id
    WHERE s.type = 'sale' AND date(s.date) >= ?
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
    WHERE s.type = 'sale' AND date(s.date) >= ?
    GROUP BY c.id
    ORDER BY total DESC
    LIMIT 5
  `).all(monthStartStr);
  
  // Get customer alert days from settings (default: 7)
  const customerAlertDaysSetting = db.prepare("SELECT value FROM settings WHERE key = 'customer_alert_days'").get();
  const customerAlertDays = customerAlertDaysSetting ? parseInt(customerAlertDaysSetting.value) : 7;

  // Kỳ vọng bình/tháng cho header dashboard
  const monthlyExpectedSetting = db.prepare("SELECT value FROM settings WHERE key = 'monthly_expected'").get();
  const monthlyExpected = monthlyExpectedSetting ? parseFloat(monthlyExpectedSetting.value) : 300;
  const daysElapsed = now.getDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const expectedUnits = Math.round(monthlyExpected * daysElapsed / daysInMonth);

  // Get customer alerts (configurable days no order) - uses Vietnam time for 'now'
  const customerAlerts = db.prepare(`
    SELECT id, name, phone, last_order_date,
      CAST(julianday('now') - julianday(last_order_date) AS INTEGER) as days
    FROM customers
    WHERE archived = 0
    AND (exclude_expected IS NULL OR exclude_expected = 0)
    AND last_order_date IS NOT NULL
    AND julianday('now') - julianday(last_order_date) >= ?
    ORDER BY days DESC
    LIMIT 10
  `).all(customerAlertDays);

  // KPI alerts: khách thấp hơn kỳ vọng bình/tháng (có filter exclude_expected)
  const kpiAlerts = db.prepare(`
    SELECT c.id, c.name, c.phone, c.last_order_date,
      COALESCE(mc.monthly_qty, 0) as monthly_qty,
      ROUND(?) - COALESCE(mc.monthly_qty, 0) as shortfall
    FROM customers c
    LEFT JOIN (
      SELECT s.customer_id, SUM(si.quantity) as monthly_qty
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE s.type = 'sale' AND date(s.date) >= ?
      GROUP BY s.customer_id
    ) mc ON mc.customer_id = c.id
    WHERE c.archived = 0
    AND (c.exclude_expected IS NULL OR c.exclude_expected = 0)
    AND ROUND(?) - COALESCE(mc.monthly_qty, 0) > 0
    ORDER BY shortfall DESC
    LIMIT 10
  `).all(expectedUnits, monthStartStr, expectedUnits);
  
  // Get monthly expenses
  const monthExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date(date) >= ?
  `).get(monthStartStr);
  
  // Get today's expenses by type
  const todayExpensesByType = db.prepare(`
    SELECT type, COALESCE(SUM(amount), 0) as total 
    FROM expenses 
    WHERE date = ?
    GROUP BY type
  `).all(today);
  
  // Convert to object
  const expensesByType = { fuel: 0, food: 0, repair: 0, other: 0 };
  todayExpensesByType.forEach(e => {
    const type = e.type || 'other';
    if (expensesByType[type] !== undefined) {
      expensesByType[type] = e.total;
    }
  });
  
  // Get today's expenses
  const todayExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date = ?
  `).get(today);

  res.json({
    products: [], // Removed - not needed for dashboard display
    customers: [], // Removed - not needed for dashboard display
    todayStats,
    todayUnits: { units: todayStats.units || 0 }, // Get from combined query
    monthStats,
    monthUnits: { units: monthStats.units || 0 }, // Get from combined query
    topProducts,
    lowStockProducts,
    stockLowThreshold, // Ngưỡng cảnh báo tồn kho (từ settings)
    customerAlertDays, // Ngưỡng ngày không đặt hàng (từ settings)
    monthlyExpected,   // Kỳ vọng bình/tháng (từ settings)
    expectedUnits,     // Kỳ vọng đến hôm nay
    daysElapsed,       // Số ngày đã qua
    daysInMonth,       // Số ngày trong tháng
    kpiAlerts,        // Cảnh báo KPI theo tháng (có lọc exclude_expected)
    kegState,
    recentSales,
    monthlyRevenue,
    dailyRevenue,
    topCustomers,
    customerAlerts,
    expenses: {
      month: monthExpenses.total || 0,
      today: todayExpenses.total || 0,
      todayByType: expensesByType
    }
  });
  } catch (err) {
    console.error('[/dashboard/data] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

module.exports = router;
