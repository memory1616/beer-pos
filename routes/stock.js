const express = require('express');
const router = express.Router();
const db = require('../database');
const path = require('path');

const DISTRIBUTOR_NAME = 'Bia Tươi Gia Huy';

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

// GET /stock - Serve HTML file
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../views/stock.html'));
});

// API: Get stock page data
router.get('/data', (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY name').all();
  
  // Query purchase history - last 5 purchases, sorted by date descending
  const purchases = db.prepare(`
    SELECT 
      p.id,
      p.date,
      p.total_amount,
      p.note,
      (SELECT COUNT(*) FROM purchase_items WHERE purchase_id = p.id) as item_count
    FROM purchases p
    ORDER BY p.date DESC
    LIMIT 5
  `).all();
  
  res.json({ products, purchases });
});

module.exports = router;
