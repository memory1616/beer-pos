const express = require('express');
const router = express.Router();
const db = require('../database');
const path = require('path');

const DISTRIBUTOR_NAME = 'Bia Tươi Gia Huy';

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

// GET /sale - Serve HTML file
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../views/sales.html'));
});

// API: Get sales page data
router.get('/data', (req, res) => {
  const customers = db.prepare('SELECT * FROM customers WHERE archived = 0 ORDER BY name').all();
  const products = db.prepare('SELECT * FROM products ORDER BY name').all();
  
  // Get prices for each customer-product combination
  const prices = db.prepare('SELECT * FROM prices').all();
  const priceMap = {};
  prices.forEach(p => {
    if (!priceMap[p.customer_id]) priceMap[p.customer_id] = {};
    priceMap[p.customer_id][p.product_id] = p.price;
  });
  
  res.json({ customers, products, priceMap });
});

module.exports = router;
