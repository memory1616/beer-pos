const express = require('express');
const router = express.Router();
const db = require('../database');
const DISTRIBUTOR_NAME = 'Bia Tươi Gia Huy';

function formatVND(amount) {
  if (amount === null || amount === undefined || amount === '') return '0 đ';
  const num = Number(amount);
  if (isNaN(num)) return '0 đ';
  return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
}

// GET /products
router.get('/', (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE archived = 0 ORDER BY name').all();
  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Sản phẩm</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#f59e0b">
  <meta name="mobile-web-app-capable" content="yes">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <link rel="icon" type="image/png" href="/icon-192.png">
  <link rel="stylesheet" href="/css/tailwind.css">
  <link rel="stylesheet" href="/css/unified.css">
  <script src="/js/dark-mode.js"></script>
</head>
<body class="bg-bg text-main min-h-screen pb-20">
  <header class="topbar">
    <div class="logo">
      <a href="/" style="color: var(--color-muted);">←</a>
      <span class="logo-text">Sản phẩm</span>
    </div>
  </header>
  <main class="page-enter">
    ${products.map(p => `
      <div class="card p-4">
        <div class="font-bold text-main">${p.name}</div>
        <div class="text-muted">Tồn kho: ${p.stock} | Giá vốn: ${formatVND(p.cost_price || 0)}</div>
      </div>
    `).join('')}
  </div>
  <a href="/" class="block mt-4 text-center text-info">← Quay lại</a>
</body>
</html>
  `);
});

module.exports = router;
