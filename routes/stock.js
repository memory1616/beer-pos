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

// GET /stock - Serve HTML file
router.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, '../views/stock.html'));
});

// API: Get stock page data
router.get('/data', (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE archived = 0 ORDER BY name').all();
  const totalStockPositive = products.reduce((sum, p) => sum + Math.max(0, Number(p.stock) || 0), 0);

  // Query purchase history - last 5 purchases, sorted by date descending
  const purchases = db.prepare(`
    SELECT 
      p.id,
      p.date,
      p.total_amount,
      p.note,
      (SELECT COUNT(*) FROM purchase_items WHERE purchase_id = p.id) as item_count
    FROM purchases p
    ORDER BY datetime(p.date) DESC
    LIMIT 5
  `).all();
  
  // Device statistics
  const deviceStats = db.prepare(`
    SELECT 
      SUM(CASE WHEN type = 'horizontal' THEN 1 ELSE 0 END) as total_horizontal,
      SUM(CASE WHEN type = 'vertical' THEN 1 ELSE 0 END) as total_vertical,
      SUM(CASE WHEN type = 'horizontal' AND status = 'available' THEN 1 ELSE 0 END) as available_horizontal,
      SUM(CASE WHEN type = 'horizontal' AND status = 'in_use' THEN 1 ELSE 0 END) as in_use_horizontal,
      SUM(CASE WHEN type = 'vertical' AND status = 'available' THEN 1 ELSE 0 END) as available_vertical,
      SUM(CASE WHEN type = 'vertical' AND status = 'in_use' THEN 1 ELSE 0 END) as in_use_vertical
    FROM devices
  `).get();
  
  res.json({ products, purchases, deviceStats, totalStockPositive });
});

module.exports = router;
