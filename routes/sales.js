const express = require('express');
const router = express.Router();
const db = require('../database');
const path = require('path');
const logger = require('../src/utils/logger');

const DISTRIBUTOR_NAME = 'Bia Tươi Gia Huy';

function formatVND(amount) {
  if (amount === null || amount === undefined || amount === '') return '0 đ';
  const num = Number(amount);
  if (isNaN(num)) return '0 đ';
  return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
}

// GET /sale - Serve HTML file
router.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, '../views/sales.html'));
});

// API: Get sales page data
router.get('/data', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  const customers = db.prepare('SELECT * FROM customers WHERE archived = 0 ORDER BY name').all();
  const products = db.prepare('SELECT id, slug, name, stock, cost_price, sell_price, type, damaged_stock FROM products ORDER BY name').all();

  // Get prices for each customer-product combination
  const prices = db.prepare('SELECT customer_id, product_id, product_slug, price FROM prices').all();
  const priceMap = {};
  prices.forEach(p => {
    if (!priceMap[p.customer_id]) priceMap[p.customer_id] = {};
    priceMap[p.customer_id][p.product_id] = p.price;
    if (p.product_slug) {
      if (!priceMap[p.customer_id]._bySlug) priceMap[p.customer_id]._bySlug = {};
      priceMap[p.customer_id]._bySlug[p.product_slug] = p.price;
    }
  });

  res.json({ customers, products, priceMap });
});

// API: Get recent sales history (for POS page)
router.get('/history', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 5;
  const offset = (page - 1) * limit;

  const year = req.query.year ? parseInt(req.query.year) : null;
  const month = req.query.month ? parseInt(req.query.month) : null;

  let whereClause = "WHERE s.type IN ('sale', 'replacement', 'damage_return')";
  let params = [];

  if (year && month) {
    const yStr = String(year);
    const mStr = String(month).padStart(2, '0');
    whereClause += " AND strftime('%Y-%m', s.date) = ?";
    params.push(yStr + '-' + mStr);
  }

  const countRow = db.prepare(`SELECT COUNT(*) as count FROM sales s ${whereClause}`).get(...params);
  const total = countRow.count;
  const totalPages = Math.ceil(total / limit);

  const sales = db.prepare(`
    SELECT s.id, s.date, s.total, s.type, s.status,
      COALESCE(c.name, 'Khách lẻ') as customer_name,
      s.deliver_kegs, s.return_kegs
    FROM sales s
    LEFT JOIN customers c ON s.customer_id = c.id
    ${whereClause}
    ORDER BY datetime(s.date) DESC, s.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const salesWithItems = sales.map(s => {
    const items = db.prepare(`
      SELECT si.quantity, si.price, p.name as product_name, p.type
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = ?
    `).all(s.id);
    return { ...s, items };
  });

  res.json({ sales: salesWithItems, total, page, totalPages });
});

// API: Get single sale detail
router.get('/:id', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const sale = db.prepare(`
    SELECT s.*, COALESCE(c.name, 'Khách lẻ') as customer_name,
      c.keg_balance as customer_keg_balance
    FROM sales s
    LEFT JOIN customers c ON s.customer_id = c.id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Not found' });

  const items = db.prepare(`
    SELECT si.id, si.product_id, si.quantity, si.price, si.cost_price, si.profit, si.product_slug,
      p.name as product_name, p.slug, p.type
    FROM sale_items si
    JOIN products p ON p.id = si.product_id
    WHERE si.sale_id = ?
  `).all(req.params.id);

  res.json({ sale: { ...sale, items } });
});

// POST /sale/create → forward to /api/sales
router.post('/create', (req, res) => {
  logger.info(`[sales-route] POST /create → forwarding to /api/sales`);
  req.url = '/';  // root of api/sales router
  require('./api/sales')(req, res, () => {
    logger.warn(`[sales-route] api/sales POST / returned 404`);
    res.status(404).json({ error: 'Not found in api/sales' });
  });
});

// PUT /sale/update/:id → forward to /api/sales/:id
router.put('/update/:id', (req, res) => {
  logger.info(`[sales-route] PUT /update/${req.params.id} → forwarding to /api/sales`);
  req.url = req.params.id;   // strip leading slash: Express strips mount prefix anyway
  require('./api/sales')(req, res, () => {
    logger.warn(`[sales-route] api/sales returned 404 for id=${req.params.id}`);
    res.status(404).json({ error: 'Not found in api/sales' });
  });
});

module.exports = router;
