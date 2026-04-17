/**
 * BeerPOS - Optimized Dashboard Loading
 *
 * Sử dụng Batch API để load tất cả data trong 1 request thay vì nhiều requests.
 * Kết hợp với cache để giảm server load.
 */

// Cache key cho dashboard
const DASHBOARD_CACHE_KEY = 'dashboard_data';
const DASHBOARD_CACHE_TTL = 60; // 1 phút

/**
 * Load dashboard data sử dụng batch API
 * Trước: 1 request /dashboard/data
 * Sau: POST /api/batch với tất cả data cần thiết
 */
async function loadDashboardOptimized(forceRefresh = false) {
  // Thử cache trước
  if (!forceRefresh) {
    const cached = httpCache.get(DASHBOARD_CACHE_KEY);
    if (cached) {
      console.log('[Dashboard] Using cached data');
      return cached;
    }
  }

  try {
    // Sử dụng batch API - lấy tất cả data trong 1 request
    const response = await fetch('/api/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          { type: 'dashboard', params: { period: 'today' } },
          { type: 'products', params: { lowStock: true } },
          { type: 'keg-stats' },
          { type: 'promotions' }
        ]
      })
    });

    const { results } = await response.json();

    // Transform batch results sang format cũ để tương thích
    const data = transformBatchToDashboard(results);

    // Cache kết quả
    httpCache.set(DASHBOARD_CACHE_KEY, data, DASHBOARD_CACHE_TTL);

    return data;
  } catch (e) {
    console.error('[Dashboard] Batch load error:', e);
    // Fallback về API cũ
    return await loadDashboardLegacy();
  }
}

/**
 * Transform batch results sang format dashboard cũ
 */
function transformBatchToDashboard(results) {
  const dashboard = results.dashboard?.data || {};
  const lowStockProducts = results.products?.data?.filter(p => p.stock < 10) || [];

  return {
    // Stats
    todayStats: {
      revenue: dashboard.revenue || 0,
      profit: dashboard.profit || 0,
      orders: dashboard.orders || 0,
      units: dashboard.topProducts?.reduce((sum, p) => sum + (p.qty || 0), 0) || 0
    },
    todayUnits: { units: 0 },
    monthStats: {
      revenue: 0,
      profit: 0
    },
    monthUnits: { units: 0 },

    // Keg state
    kegState: results['keg-stats']?.data || {
      inventory: 0,
      emptyCollected: 0,
      customerHolding: 0,
      total: 0
    },

    // Products
    lowStockProducts,
    stockLowThreshold: 10,

    // Alerts
    customerAlerts: dashboard.customerAlerts || [],
    kpiAlerts: [],

    // Recent sales
    recentSales: dashboard.recentSales || [],

    // Charts
    monthlyRevenue: dashboard.monthlyRevenue || [],
    dailyRevenue: [],

    // Top
    topProducts: dashboard.topProducts || [],
    topCustomers: dashboard.topCustomers || [],

    // Expenses
    expenses: {
      month: dashboard.expenses?.month || 0,
      today: dashboard.expenses?.today || 0
    },

    // Settings
    monthlyExpected: 300,
    expectedUnits: 0,
    daysElapsed: new Date().getDate(),
    daysInMonth: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate(),
    customerAlertDays: 7
  };
}

/**
 * Fallback: load bằng API cũ
 */
async function loadDashboardLegacy() {
  const response = await fetch('/dashboard/data', { cache: 'no-store' });
  return await response.json();
}

/**
 * Debounced refresh - tránh gọi API quá nhiều lần
 */
let dashboardRefreshTimer = null;
let dashboardRefreshInFlight = false;

function debouncedDashboardRefresh(reason = 'mutation') {
  if (dashboardRefreshInFlight) return;

  clearTimeout(dashboardRefreshTimer);
  dashboardRefreshTimer = setTimeout(async () => {
    dashboardRefreshInFlight = true;

    try {
      const data = await loadDashboardOptimized(true); // Force refresh
      if (typeof initDashboard === 'function') {
        initDashboard(data);
      }
    } catch (e) {
      console.error('[Dashboard] Refresh error:', e);
    } finally {
      dashboardRefreshInFlight = false;
    }
  }, 500); // Debounce 500ms
}

// Listen for data mutations
if (typeof window !== 'undefined') {
  window.addEventListener('data:mutated', (evt) => {
    const detail = evt?.detail || {};
    const entity = detail.entity;

    // Only refresh for relevant entities
    if (['sale', 'expense', 'customer', 'product'].includes(entity)) {
      debouncedDashboardRefresh(entity);
    }
  });

  // Listen for SW invalidation
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event?.data || {};
      if (data.type === 'DATA_INVALIDATED') {
        debouncedDashboardRefresh('sw:' + (data.path || ''));
      }
    });
  }
}

// Export
window.loadDashboardOptimized = loadDashboardOptimized;
window.debouncedDashboardRefresh = debouncedDashboardRefresh;