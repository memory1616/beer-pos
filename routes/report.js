const express = require('express');
const router = express.Router();
const db = require('../database');

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

function getDateRange(period) {
  const now = new Date();
  let startDate, endDate;
  
  // Sử dụng local date thay vì UTC
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const today = `${year}-${month}-${day}`;
  
  endDate = today + ' 23:59:59';
  
  if (period === 'today') {
    startDate = today + ' 00:00:00';
  } else if (period === 'yesterday') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const y = yesterday.getFullYear();
    const m = String(yesterday.getMonth() + 1).padStart(2, '0');
    const d = String(yesterday.getDate()).padStart(2, '0');
    startDate = `${y}-${m}-${d} 00:00:00`;
    endDate = `${y}-${m}-${d} 23:59:59`;
  } else if (period === 'week') {
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const y = weekAgo.getFullYear();
    const m = String(weekAgo.getMonth() + 1).padStart(2, '0');
    const d = String(weekAgo.getDate()).padStart(2, '0');
    startDate = `${y}-${m}-${d} 00:00:00`;
  } else if (period === 'thisMonth') {
    // Tháng này - từ ngày 1 đến hôm nay
    startDate = `${year}-${month}-01 00:00:00`;
  } else if (period === 'lastMonth') {
    // Tháng trước - full month
    const lastMonth = new Date(now);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const y = lastMonth.getFullYear();
    const m = String(lastMonth.getMonth() + 1).padStart(2, '0');
    const lastMonthDays = new Date(y, lastMonth.getMonth() + 1, 0).getDate();
    startDate = `${y}-${m}-01 00:00:00`;
    endDate = `${y}-${m}-${lastMonthDays} 23:59:59`;
  } else {
    // Default: tháng này
    startDate = `${year}-${month}-01 00:00:00`;
  }
  
  return { startDate, endDate };
}

// GET /report
router.get('/', (req, res) => {
  try {
  const period = req.query.period || 'thisMonth';
  const { startDate, endDate } = getDateRange(period);
  
  // Revenue & Profit by period - use subquery to avoid duplicate counting
  const periodStats = db.prepare(`
    SELECT 
      (SELECT COALESCE(SUM(total), 0) FROM sales WHERE date >= ? AND date <= ?) as revenue,
      (SELECT COALESCE(SUM(profit), 0) FROM sales WHERE date >= ? AND date <= ?) as profit,
      (SELECT COUNT(*) FROM sales WHERE date >= ? AND date <= ?) as order_count,
      COALESCE(SUM(si.quantity), 0) as total_quantity
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id AND s.date >= ? AND s.date <= ?
  `).get(startDate, endDate, startDate, endDate, startDate, endDate, startDate, endDate);
  
  // Daily stats for the period (last 7 days or 30 days)
  const dailyStats = db.prepare(`
    SELECT 
      s.date,
      COALESCE(SUM(s.total), 0) as revenue,
      COALESCE(SUM(s.profit), 0) as profit,
      COALESCE(SUM(si.quantity), 0) as quantity
    FROM sales s
    LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE s.date >= ? AND s.date <= ?
    GROUP BY s.date
    ORDER BY s.date DESC
    LIMIT 30
  `).all(startDate, endDate);
  
  // Top customers by revenue - use subquery to avoid duplicate counting
  const topCustomers = db.prepare(`
    SELECT 
      c.id,
      c.name,
      (SELECT COALESCE(SUM(s2.total), 0) FROM sales s2 WHERE s2.customer_id = c.id AND s2.date >= ? AND s2.date <= ?) as revenue,
      (SELECT COALESCE(SUM(si2.quantity), 0) FROM sale_items si2 JOIN sales s3 ON s3.id = si2.sale_id AND s3.customer_id = c.id AND s3.date >= ? AND s3.date <= ?) as quantity,
      (SELECT COUNT(*) FROM sales s2 WHERE s2.customer_id = c.id AND s2.date >= ? AND s2.date <= ?) as order_count
    FROM customers c
    WHERE (SELECT SUM(s2.total) FROM sales s2 WHERE s2.customer_id = c.id AND s2.date >= ? AND s2.date <= ?) > 0
    ORDER BY revenue DESC
    LIMIT 3
  `).all(startDate, endDate, startDate, endDate, startDate, endDate, startDate, endDate);
  
  // Top products by quantity sold
  const topProducts = db.prepare(`
    SELECT 
      p.id,
      p.name,
      COALESCE(SUM(si.quantity), 0) as quantity_sold,
      COALESCE(SUM(si.quantity * si.price), 0) as revenue
    FROM products p
    JOIN sale_items si ON si.product_id = p.id
    JOIN sales s ON s.id = si.sale_id
    WHERE s.date >= ? AND s.date <= ?
    GROUP BY p.id
    ORDER BY quantity_sold DESC
    LIMIT 10
  `).all(startDate, endDate);
  
  // All time stats - use subquery to avoid duplicate counting
  const allTimeStats = db.prepare(`
    SELECT 
      (SELECT COALESCE(SUM(total), 0) FROM sales) as revenue,
      (SELECT COALESCE(SUM(profit), 0) FROM sales) as profit,
      (SELECT COUNT(*) FROM sales) as order_count,
      COALESCE(SUM(si.quantity), 0) as total_quantity
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
  `).get();
  
  // Recent sales with pagination
  const now = new Date();
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 5;
  const offset = (page - 1) * limit;
  
  let salesQuery = `
    SELECT s.id, s.customer_id, s.date, s.total, s.profit, s.type, s.deliver_kegs, s.return_kegs, c.name as customer_name,
      (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id) as quantity
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
  `;
  
  let countQuery = `SELECT COUNT(*) as total FROM sales s`;
  let params = [];
  let whereClause = '';
  
  // Filter by period
  if (period === 'thisMonth') {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    whereClause = ` WHERE strftime('%Y-%m', s.date) = '${year}-${month}'`;
  } else if (period === 'lastMonth') {
    const lastMonth = new Date(now);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const y = lastMonth.getFullYear();
    const m = String(lastMonth.getMonth() + 1).padStart(2, '0');
    whereClause = ` WHERE strftime('%Y-%m', s.date) = '${y}-${m}'`;
  } else if (period === 'today') {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    whereClause = ` WHERE date(s.date) = '${year}-${month}-${day}'`;
  } else if (period === 'yesterday') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const y = yesterday.getFullYear();
    const m = String(yesterday.getMonth() + 1).padStart(2, '0');
    const d = String(yesterday.getDate()).padStart(2, '0');
    whereClause = ` WHERE date(s.date) = '${y}-${m}-${d}'`;
  }
  
  countQuery += whereClause;
  salesQuery += whereClause;
  
  const total = db.prepare(countQuery).get().total;
  const totalPages = Math.ceil(total / limit);
  
  salesQuery += ` ORDER BY s.date DESC, s.id DESC LIMIT ${limit} OFFSET ${offset}`;
  
  const recentSales = db.prepare(salesQuery).all();
  
  const periodLabel = {
    'today': 'Hôm nay',
    'yesterday': 'Hôm qua',
    'week': '7 ngày',
    'thisMonth': 'Tháng này',
    'lastMonth': 'Tháng trước'
  }[period] || 'Tháng này';
  
  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Báo cáo - Beer POS</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#f59e0b">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <link rel="stylesheet" href="/css/tailwind.css">
  <script src="/js/auth.js"></script>
  <link rel="stylesheet" href="/css/unified.css">
  <script src="/js/layout.js"></script>
  <style>
    .animate-fade { animation: fade 0.25s ease-out; }
    @keyframes fade { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .bottom-nav { max-width: 500px; margin: auto; left: 0; right: 0; }
    button, a { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    button:active { transform: scale(0.96); }
  </style>
</head>
<body class="bg-gray-100 text-gray-800 min-h-screen pb-20">
  <!-- TOP BAR -->
  <header class="sticky top-0 bg-white border-b z-50">
    <div class="flex items-center justify-between px-4 h-12 max-w-md mx-auto">
      <div class="flex items-center gap-2">
        <span class="text-xl">📊</span>
        <span class="font-semibold text-sm">Báo cáo</span>
      </div>
      <div class="flex gap-3 text-xl">
        <a href="/" class="text-gray-500 hover:bg-gray-100 px-2 rounded">🏠</a>
      </div>
    </div>
  </header>

  <main class="p-4 pb-24 max-w-md mx-auto animate-fade">
    <!-- Quick Report Links -->
    <div class="mb-4">
      <div class="grid grid-cols-3 gap-2">
        <a href="/report/profit-product" class="card text-center py-3 bg-purple-50 border-purple-200">
          <div class="text-xl mb-1">📦</div>
          <div class="text-xs font-medium">Lợi nhuận<br>sản phẩm</div>
        </a>
        <a href="/report/profit-customer" class="card text-center py-3 bg-blue-50 border-blue-200">
          <div class="text-xl mb-1">👥</div>
          <div class="text-xs font-medium">Lợi nhuận<br>khách hàng</div>
        </a>
        <a href="/report/cashflow" class="card text-center py-3 bg-amber-50 border-green-200">
          <div class="text-xl mb-1">💰</div>
          <div class="text-xs font-medium">Dòng tiền</div>
        </a>
      </div>
    </div>

    <!-- Period Selector -->
    <div class="mb-4">
      <div class="flex gap-2 overflow-x-auto pb-2">
        <a href="/report?period=today" class="px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${period === 'today' ? 'bg-amber-600 text-white' : 'bg-white border'}">Hôm nay</a>
        <a href="/report?period=yesterday" class="px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${period === 'yesterday' ? 'bg-amber-600 text-white' : 'bg-white border'}">Hôm qua</a>
        <a href="/report?period=week" class="px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${period === 'week' ? 'bg-amber-600 text-white' : 'bg-white border'}">7 ngày</a>
        <a href="/report?period=thisMonth" class="px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${period === 'thisMonth' ? 'bg-amber-600 text-white' : 'bg-white border'}">Tháng này</a>
        <a href="/report?period=lastMonth" class="px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${period === 'lastMonth' ? 'bg-amber-600 text-white' : 'bg-white border'}">Tháng trước</a>
      </div>
    </div>

    <!-- Period Stats -->
    <div class="mb-4">
      <div class="section-title">${periodLabel}</div>
      <div class="grid grid-cols-2 gap-3">
        <div class="card">
          <div class="text-xs text-gray-500">Doanh thu</div>
          <div class="text-xl font-bold text-amber-600">${formatVND(periodStats.revenue)}</div>
        </div>
        <div class="card">
          <div class="text-xs text-gray-500">Lợi nhuận</div>
          <div class="text-xl font-bold text-blue-600">${formatVND(periodStats.profit)}</div>
        </div>
        <div class="card">
          <div class="text-xs text-gray-500">Đơn hàng</div>
          <div class="text-xl font-bold">${periodStats.order_count}</div>
        </div>
        <div class="card">
          <div class="text-xs text-gray-500">Sản phẩm</div>
          <div class="text-xl font-bold text-orange-600">${periodStats.total_quantity}</div>
        </div>
      </div>
    </div>

    <!-- All Time Stats -->
    <div class="mb-4">
      <div class="section-title">Tất cả thời gian</div>
      <div class="card bg-gradient-to-r from-green-500 to-green-600 text-white">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <div class="text-xs opacity-80">Doanh thu</div>
            <div class="text-lg font-bold">${formatVND(allTimeStats.revenue)}</div>
          </div>
          <div>
            <div class="text-xs opacity-80">Lợi nhuận</div>
            <div class="text-lg font-bold">${formatVND(allTimeStats.profit)}</div>
          </div>
          <div>
            <div class="text-xs opacity-80">Đơn hàng</div>
            <div class="text-lg font-bold">${allTimeStats.order_count}</div>
          </div>
          <div>
            <div class="text-xs opacity-80">Sản phẩm</div>
            <div class="text-lg font-bold">${allTimeStats.total_quantity}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Top Customers -->
    <div class="mb-4">
      <div class="section-title">🏆 Top khách hàng</div>
      <div class="space-y-2">
        ${topCustomers.length === 0 ? '<div class="text-gray-500 text-center py-4">Chưa có dữ liệu</div>' : topCustomers.map((c, i) => `
          <div class="card flex justify-between items-center">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${i === 0 ? 'bg-yellow-400 text-yellow-900' : i === 1 ? 'bg-gray-300 text-gray-700' : i === 2 ? 'bg-orange-300 text-orange-900' : 'bg-gray-100 text-gray-600'}">${i + 1}</div>
              <div>
                <div class="font-bold text-sm">${c.name}</div>
                <div class="text-xs text-gray-500">${c.order_count} đơn • ${c.quantity} sản phẩm</div>
              </div>
            </div>
            <div class="text-right">
              <div class="font-bold text-amber-600">${formatVND(c.revenue)}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Top Products -->
    <div class="mb-4">
      <div class="section-title">🍺 Top sản phẩm bán chạy</div>
      <div class="space-y-2">
        ${topProducts.length === 0 ? '<div class="text-gray-500 text-center py-4">Chưa có dữ liệu</div>' : topProducts.map((p, i) => `
          <div class="card flex justify-between items-center">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${i === 0 ? 'bg-yellow-400 text-yellow-900' : i === 1 ? 'bg-gray-300 text-gray-700' : i === 2 ? 'bg-orange-300 text-orange-900' : 'bg-gray-100 text-gray-600'}">${i + 1}</div>
              <div>
                <div class="font-bold text-sm">${p.name}</div>
                <div class="text-xs text-gray-500">Doanh thu: ${formatVND(p.revenue)}</div>
              </div>
            </div>
            <div class="text-right">
              <div class="font-bold text-orange-600">${p.quantity_sold}</div>
              <div class="text-xs text-gray-500">sản phẩm</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Recent Sales -->
    <div class="mb-4">
      <div class="section-title">📋 Đơn hàng gần đây <span class="text-xs font-normal text-gray-500">(${total} đơn)</span></div>
      <div class="space-y-1" id="recentSalesList">
        ${recentSales.length === 0 ? '<div class="text-gray-500 text-center py-4">Chưa có đơn hàng</div>' : recentSales.map(s => {
          const date = new Date(s.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
          const hasKegUpdate = (s.deliver_kegs || 0) > 0 || (s.return_kegs || 0) > 0;
          
          let typeBadge = '';
          let totalDisplay = '';
          let rowClass = '';
          
          if (s.type === 'replacement') {
            typeBadge = '<span class="bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded text-xs">🔁 Đổi lỗi</span>';
            totalDisplay = '<span class="font-bold text-orange-600">0 đ</span>';
            rowClass = 'bg-orange-50';
          } else {
            totalDisplay = '<span class="font-bold text-amber-600">' + formatVND(s.total) + '</span>';
          }
          
          return '<div class="flex justify-between items-center p-2 border-b ' + rowClass + '">' +
            '<div>' +
              '<div class="font-medium">#' + s.id + ' - ' + (s.customer_name || 'Khách lẻ') + ' ' + typeBadge + '</div>' +
              '<div class="text-xs text-gray-500">' + date + (hasKegUpdate ? ' • 📦' : '') + '</div>' +
            '</div>' +
            '<div class="text-right">' +
              totalDisplay +
              (s.type !== 'replacement' ? '<div class="text-xs ' + (s.profit > 0 ? 'text-blue-600' : 'text-red-500') + '">+' + formatVND(s.profit) + '</div>' : '') +
            '</div>' +
          '</div>';
        }).join('')}
        ${totalPages > 1 ? '<div class="flex justify-center items-center gap-2 mt-3 py-2" id="salesPagination">' +
          '<button onclick="loadReportSales(' + (page - 1) + ')" ' + (page === 1 ? 'disabled' : '') + ' ' + 'class="px-3 py-1 rounded ' + (page === 1 ? 'bg-gray-200 text-gray-400' : 'bg-gray-200 text-gray-700 hover:bg-gray-300') + '">‹</button>' +
          '<span class="text-sm text-gray-600">Trang ' + page + '/' + totalPages + '</span>' +
          '<button onclick="loadReportSales(' + (page + 1) + ')" ' + (page === totalPages ? 'disabled' : '') + ' ' + 'class="px-3 py-1 rounded ' + (page === totalPages ? 'bg-gray-200 text-gray-400' : 'bg-gray-200 text-gray-700 hover:bg-gray-300') + '">›</button>' +
        '</div>' : ''}
      </div>
    </div>

    <script>
      const currentPeriod = '${period}';
      const reportSalesPagination = { page: ${page}, totalPages: ${totalPages}, total: ${total} };
      
      function formatVND(amount) {
        return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
      }
      
      async function loadReportSales(newPage) {
        if (newPage < 1 || newPage > reportSalesPagination.totalPages) return;
        
        const res = await fetch('/report/sales?page=' + newPage + '&period=' + currentPeriod);
        const data = await res.json();
        
        reportSalesPagination.page = data.page;
        reportSalesPagination.totalPages = data.totalPages;
        reportSalesPagination.total = data.total;
        
        const container = document.getElementById('recentSalesList');
        if (data.sales.length === 0) {
          container.innerHTML = '<div class="text-gray-500 text-center py-4">Chưa có đơn hàng</div>';
          return;
        }
        
        let html = data.sales.map(s => {
          const date = new Date(s.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
          const hasKegUpdate = (s.deliver_kegs || 0) > 0 || (s.return_kegs || 0) > 0;
          
          let typeBadge = '';
          let totalDisplay = '';
          let rowClass = '';
          
          if (s.type === 'replacement') {
            typeBadge = '<span class="bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded text-xs">🔁 Đổi lỗi</span>';
            totalDisplay = '<span class="font-bold text-orange-600">0 đ</span>';
            rowClass = 'bg-orange-50';
          } else {
            totalDisplay = '<span class="font-bold text-amber-600">' + formatVND(s.total) + '</span>';
          }
          
          return '<div class="flex justify-between items-center p-2 border-b ' + rowClass + '">' +
            '<div>' +
              '<div class="font-medium">#' + s.id + ' - ' + (s.customer_name || 'Khách lẻ') + ' ' + typeBadge + '</div>' +
              '<div class="text-xs text-gray-500">' + date + (hasKegUpdate ? ' • 📦' : '') + '</div>' +
            '</div>' +
            '<div class="text-right">' +
              totalDisplay +
              (s.type !== 'replacement' ? '<div class="text-xs ' + (s.profit > 0 ? 'text-blue-600' : 'text-red-500') + '">+' + formatVND(s.profit) + '</div>' : '') +
            '</div>' +
          '</div>';
        }).join('');
        
        if (reportSalesPagination.totalPages > 1) {
          html += '<div class="flex justify-center items-center gap-2 mt-3 py-2" id="salesPagination">' +
            '<button onclick="loadReportSales(' + (reportSalesPagination.page - 1) + ')" ' + (reportSalesPagination.page === 1 ? 'disabled' : '') + ' ' + 'class="px-3 py-1 rounded ' + (reportSalesPagination.page === 1 ? 'bg-gray-200 text-gray-400' : 'bg-gray-200 text-gray-700 hover:bg-gray-300') + '">‹</button>' +
            '<span class="text-sm text-gray-600">Trang ' + reportSalesPagination.page + '/' + reportSalesPagination.totalPages + '</span>' +
            '<button onclick="loadReportSales(' + (reportSalesPagination.page + 1) + ')" ' + (reportSalesPagination.page === reportSalesPagination.totalPages ? 'disabled' : '') + ' ' + 'class="px-3 py-1 rounded ' + (reportSalesPagination.page === reportSalesPagination.totalPages ? 'bg-gray-200 text-gray-400' : 'bg-gray-200 text-gray-700 hover:bg-gray-300') + '">›</button>' +
          '</div>';
        }
        
        container.innerHTML = html;
      }
    </script>
  </main>

  <!-- Bottom Navigation -->
  <nav class="bottomnav fixed bottom-0 left-0 right-0">
    <a href="/" class="py-3">
      <div class="text-xl">🏠</div>
      <div class="text-xs">Home</div>
    </a>
    <a href="/delivery" class="py-3">
      <div class="text-xl">🚚</div>
      <div class="text-xs">Giao</div>
    </a>
    <a href="/sale" class="py-3">
      <div class="text-xl">🍺</div>
      <div class="text-xs">Bán hàng</div>
    </a>
    <a href="/customers" class="py-3">
      <div class="text-xl">👤</div>
      <div class="text-xs">Khách</div>
    </a>
    <a href="/report" class="py-3 active">
      <div class="text-xl">📊</div>
      <div class="text-xs">Báo cáo</div>
    </a>
  </nav>

  <script>
    if (!isLoggedIn()) { window.location.href = '/login'; }
  </script>
</body>
</html>
  `);
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: Sales for report with pagination
router.get('/sales', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 5;
  const offset = (page - 1) * limit;
  const period = req.query.period || 'thisMonth';
  
  const now = new Date();
  
  let salesQuery = `
    SELECT s.id, s.customer_id, s.date, s.total, s.profit, s.type, s.deliver_kegs, s.return_kegs, c.name as customer_name,
      (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id) as quantity
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
  `;
  
  let countQuery = `SELECT COUNT(*) as total FROM sales s`;
  let whereClause = '';
  
  if (period === 'thisMonth') {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    whereClause = ` WHERE strftime('%Y-%m', s.date) = '${year}-${month}'`;
  } else if (period === 'lastMonth') {
    const lastMonth = new Date(now);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const y = lastMonth.getFullYear();
    const m = String(lastMonth.getMonth() + 1).padStart(2, '0');
    whereClause = ` WHERE strftime('%Y-%m', s.date) = '${y}-${m}'`;
  } else if (period === 'today') {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    whereClause = ` WHERE date(s.date) = '${year}-${month}-${day}'`;
  } else if (period === 'yesterday') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const y = yesterday.getFullYear();
    const m = String(yesterday.getMonth() + 1).padStart(2, '0');
    const d = String(yesterday.getDate()).padStart(2, '0');
    whereClause = ` WHERE date(s.date) = '${y}-${m}-${d}'`;
  }
  
  countQuery += whereClause;
  salesQuery += whereClause;
  
  const total = db.prepare(countQuery).get().total;
  const totalPages = Math.ceil(total / limit);
  
  salesQuery += ` ORDER BY s.date DESC, s.id DESC LIMIT ${limit} OFFSET ${offset}`;
  
  const sales = db.prepare(salesQuery).all();
  
  res.json({ sales, total, page, limit, totalPages });
});

// GET /report/profit-product - Báo cáo lợi nhuận theo sản phẩm
router.get('/profit-product', (req, res) => {
  const { startDate, endDate } = req.query;
  
  let query = `
    SELECT 
      p.id,
      p.name,
      p.type,
      SUM(si.quantity) as total_qty,
      SUM(si.quantity * si.price) as revenue,
      SUM(si.quantity * si.cost_price) as cost,
      SUM(si.profit) as profit
    FROM sale_items si
    JOIN products p ON p.id = si.product_id
    JOIN sales s ON s.id = si.sale_id
  `;
  
  const params = [];
  if (startDate && endDate) {
    query += ` WHERE s.date >= ? AND s.date <= ?`;
    params.push(startDate + ' 00:00:00', endDate + ' 23:59:59');
  }
  
  query += ` GROUP BY p.id ORDER BY profit DESC`;
  
  const products = db.prepare(query).all(...params);
  
  const totalRevenue = products.reduce((sum, r) => sum + (r.revenue || 0), 0);
  const totalCost = products.reduce((sum, r) => sum + (r.cost || 0), 0);
  const totalProfit = products.reduce((sum, r) => sum + (r.profit || 0), 0);
  
  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lợi nhuận theo sản phẩm - Beer POS</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#f59e0b">
  <link rel="stylesheet" href="/css/tailwind.css">
  <script src="/js/auth.js"></script>
  <style>
    .bottom-nav { max-width: 500px; margin: auto; }
  </style>
</head>
<body class="bg-gray-100 text-gray-800 min-h-screen pb-20">
  <header class="sticky top-0 bg-white border-b z-50">
    <div class="flex items-center justify-between px-4 h-12 max-w-md mx-auto">
      <div class="flex items-center gap-2">
        <a href="/report" class="text-gray-500">←</a>
        <span class="font-semibold text-sm">Lợi nhuận sản phẩm</span>
      </div>
    </div>
  </header>
  <main class="p-4 pb-24 max-w-md mx-auto">
    <div class="card bg-gradient-to-r from-purple-500 to-purple-600 text-white mb-4">
      <div class="grid grid-cols-3 gap-2 text-center">
        <div>
          <div class="text-xs opacity-80">Doanh thu</div>
          <div class="font-bold">${formatVND(totalRevenue)}</div>
        </div>
        <div>
          <div class="text-xs opacity-80">Chi phí</div>
          <div class="font-bold">${formatVND(totalCost)}</div>
        </div>
        <div>
          <div class="text-xs opacity-80">Lợi nhuận</div>
          <div class="font-bold">${formatVND(totalProfit)}</div>
        </div>
      </div>
    </div>
    <div class="space-y-2">
      ${products.length === 0 ? '<div class="text-gray-500 text-center py-4">Chưa có dữ liệu</div>' : products.map((p, i) => `
        <div class="card">
          <div class="flex justify-between items-center">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${i === 0 ? 'bg-yellow-400 text-yellow-900' : i === 1 ? 'bg-gray-300 text-gray-700' : i === 2 ? 'bg-orange-300 text-orange-900' : 'bg-gray-100 text-gray-600'}">${i + 1}</div>
              <div>
                <div class="font-bold">${p.name}</div>
                <div class="text-xs text-gray-500">${p.total_qty} sản phẩm</div>
              </div>
            </div>
            <div class="text-right">
              <div class="font-bold text-purple-600">${formatVND(p.profit || 0)}</div>
              <div class="text-xs text-gray-500">${((p.profit || 0) / (p.revenue || 1) * 100).toFixed(1)}%</div>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  </main>
  <div id="bottomNavContainer"></div>
  <script>if (!isLoggedIn()) { window.location.href = '/login'; }</script>
  <script>
    const bottomNav = getBottomNav('/report');
    document.getElementById('bottomNavContainer').innerHTML = bottomNav;
  </script>
</body>
</html>
  `);
});

// GET /report/profit-customer - Báo cáo lợi nhuận theo khách hàng
router.get('/profit-customer', (req, res) => {
  const { startDate, endDate } = req.query;
  
  let query = `
    SELECT 
      c.id,
      c.name,
      COUNT(s.id) as total_orders,
      SUM(s.total) as revenue,
      SUM(s.profit) as profit
    FROM sales s
    JOIN customers c ON c.id = s.customer_id
  `;
  
  const params = [];
  if (startDate && endDate) {
    query += ` WHERE s.date >= ? AND s.date <= ?`;
    params.push(startDate + ' 00:00:00', endDate + ' 23:59:59');
  }
  
  query += ` GROUP BY c.id ORDER BY profit DESC`;
  
  const customers = db.prepare(query).all(...params);
  
  const totalRevenue = customers.reduce((sum, r) => sum + (r.revenue || 0), 0);
  const totalProfit = customers.reduce((sum, r) => sum + (r.profit || 0), 0);
  
  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lợi nhuận theo khách hàng - Beer POS</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#f59e0b">
  <link rel="stylesheet" href="/css/tailwind.css">
  <script src="/js/auth.js"></script>
  <style>
    .bottom-nav { max-width: 500px; margin: auto; }
  </style>
</head>
<body class="bg-gray-100 text-gray-800 min-h-screen pb-20">
  <header class="sticky top-0 bg-white border-b z-50">
    <div class="flex items-center justify-between px-4 h-12 max-w-md mx-auto">
      <div class="flex items-center gap-2">
        <a href="/report" class="text-gray-500">←</a>
        <span class="font-semibold text-sm">Lợi nhuận khách hàng</span>
      </div>
    </div>
  </header>
  <main class="p-4 pb-24 max-w-md mx-auto">
    <div class="card bg-gradient-to-r from-blue-500 to-blue-600 text-white mb-4">
      <div class="grid grid-cols-2 gap-2 text-center">
        <div>
          <div class="text-xs opacity-80">Tổng doanh thu</div>
          <div class="font-bold">${formatVND(totalRevenue)}</div>
        </div>
        <div>
          <div class="text-xs opacity-80">Tổng lợi nhuận</div>
          <div class="font-bold">${formatVND(totalProfit)}</div>
        </div>
      </div>
    </div>
    <div class="space-y-2">
      ${customers.length === 0 ? '<div class="text-gray-500 text-center py-4">Chưa có dữ liệu</div>' : customers.map((c, i) => `
        <a href="/customers/${c.id}" class="card block">
          <div class="flex justify-between items-center">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${i === 0 ? 'bg-yellow-400 text-yellow-900' : i === 1 ? 'bg-gray-300 text-gray-700' : i === 2 ? 'bg-orange-300 text-orange-900' : 'bg-gray-100 text-gray-600'}">${i + 1}</div>
              <div>
                <div class="font-bold">${c.name}</div>
                <div class="text-xs text-gray-500">${c.total_orders} đơn hàng</div>
              </div>
            </div>
            <div class="text-right">
              <div class="font-bold text-blue-600">${formatVND(c.profit || 0)}</div>
              <div class="text-xs text-gray-500">${formatVND(c.revenue || 0)}</div>
            </div>
          </div>
        </a>
      `).join('')}
    </div>
  </main>
  <nav class="bottomnav fixed bottom-0 left-0 right-0">
    <a href="/" class="py-3">
      <div class="text-xl">🏠</div>
      <div class="text-xs">Home</div>
    </a>
    <a href="/delivery" class="py-3">
      <div class="text-xl">🚚</div>
      <div class="text-xs">Giao</div>
    </a>
    <a href="/sale" class="py-3">
      <div class="text-xl">🍺</div>
      <div class="text-xs">Bán hàng</div>
    </a>
    <a href="/customers" class="py-3">
      <div class="text-xl">👤</div>
      <div class="text-xs">Khách</div>
    </a>
    <a href="/report" class="py-3 active">
      <div class="text-xl">📊</div>
      <div class="text-xs">Báo cáo</div>
    </a>
  </nav>
  <script>if (!isLoggedIn()) { window.location.href = '/login'; }</script>
</body>
</html>
  `);
});

// GET /report/cashflow - Báo cáo dòng tiền
router.get('/cashflow', (req, res) => {
  const { startDate, endDate } = req.query;
  
  const today = new Date().toISOString().split('T')[0];
  const start = startDate || today;
  const end = endDate || today;
  
  const salesByDay = db.prepare(`
    SELECT 
      date(date) as day,
      SUM(total) as revenue,
      SUM(profit) as profit,
      COUNT(*) as orders
    FROM sales
    WHERE date >= ? AND date <= ?
    GROUP BY date(date)
    ORDER BY day DESC
  `).all(start + ' 00:00:00', end + ' 23:59:59');
  
  const totalRevenue = salesByDay.reduce((sum, r) => sum + (r.revenue || 0), 0);
  const totalProfit = salesByDay.reduce((sum, r) => sum + (r.profit || 0), 0);
  
  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dòng tiền - Beer POS</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#f59e0b">
  <link rel="stylesheet" href="/css/tailwind.css">
  <script src="/js/auth.js"></script>
  <style>
    .bottom-nav { max-width: 500px; margin: auto; }
  </style>
</head>
<body class="bg-gray-100 text-gray-800 min-h-screen pb-20">
  <header class="sticky top-0 bg-white border-b z-50">
    <div class="flex items-center justify-between px-4 h-12 max-w-md mx-auto">
      <div class="flex items-center gap-2">
        <a href="/report" class="text-gray-500">←</a>
        <span class="font-semibold text-sm">Dòng tiền</span>
      </div>
    </div>
  </header>
  <main class="p-4 pb-24 max-w-md mx-auto">
    <div class="card bg-gradient-to-r from-green-500 to-green-600 text-white mb-4">
      <div class="grid grid-cols-2 gap-2 text-center">
        <div>
          <div class="text-xs opacity-80">Tổng thu</div>
          <div class="font-bold">${formatVND(totalRevenue)}</div>
        </div>
        <div>
          <div class="text-xs opacity-80">Lợi nhuận</div>
          <div class="font-bold">${formatVND(totalProfit)}</div>
        </div>
      </div>
    </div>
    <div class="space-y-2">
      ${salesByDay.length === 0 ? '<div class="text-gray-500 text-center py-4">Chưa có dữ liệu</div>' : salesByDay.map(d => `
        <div class="card">
          <div class="flex justify-between items-center">
            <div>
              <div class="font-bold">${new Date(d.day).toLocaleDateString('vi-VN')}</div>
              <div class="text-xs text-gray-500">${d.orders} đơn hàng</div>
            </div>
            <div class="text-right">
              <div class="font-bold text-amber-600">+${formatVND(d.revenue || 0)}</div>
              <div class="text-xs text-blue-600">+${formatVND(d.profit || 0)}</div>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  </main>
  <nav class="bottomnav fixed bottom-0 left-0 right-0">
    <a href="/" class="py-3">
      <div class="text-xl">🏠</div>
      <div class="text-xs">Home</div>
    </a>
    <a href="/delivery" class="py-3">
      <div class="text-xl">🚚</div>
      <div class="text-xs">Giao</div>
    </a>
    <a href="/sale" class="py-3">
      <div class="text-xl">🍺</div>
      <div class="text-xs">Bán hàng</div>
    </a>
    <a href="/customers" class="py-3">
      <div class="text-xl">👤</div>
      <div class="text-xs">Khách</div>
    </a>
    <a href="/report" class="py-3 active">
      <div class="text-xl">📊</div>
      <div class="text-xs">Báo cáo</div>
    </a>
  </nav>
  <script>if (!isLoggedIn()) { window.location.href = '/login'; }</script>
</body>
</html>
  `);
});

module.exports = router;
