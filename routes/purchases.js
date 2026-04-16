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

// GET /purchases - Serve HTML file
router.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, '../views/purchases.html'));
});

// API: Get products and purchases data (exclude archived)
router.get('/data', (req, res) => {
  const products = db.prepare('SELECT id, slug, name, stock, cost_price, sell_price, type, damaged_stock FROM products WHERE archived = 0 ORDER BY name').all();
  const purchases = db.prepare(`
    SELECT p.*,
      (SELECT GROUP_CONCAT(pi.quantity || 'x ' || pr.name) FROM purchase_items pi JOIN products pr ON pi.product_id = pr.id WHERE pi.purchase_id = p.id) as items_summary,
      (SELECT COUNT(*) FROM purchase_items WHERE purchase_id = p.id) as item_count
    FROM purchases p
    WHERE p.archived = 0
    ORDER BY p.date DESC
    LIMIT 50
  `).all();

  res.json({ products, purchases });
});

module.exports = router;
