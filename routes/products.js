const express = require('express');
const router = express.Router();
const db = require('../database');
const DISTRIBUTOR_NAME = 'Bia Tươi Gia Huy';

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

// GET /products
router.get('/', (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY name').all();
  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sản phẩm</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#1e40af">
  <link rel="stylesheet" href="/css/tailwind.css">
  <link rel="stylesheet" href="/css/unified.css">
</head>
<body class="bg-gray-100 text-gray-800 min-h-screen pb-20">
  <header class="topbar">
    <div class="logo">
      <a href="/" style="color: var(--color-muted);">←</a>
      <span class="logo-text">Sản phẩm</span>
    </div>
  </header>
  <main class="page-enter">
    ${products.map(p => `
      <div class="bg-white p-4 rounded-lg shadow">
        <div class="font-bold">${p.name}</div>
        <div class="text-gray-600">Tồn kho: ${p.stock} | Giá vốn: ${formatVND(p.cost_price || 0)}</div>
      </div>
    `).join('')}
  </div>
  <a href="/" class="block mt-4 text-center text-blue-600">← Quay lại</a>
</body>
</html>
  `);
});

module.exports = router;
