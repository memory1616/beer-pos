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

  // Get today's stats — loại trừ MONTHLY_BONUS + returned + timezone +7h
  const todayStats = db.prepare(`
    SELECT
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit,
      COUNT(*) as orders,
      COALESCE((SELECT SUM(si.quantity) FROM sale_items si JOIN sales ss ON si.sale_id = ss.id WHERE ss.type = 'sale' AND ss.archived = 0 AND (ss.status IS NULL OR ss.status != 'returned') AND ss.promo_type IS DISTINCT FROM 'MONTHLY_BONUS' AND date(datetime(ss.date, '+7 hours')) = ?), 0) as units
    FROM sales WHERE type = 'sale' AND archived = 0 AND (status IS NULL OR status != 'returned') AND promo_type IS DISTINCT FROM 'MONTHLY_BONUS' AND date(datetime(date, '+7 hours')) = ?
  `).get(today, today);

  // Get monthly stats — loại trừ MONTHLY_BONUS + returned + timezone +7h
  const monthStats = db.prepare(`
    SELECT
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit,
      COALESCE((SELECT SUM(si.quantity) FROM sale_items si JOIN sales ss ON si.sale_id = ss.id WHERE ss.type = 'sale' AND ss.archived = 0 AND (ss.status IS NULL OR ss.status != 'returned') AND ss.promo_type IS DISTINCT FROM 'MONTHLY_BONUS' AND date(datetime(ss.date, '+7 hours')) >= ?), 0) as units
    FROM sales WHERE type = 'sale' AND archived = 0 AND (status IS NULL OR status != 'returned') AND promo_type IS DISTINCT FROM 'MONTHLY_BONUS' AND date(datetime(date, '+7 hours')) >= ?
  `).get(monthStartStr, monthStartStr);
  
  // Get low stock threshold from settings (default: 10)
  const stockThresholdSetting = db.prepare("SELECT value FROM settings WHERE key = 'stock_low_threshold'").get();
  const stockLowThreshold = stockThresholdSetting ? parseInt(stockThresholdSetting.value) : 30;

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
  
  // Get recent sales (loại trừ MONTHLY_BONUS + returned — thưởng tháng không hiện trong danh sách bán gần đây)
  const recentSales = db.prepare(`
    SELECT s.id, s.date, s.total, s.type, COALESCE(c.name, 'Khách lẻ') as customer_name
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.archived = 0 AND s.promo_type IS DISTINCT FROM 'MONTHLY_BONUS' AND (s.status IS NULL OR s.status != 'returned')
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
      strftime('%Y-%m', date(datetime(date, '+7 hours'))) as month,
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit
    FROM sales
    WHERE type = 'sale' AND archived = 0 AND (status IS NULL OR status != 'returned') AND promo_type IS DISTINCT FROM 'MONTHLY_BONUS' AND date(datetime(date, '+7 hours')) >= ?
    GROUP BY strftime('%Y-%m', date(datetime(date, '+7 hours')))
    ORDER BY month
  `).all(sixMonthsAgoStr);

  // Get monthly expenses for the same period
  const monthlyExpenses = db.prepare(`
    SELECT strftime('%Y-%m', date(datetime(date, '+7 hours'))) as month, COALESCE(SUM(amount), 0) as total
    FROM expenses
    WHERE date(datetime(date, '+7 hours')) >= ?
    GROUP BY strftime('%Y-%m', date(datetime(date, '+7 hours')))
    ORDER BY month
  `).all(sixMonthsAgoStr);

  // Merge monthly expenses into monthlyRevenue
  const monthExpenseMap = {};
  monthlyExpenses.forEach(e => { monthExpenseMap[e.month] = e.total; });
  monthlyRevenue.forEach(d => { d.expenses = monthExpenseMap[d.month] || 0; });
  
  // Get daily revenue for chart (last 14 days) — loại trừ MONTHLY_BONUS + returned + timezone +7h
  const dailyRevenue = db.prepare(`
    SELECT
      date(datetime(date, '+7 hours')) as day,
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit
    FROM sales
    WHERE type = 'sale' AND archived = 0 AND (status IS NULL OR status != 'returned') AND promo_type IS DISTINCT FROM 'MONTHLY_BONUS' AND date(datetime(date, '+7 hours')) >= ?
    GROUP BY date(datetime(date, '+7 hours'))
    ORDER BY day
  `).all(fourteenDaysAgoStr);

  // Get daily expenses for the same period (for net profit calculation)
  const dailyExpenses = db.prepare(`
    SELECT date(datetime(date, '+7 hours')) as day, COALESCE(SUM(amount), 0) as total
    FROM expenses
    WHERE date(datetime(date, '+7 hours')) >= ?
    GROUP BY date(datetime(date, '+7 hours'))
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
    WHERE s.type = 'sale' AND s.archived = 0 AND (s.status IS NULL OR s.status != 'returned') AND s.promo_type IS DISTINCT FROM 'MONTHLY_BONUS' AND date(datetime(s.date, '+7 hours')) >= ?
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
    WHERE s.type = 'sale' AND s.archived = 0 AND (s.status IS NULL OR s.status != 'returned') AND s.promo_type IS DISTINCT FROM 'MONTHLY_BONUS' AND date(datetime(s.date, '+7 hours')) >= ?
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

  // KPI alerts: khách tháng trước dưới mức Kỳ vọng bình/tháng (chung)
  const prevMonthDate = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
  const prevMonthStart = prevMonthDate.getUTCFullYear() + '-' +
    String(prevMonthDate.getUTCMonth() + 1).padStart(2, '0') + '-01';
  const prevMonthEnd = prevMonthDate.getUTCFullYear() + '-' +
    String(prevMonthDate.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(new Date(prevMonthDate.getUTCFullYear(), prevMonthDate.getUTCMonth() + 1, 0).getUTCDate()).padStart(2, '0');

  const kpiAlerts = db.prepare(`
    SELECT c.id, c.name, c.phone, c.last_order_date,
      COALESCE(mc.prev_month_qty, 0) as prev_month_qty,
      ROUND(?) - COALESCE(mc.prev_month_qty, 0) as shortfall
    FROM customers c
    LEFT JOIN (
      SELECT s.customer_id, SUM(si.quantity) as prev_month_qty
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE s.type = 'sale' AND s.archived = 0 AND date(s.date) >= ? AND date(s.date) <= ?
      GROUP BY s.customer_id
    ) mc ON mc.customer_id = c.id
    WHERE c.archived = 0
    AND (c.exclude_expected IS NULL OR c.exclude_expected = 0)
    AND ROUND(?) - COALESCE(mc.prev_month_qty, 0) > 0
    ORDER BY shortfall DESC
    LIMIT 10
  `).all(monthlyExpected, prevMonthStart, prevMonthEnd, monthlyExpected);
  
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
    monthlyExpected,   // Kỳ vọng bình/tháng (chung, từ settings)
    expectedUnits,     // Kỳ vọng đến hôm nay (theo tỷ lệ ngày)
    daysElapsed,       // Số ngày đã qua
    daysInMonth,       // Số ngày trong tháng
    prevMonthStart,   // Tháng trước - ngày đầu
    prevMonthEnd,     // Tháng trước - ngày cuối
    kpiAlerts,        // Cảnh báo: khách tháng trước dưới mức kỳ vọng
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
    },
    promoStats: (function() {
      try {
        // Count active new shops (created within 30 days)
        const activeNewShops = db.prepare(`
          SELECT COUNT(*) as cnt FROM customers
          WHERE archived = 0
            AND created_at >= datetime('now', '-30 days')
        `).get();
        const newShops = activeNewShops ? activeNewShops.cnt : 0;

        // Total free liters this month
        const freeLitersMonth = db.prepare(`
          SELECT COALESCE(SUM(promo_free_liters), 0) as total FROM sales
          WHERE date >= ? AND archived = 0
        `).get(monthStartStr);
        const freeLiters = freeLitersMonth ? freeLitersMonth.total : 0;

        // Promo cost this month (estimated: free liters * avg price)
        const avgPrice = db.prepare(`
          SELECT COALESCE(AVG(total /
            NULLIF((SELECT SUM(quantity) FROM sale_items WHERE sale_id = id), 0)
          ), 0) as avg FROM sales WHERE type = 'sale' AND archived = 0 AND total > 0 AND date >= ? LIMIT 1
        `).get(monthStartStr);
        const promoCost = Math.round((freeLiters || 0) * (avgPrice && avgPrice.avg > 0 ? avgPrice.avg : 30000));

        // Near reward tier customers (within 50L of 300L or 500L)
        const nearTier = db.prepare(`
          SELECT id, name, monthly_purchased_liters as monthlyLiters
          FROM customers
          WHERE monthly_purchased_liters >= 250
            AND monthly_purchased_liters < 500
            AND reward_claimed = 0
          ORDER BY monthly_purchased_liters DESC
          LIMIT 5
        `).all();

        const nearTierCustomers = nearTier.map(function(c) {
          const ml = c.monthlyLiters || 0;
          var nextTier = ml >= 500 ? 'Thưởng 20L' : 'Thưởng 10L';
          var target = ml >= 500 ? 500 : 300;
          var toNext = Math.max(0, target - ml);
          var pct = Math.min(100, Math.round((ml / target) * 100));
          return {
            id: c.id,
            name: c.name || 'N/A',
            monthlyLiters: ml,
            nextTier: nextTier,
            litersToNext: toNext,
            progressPct: pct
          };
        });

        return {
          activeNewShops: newShops,
          freeLitersMonth: freeLiters,
          promoCostMonth: promoCost,
          nearTierCount: nearTier.length,
          nearTierCustomers: nearTierCustomers
        };
      } catch(e) {
        console.error('[promoStats]', e.message);
        return null;
      }
    })()
  });
  } catch (err) {
    console.error('[/dashboard/data] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

module.exports = router;
