/**
 * BeerPOS Batch API Endpoints
 *
 * Batch endpoints để giảm số lượng HTTP requests.
 * Thay vì 20 request riêng lẻ → gom thành 1-3 batch requests.
 *
 * TRƯỚC (chatty API):
 * GET /api/products
 * GET /api/customers
 * GET /api/keg-stats
 * GET /api/low-stock
 * GET /api/recent-sales
 * GET /api/revenue-today
 * GET /api/expenses-today
 * GET /api/promotions
 * ... 20+ requests cho 1 dashboard load
 *
 * SAU (batched):
 * POST /api/batch - body: { requests: [...] }
 * → 1 request lấy tất cả data cần thiết
 */

const express = require('express');
const router = express.Router();

const {
  SaleService,
  InventoryService,
  DebtService,
  PromotionService,
  AnalyticsService
} = require('../../src/services');

const { cache, cacheKeys } = require('../../src/cache');

/**
 * POST /api/batch
 * Batch execute multiple API calls in one request
 *
 * Request body:
 * {
 *   requests: [
 *     { type: 'products', params: {} },
 *     { type: 'customers', params: {} },
 *     { type: 'dashboard', params: { period: 'today' } },
 *     { type: 'promotions', params: {} }
 *   ]
 * }
 *
 * Response:
 * {
 *   results: {
 *     products: { data: [...], error: null },
 *     customers: { data: [...], error: null },
 *     ...
 *   }
 * }
 */
router.post('/batch', async (req, res) => {
  const { requests = [] } = req.body;

  if (!Array.isArray(requests) || requests.length === 0) {
    return res.status(400).json({ error: 'requests array required' });
  }

  const results = {};

  // Execute all requests in parallel
  const promises = requests.map(async (req) => {
    try {
      const result = await executeRequest(req);
      return { key: req.type, data: result, error: null };
    } catch (e) {
      return { key: req.type, data: null, error: e.message };
    }
  });

  const batchResults = await Promise.allSettled(promises);

  batchResults.forEach(result => {
    if (result.status === 'fulfilled') {
      results[result.value.key] = { data: result.value.data, error: result.value.error };
    }
  });

  res.json({ results });
});

/**
 * Execute single request type
 */
async function executeRequest(req) {
  const { type, params = {} } = req;

  switch (type) {
    case 'products':
      return getProducts(params);

    case 'customers':
      return getCustomers(params);

    case 'dashboard':
      return getDashboardData(params);

    case 'promotions':
      return getPromotions(params);

    case 'keg-stats':
      return getKegStats(params);

    case 'customer':
      return getCustomer(params);

    case 'sale':
      return getSale(params);

    case 'debts':
      return getDebts(params);

    case 'analytics':
      return getAnalytics(params);

    default:
      throw new Error(`Unknown request type: ${type}`);
  }
}

/**
 * Get products with caching
 */
async function getProducts(params = {}) {
  const cacheKey = cacheKeys.PRODUCTS;

  // Try cache first (stale-while-revalidate)
  const cached = cache.get(cacheKey);
  if (cached && !params.forceRefresh) {
    return cached;
  }

  const products = db.prepare(`
    SELECT id, name, slug, stock, cost_price, sell_price, type, damaged_stock
    FROM products
    WHERE archived = 0
    ORDER BY name ASC
  `).all();

  // Filter options
  let filtered = products;
  if (params.lowStock) {
    filtered = filtered.filter(p => p.stock < 10);
  }
  if (params.search) {
    const search = params.search.toLowerCase();
    filtered = filtered.filter(p =>
      p.name.toLowerCase().includes(search) ||
      (p.slug && p.slug.toLowerCase().includes(search))
    );
  }

  cache.set(cacheKey, filtered, 300); // 5 min TTL
  return filtered;
}

/**
 * Get customers with caching
 */
async function getCustomers(params = {}) {
  const cacheKey = cacheKeys.CUSTOMERS;
  const cached = cache.get(cacheKey);
  if (cached && !params.forceRefresh) {
    return cached;
  }

  let sql = `
    SELECT id, name, phone, deposit, keg_balance, debt, tier, segment,
           address, last_order_date, created_at
    FROM customers
    WHERE archived = 0
  `;

  const conditions = [];
  const args = [];

  if (params.hasDebt) {
    conditions.push('debt > 0');
  }
  if (params.tier) {
    conditions.push('tier = ?');
    args.push(params.tier);
  }
  if (params.search) {
    conditions.push('(name LIKE ? OR phone LIKE ?)');
    args.push(`%${params.search}%`, `%${params.search}%`);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY name ASC LIMIT 100';

  const customers = db.prepare(sql).all(...args);

  cache.set(cacheKey, customers, 120); // 2 min TTL
  return customers;
}

/**
 * Get dashboard data (all KPIs in single query)
 */
async function getDashboardData(params = {}) {
  const period = params.period || 'today';
  const cacheKey = cacheKeys.DASHBOARD(period);

  const cached = cache.get(cacheKey);
  if (cached && !params.forceRefresh) {
    return cached;
  }

  const data = AnalyticsService.getDashboardSummary(period);

  cache.set(cacheKey, data, 60); // 1 min TTL
  return data;
}

/**
 * Get active promotions
 */
async function getPromotions(params = {}) {
  const cacheKey = cacheKeys.PROMOTIONS;
  const cached = cache.get(cacheKey);
  if (cached && !params.forceRefresh) {
    return cached;
  }

  const today = db.getVietnamDateStr();
  const promotions = db.prepare(`
    SELECT * FROM promotions
    WHERE active = 1
      AND (start_date IS NULL OR start_date <= ?)
      AND (end_date IS NULL OR end_date >= ?)
    ORDER BY priority DESC
  `).all(today, today);

  cache.set(cacheKey, promotions, 300);
  return promotions;
}

/**
 * Get keg stats
 */
async function getKegStats(params = {}) {
  const cacheKey = cacheKeys.KEG_STATS;
  const cached = cache.get(cacheKey);
  if (cached && !params.forceRefresh) {
    return cached;
  }

  const stats = db.prepare(`
    SELECT * FROM keg_stats WHERE id = 1
  `).get();

  cache.set(cacheKey, stats, 60);
  return stats;
}

/**
 * Get single customer with full details
 */
async function getCustomer(params = {}) {
  const { id } = params;
  if (!id) throw new Error('customer id required');

  const cacheKey = cacheKeys.CUSTOMER(id);
  const cached = cache.get(cacheKey);
  if (cached && !params.forceRefresh) {
    return cached;
  }

  const customer = db.prepare(`
    SELECT * FROM customers WHERE id = ? AND archived = 0
  `).get(id);

  if (!customer) return null;

  // Get additional data
  const [debtDetail, prices, recentSales] = await Promise.all([
    DebtService.getCustomerDebt(id),
    db.prepare('SELECT * FROM prices WHERE customer_id = ?').all(id),
    db.prepare(`
      SELECT * FROM sales
      WHERE customer_id = ? AND archived = 0
      ORDER BY date DESC LIMIT 10
    `).all(id)
  ]);

  const fullCustomer = {
    ...customer,
    debtDetail,
    prices,
    recentSales
  };

  cache.set(cacheKey, fullCustomer, 120);
  return fullCustomer;
}

/**
 * Get single sale with items
 */
async function getSale(params = {}) {
  const { id } = params;
  if (!id) throw new Error('sale id required');

  const sale = db.prepare(`
    SELECT s.*, COALESCE(c.name, 'Khách lẻ') as customer_name, c.phone as customer_phone
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.id = ?
  `).get(id);

  if (!sale) return null;

  const items = db.prepare(`
    SELECT * FROM sale_items WHERE sale_id = ?
  `).all(id);

  return { ...sale, items };
}

/**
 * Get all debts summary
 */
async function getDebts(params = {}) {
  return DebtService.getAllDebts(params);
}

/**
 * Get analytics data
 */
async function getAnalytics(params = {}) {
  const { type = 'revenue', period = 'month' } = params;
  const cacheKey = cacheKeys.ANALYTICS(type, period);

  const cached = cache.get(cacheKey);
  if (cached && !params.forceRefresh) {
    return cached;
  }

  let data;

  switch (type) {
    case 'revenue':
      data = getRevenueAnalytics(period);
      break;
    case 'products':
      data = getProductAnalytics(period);
      break;
    case 'customers':
      data = getCustomerAnalytics(period);
      break;
    default:
      data = {};
  }

  cache.set(cacheKey, data, 300);
  return data;
}

function getRevenueAnalytics(period) {
  const dates = getDateRange(period);
  const { startDate, endDate } = dates;

  const daily = db.prepare(`
    SELECT date, SUM(total) as revenue, SUM(profit) as profit
    FROM sales
    WHERE type = 'sale' AND (status IS NULL OR status != 'returned')
      AND date >= ? AND date <= ?
    GROUP BY date
    ORDER BY date ASC
  `).all(startDate, endDate);

  const total = db.prepare(`
    SELECT SUM(total) as revenue, SUM(profit) as profit, COUNT(*) as orders
    FROM sales
    WHERE type = 'sale' AND (status IS NULL OR status != 'returned')
      AND date >= ? AND date <= ?
  `).get(startDate, endDate);

  return { daily, total, period, startDate, endDate };
}

function getProductAnalytics(period) {
  const dates = getDateRange(period);
  const { startDate, endDate } = dates;

  return db.prepare(`
    SELECT p.id, p.name, SUM(si.quantity) as qty, SUM(si.profit) as profit,
           SUM(si.quantity * si.price) as revenue
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    WHERE s.type = 'sale' AND (s.status IS NULL OR s.status != 'returned')
      AND s.date >= ? AND s.date <= ?
    GROUP BY p.id
    ORDER BY qty DESC
    LIMIT 20
  `).all(startDate, endDate);
}

function getCustomerAnalytics(period) {
  const dates = getDateRange(period);
  const { startDate, endDate } = dates;

  return db.prepare(`
    SELECT c.id, c.name, COUNT(s.id) as orders, SUM(s.total) as spent
    FROM customers c
    JOIN sales s ON s.customer_id = c.id
    WHERE s.type = 'sale' AND (s.status IS NULL OR s.status != 'returned')
      AND s.date >= ? AND s.date <= ?
    GROUP BY c.id
    ORDER BY spent DESC
    LIMIT 20
  `).all(startDate, endDate);
}

function getDateRange(period) {
  const today = db.getVietnamDateStr();
  let startDate = today;

  switch (period) {
    case 'week':
      startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      break;
    case 'month':
      const d = new Date();
      startDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
      break;
    case 'year':
      startDate = `${new Date().getFullYear()}-01-01`;
      break;
  }

  return { startDate, endDate: today };
}

// ============================================================
// CACHE INVALIDATION ROUTES
// ============================================================

/**
 * POST /api/cache/invalidate
 * Force cache invalidation
 */
router.post('/cache/invalidate', (req, res) => {
  const { pattern, key } = req.body;

  if (key) {
    cache.delete(key);
  } else if (pattern) {
    cache.invalidatePattern(pattern);
  } else {
    cache.clear();
  }

  res.json({ success: true });
});

module.exports = router;
