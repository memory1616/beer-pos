const express = require('express');
const router = express.Router();
const db = require('../database');
const path = require('path');

const DISTRIBUTOR_NAME = 'Bia Tươi Gia Huy';

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

// GET /purchases - Serve HTML file
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../views/purchases.html'));
});

// API: Get products and purchases data
router.get('/data', (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY name').all();
  const purchases = db.prepare(`
    SELECT p.*, 
      (SELECT GROUP_CONCAT(pi.quantity || 'x ' || pr.name) FROM purchase_items pi JOIN products pr ON pi.product_id = pr.id WHERE pi.purchase_id = p.id) as items_summary
    FROM purchases p 
    ORDER BY p.date DESC
    LIMIT 20
  `).all();
  
  res.json({ products, purchases });
});

module.exports = router;
