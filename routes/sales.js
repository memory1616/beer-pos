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
  // Returns both product_id (numeric) and product_slug (string) for reliable lookup
  const prices = db.prepare('SELECT customer_id, product_id, product_slug, price FROM prices').all();
  const priceMap = {};
  prices.forEach(p => {
    if (!priceMap[p.customer_id]) priceMap[p.customer_id] = {};
    // Store by numeric id for fast lookup
    priceMap[p.customer_id][p.product_id] = p.price;
    // Also store by slug for slug-based lookup
    if (p.product_slug) {
      if (!priceMap[p.customer_id]._bySlug) priceMap[p.customer_id]._bySlug = {};
      priceMap[p.customer_id]._bySlug[p.product_slug] = p.price;
    }
  });

  res.json({ customers, products, priceMap });
});

module.exports = router;
