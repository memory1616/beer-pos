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

// GET /analytics
router.get('/', (req, res) => {
  // Get analytics data
  const today = new Date().toISOString().split('T')[0];
  
  const todayStats = db.prepare(`
    SELECT 
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit,
      COUNT(*) as orders
    FROM sales WHERE date LIKE ?
  `).get(today + '%');

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  const startOfMonthStr = startOfMonth.toISOString().split('T')[0];
  
  const monthStats = db.prepare(`
    SELECT 
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit 
    FROM sales WHERE date >= ?
  `).get(startOfMonthStr);

  // Get top products
  const topProducts = db.prepare(`
    SELECT p.name, SUM(si.quantity) as qty, SUM(si.quantity * si.price) as revenue
    FROM sale_items si
    JOIN products p ON p.id = si.product_id
    JOIN sales s ON s.id = si.sale_id
    WHERE s.date >= ?
    GROUP BY p.id
    ORDER BY qty DESC
    LIMIT 5
  `).all(startOfMonthStr);

  // Top customers
  const topCustomers = db.prepare(`
    SELECT c.name, SUM(s.total) as revenue, COUNT(*) as orders
    FROM sales s
    JOIN customers c ON c.id = s.customer_id
    WHERE c.archived = 0
    GROUP BY c.id
    ORDER BY revenue DESC
    LIMIT 5
  `).all();

  // Monthly data
  const monthlyRaw = db.prepare(`
    SELECT
      strftime('%Y-%m', date) as month,
      SUM(total) as revenue,
      SUM(profit) as profit
    FROM sales
    WHERE date >= date('now', '-6 months', 'start of month')
    GROUP BY month
    ORDER BY month ASC
  `).all();
  
  const monthlyData = monthlyRaw.map(m => ({
    month: new Date(m.month + '-01').toLocaleDateString('vi-VN', { month: 'short', year: 'numeric' }),
    revenue: m.revenue || 0,
    profit: m.profit || 0
  }));

  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Phân tích</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#f59e0b">
  <meta name="mobile-web-app-capable" content="yes">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <link rel="icon" type="image/png" href="/icon-192.png">
  <link rel="stylesheet" href="/css/tailwind.css">
  <link rel="stylesheet" href="/css/unified.css">
  <script src="/js/dark-mode.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    .animate-fade { animation: fade 0.3s ease-in; }
    @keyframes fade { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .pb-safe { padding-bottom: env(safe-area-inset-bottom, 20px); }
    .pt-safe { padding-top: env(safe-area-inset-top, 20px); }
    .bottomnav { max-width: 500px; margin: auto; left: 0; right: 0; }
    .skeleton { background: linear-gradient(90deg, #e0e0e0 25%, #f0f0f0 50%, #e0e0e0 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
    @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    button { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
  </style>
</head>
<body class="bg-bg text-main min-h-screen pb-24">
  <header class="sticky top-0 bg-card/90 backdrop-blur border-b border-muted shadow-sm z-50 pt-safe">
    <div class="flex items-center justify-between px-4 py-3">
      <div class="flex items-center gap-2">
        <a href="/" class="text-muted">←</a>
        <div class="w-8 h-8 btn btn-primary flex items-center justify-center font-bold">🍺</div>
        <span class="font-bold text-main">${DISTRIBUTOR_NAME}</span>
      </div>
      <div class="text-sm text-muted">Phân tích</div>
    </div>
  </header>

  <main class="p-4 pt-14 pb-24 max-w-md mx-auto animate-fade">
    <!-- Stats -->
    <div class="grid grid-cols-2 gap-4 mb-4">
      <div class="card p-5">
        <div class="text-muted text-sm">💰 Hôm nay</div>
        <div><div class="money text-money"><span class="value text-2xl font-bold tabular-nums">${formatVND(todayStats.revenue)}</span><span class="unit">đ</span></div></div>
      </div>
      <div class="card p-5">
        <div class="text-muted text-sm">📈 Lợi nhuận HT</div>
        <div class="text-2xl font-bold text-success">${formatVND(todayStats.profit)}</div>
      </div>
      <div class="card p-5">
        <div class="text-muted text-sm">🧾 Tháng này</div>
        <div class="text-2xl font-bold text-primary">${formatVND(monthStats.revenue)}</div>
      </div>
    </div>

    <!-- Chart -->
    <div class="card p-5 mb-4">
      <h2 class="font-bold text-lg mb-3">📈 Doanh thu 6 tháng</h2>
      <div class="h-52 w-full">
        <canvas id="revenueChart"></canvas>
      </div>
    </div>

    <!-- Top Products -->
    <div class="card p-5 mb-4">
      <h2 class="font-bold text-lg mb-3">🏆 Top sản phẩm</h2>
      ${topProducts.length > 0 ? topProducts.map((p, i) => `
        <div class="flex justify-between items-center p-2 border-b border-muted">
          <div><span class="font-bold">${i+1}.</span> ${p.name}</div>
          <div class="font-bold">${p.qty} bình</div>
        </div>
      `).join('') : '<div class="text-muted">Chưa có dữ liệu</div>'}
    </div>

    <!-- Top Customers -->
    <div class="card p-5 mb-4">
      <h2 class="font-bold text-lg mb-3">👑 Top khách hàng</h2>
      ${topCustomers.length > 0 ? topCustomers.map((c, i) => `
        <div class="flex justify-between items-center p-2 border-b border-muted">
          <div><span class="font-bold">${i+1}.</span> ${c.name}</div>
          <div class="money text-money"><span class="value font-bold tabular-nums">${formatVND(c.revenue)}</span><span class="unit">đ</span></div>
        </div>
      `).join('') : '<div class="text-muted">Chưa có dữ liệu</div>'}
    </div>
  </main>

  <nav class="bottomnav pb-safe">
    <a href="/">
      <span class="icon">🏠</span>
      <span>Home</span>
    </a>
    <a href="/delivery">
      <span class="icon">🚚</span>
      <span>Giao</span>
    </a>
    <a href="/sale">
      <span class="icon">🍺</span>
      <span>Bán</span>
    </a>
    <a href="/customers">
      <span class="icon">👤</span>
      <span>KH</span>
    </a>
    <a href="/devices">
      <span class="icon">📦</span>
      <span>TB</span>
    </a>
  </nav>

  <script>
    new Chart(document.getElementById('revenueChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(monthlyData.map(d => d.month))},
        datasets: [{
          label: 'Doanh thu',
          data: ${JSON.stringify(monthlyData.map(d => d.revenue))},
          backgroundColor: 'rgba(34, 197, 94, 0.8)',
          borderRadius: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } }
      }
    });
  </script>
  <script src="/js/debug.js"></script>
  <script>
  // Disable service worker in development
  </script>
</body>
</html>
  `);
});

module.exports = router;
