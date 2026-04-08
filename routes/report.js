// ============================================================
// BeerPOS Report Routes - Simple & Clean
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');

function formatVND(amount) {
  if (amount === null || amount === undefined || amount === '') return '0 đ';
  const num = Number(amount);
  if (isNaN(num)) return '0 đ';
  return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
}

// GET /report — Simple Report Page
router.get('/', (req, res) => {
  res.sendFile(__dirname + '/../views/report.html');
});

// API: Get report data for simple report
router.get('/data', (req, res) => {
  const type = req.query.type || 'month';
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year) || new Date().getFullYear();

  let startDate, endDate;

  if (type === 'month') {
    const lastDay = new Date(year, month, 0).getDate();
    startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  } else if (type === 'year') {
    startDate = `${year}-01-01`;
    endDate = `${year}-12-31`;
  } else {
    // all — no filter
    startDate = '1970-01-01';
    endDate = '2100-12-31';
  }

  console.log('[REPORT] Loading:', type, startDate, '->', endDate);

  // Get sales with items (join customers for name)
  const sales = db.prepare(`
    SELECT s.id, s.date, s.total, s.profit, s.customer_id, c.name as customer_name
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE date(datetime(s.date, '+7 hours')) >= date(?) AND date(datetime(s.date, '+7 hours')) <= date(?)
      AND (s.status IS NULL OR s.status != 'returned')
    ORDER BY s.date DESC
  `).all(startDate, endDate);

  // Get sale items with product names
  const saleIds = sales.map(s => s.id);
  let saleItems = [];

  if (saleIds.length > 0) {
    const placeholders = saleIds.map(() => '?').join(',');
    // Join with products to get product_name
    saleItems = db.prepare(`
      SELECT si.sale_id, p.name as product_name, si.quantity, si.profit
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      WHERE si.sale_id IN (${placeholders})
    `).all(...saleIds);
  }

  // Attach items to sales
  const salesWithItems = sales.map(sale => ({
    ...sale,
    items: saleItems.filter(item => item.sale_id === sale.id)
  }));

  // Get expenses
  const expenses = db.prepare(`
    SELECT amount FROM expenses
    WHERE date(date, '+7 hours') >= date(?) AND date(date, '+7 hours') <= date(?)
  `).all(startDate, endDate);

  res.json({
    sales: salesWithItems,
    expenses: expenses,
    filter: { type, month, year, startDate, endDate }
  });
});

module.exports = router;