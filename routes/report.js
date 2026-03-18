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
      (SELECT COALESCE(SUM(total), 0) FROM sales WHERE date >= ? AND date <= ? AND status != 'returned') as revenue,
      (SELECT COALESCE(SUM(profit), 0) FROM sales WHERE date >= ? AND date <= ? AND status != 'returned') as profit,
      (SELECT COUNT(*) FROM sales WHERE date >= ? AND date <= ? AND status != 'returned') as order_count,
      COALESCE(SUM(si.quantity), 0) as total_quantity
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id AND s.date >= ? AND s.date <= ? AND s.status != 'returned'
  `).get(startDate, endDate, startDate, endDate, startDate, endDate, startDate, endDate);
  
  // Get expenses for the period
  const periodExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date >= ? AND date <= ?
  `).get(startDate, endDate);
  
  // Calculate net profit (profit - expenses)
  const netProfit = periodStats.profit - periodExpenses.total;
  
  // Daily stats for the period (last 7 days or 30 days)
  const dailyStats = db.prepare(`
    SELECT 
      s.date,
      COALESCE(SUM(s.total), 0) as revenue,
      COALESCE(SUM(s.profit), 0) as profit,
      COALESCE(SUM(si.quantity), 0) as quantity
    FROM sales s
    LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE s.date >= ? AND s.date <= ? AND s.status != 'returned'
    GROUP BY s.date
    ORDER BY s.date DESC
    LIMIT 30
  `).all(startDate, endDate);
  
  // Top customers by revenue - use subquery to avoid duplicate counting
  const topCustomers = db.prepare(`
    SELECT 
      c.id,
      c.name,
      (SELECT COALESCE(SUM(s2.total), 0) FROM sales s2 WHERE s2.customer_id = c.id AND s2.date >= ? AND s2.date <= ? AND s2.status != 'returned') as revenue,
      (SELECT COALESCE(SUM(si2.quantity), 0) FROM sale_items si2 JOIN sales s3 ON s3.id = si2.sale_id AND s3.customer_id = c.id AND s3.date >= ? AND s3.date <= ? AND s3.status != 'returned') as quantity,
      (SELECT COUNT(*) FROM sales s2 WHERE s2.customer_id = c.id AND s2.date >= ? AND s2.date <= ? AND s2.status != 'returned') as order_count
    FROM customers c
    WHERE (SELECT SUM(s2.total) FROM sales s2 WHERE s2.customer_id = c.id AND s2.date >= ? AND s2.date <= ? AND s2.status != 'returned') > 0
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
    WHERE s.date >= ? AND s.date <= ? AND s.status != 'returned'
    GROUP BY p.id
    ORDER BY quantity_sold DESC
    LIMIT 10
  `).all(startDate, endDate);
  
  // All time stats - chỉ dùng subquery, không JOIN, đảm bảo tổng toàn bộ thời gian
  const allTimeStats = db.prepare(`
    SELECT 
      (SELECT COALESCE(SUM(total), 0) FROM sales WHERE status != 'returned') as revenue,
      (SELECT COALESCE(SUM(profit), 0) FROM sales WHERE status != 'returned') as profit,
      (SELECT COUNT(*) FROM sales WHERE status != 'returned') as order_count,
      (SELECT COALESCE(SUM(quantity), 0) FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.status != 'returned') as total_quantity
  `).get();
  
  // Get all time expenses
  const allTimeExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses
  `).get();
  
  // Calculate all time net profit
  const allTimeNetProfit = allTimeStats.profit - allTimeExpenses.total;
  
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
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="/js/auth.js"></script>
  <link rel="stylesheet" href="/css/unified.css">
  <script src="/js/layout.js"></script>
  <style>
    .animate-fade { animation: fade 0.25s ease-out; }
    @keyframes fade { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .bottomnav { max-width: 500px; margin: auto; left: 0; right: 0; }
    button, a { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    button:active { transform: scale(0.96); }

    /* Fix selection highlight: tránh xanh khi bôi/copy */
    ::selection { background: transparent; }
    * { user-select: none; }
    .card-value { user-select: text; }
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
      <div class="grid grid-cols-3 gap-3">
        <a href="/report/profit-product" class="card text-center py-4 bg-gradient-to-br from-purple-50 to-purple-100 border-purple-200 hover:shadow-md transition-all">
          <div class="text-2xl mb-1">📦</div>
          <div class="text-xs font-semibold text-purple-700">Lợi nhuận<br>sản phẩm</div>
        </a>
        <a href="/report/profit-customer" class="card text-center py-4 bg-gradient-to-br from-blue-50 to-blue-100 border-blue-200 hover:shadow-md transition-all">
          <div class="text-2xl mb-1">👥</div>
          <div class="text-xs font-semibold text-blue-700">Lợi nhuận<br>khách hàng</div>
        </a>
        <a href="/report/cashflow" class="card text-center py-4 bg-gradient-to-br from-green-50 to-green-100 border-green-200 hover:shadow-md transition-all">
          <div class="text-2xl mb-1">💰</div>
          <div class="text-xs font-semibold text-green-700">Dòng tiền</div>
        </a>
      </div>
    </div>

    <!-- Period Selector - grid 5 nút, không scroll; tab chọn màu mạnh (blue-600/white) -->
    <div class="mb-4">
      <div class="grid grid-cols-5 gap-2">
        <a href="/report?period=today" class="px-2 py-3 rounded-xl text-xs font-semibold text-center shadow-sm ${period === 'today' ? 'bg-gradient-to-r from-blue-600 to-blue-500 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}">Hôm nay</a>
        <a href="/report?period=yesterday" class="px-2 py-3 rounded-xl text-xs font-semibold text-center shadow-sm ${period === 'yesterday' ? 'bg-gradient-to-r from-blue-600 to-blue-500 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}">Hôm qua</a>
        <a href="/report?period=week" class="px-2 py-3 rounded-xl text-xs font-semibold text-center shadow-sm ${period === 'week' ? 'bg-gradient-to-r from-blue-600 to-blue-500 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}">7 ngày</a>
        <a href="/report?period=thisMonth" class="px-2 py-3 rounded-xl text-xs font-semibold text-center shadow-sm ${period === 'thisMonth' ? 'bg-gradient-to-r from-blue-600 to-blue-500 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}">Tháng này</a>
        <a href="/report?period=lastMonth" class="px-2 py-3 rounded-xl text-xs font-semibold text-center shadow-sm ${period === 'lastMonth' ? 'bg-gradient-to-r from-blue-600 to-blue-500 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}">Tháng trước</a>
      </div>
    </div>

    <!-- Period Stats -->
    <div class="mb-4">
      <div class="section-title">${periodLabel}</div>
      <div class="grid grid-cols-2 gap-3">
        <div class="card bg-gradient-to-br from-amber-50 to-white border-amber-200">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-amber-500">💵</span>
            <div class="text-xs text-amber-700 font-medium">Doanh thu</div>
          </div>
          <div class="text-xl font-bold text-amber-600 card-value">${formatVND(periodStats.revenue)}</div>
        </div>
        <div class="card bg-gradient-to-br from-blue-50 to-white border-blue-200">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-blue-500">📈</span>
            <div class="text-xs text-blue-700 font-medium">Lợi nhuận gộp</div>
          </div>
          <div class="text-xl font-bold text-blue-600 card-value">${formatVND(periodStats.profit)}</div>
        </div>
        <div class="card bg-gradient-to-br from-red-50 to-white border-red-200">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-red-500">📉</span>
            <div class="text-xs text-red-700 font-medium">Chi phí</div>
          </div>
          <div class="text-xl font-bold text-red-600 card-value">-${formatVND(periodExpenses.total)}</div>
        </div>
        <div class="card bg-gradient-to-br from-indigo-50 to-indigo-100 border-indigo-300">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-indigo-600">✨</span>
            <div class="text-xs text-indigo-700 font-medium">Lợi nhuận ròng</div>
          </div>
          <div class="text-xl font-bold text-indigo-700 card-value">${formatVND(netProfit)}</div>
        </div>
        <div class="card bg-gradient-to-br from-gray-50 to-white border-gray-200">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-gray-500">📋</span>
            <div class="text-xs text-gray-600 font-medium">Đơn hàng</div>
          </div>
          <div class="text-xl font-bold text-gray-700 card-value">${periodStats.order_count}</div>
        </div>
        <div class="card bg-gradient-to-br from-orange-50 to-white border-orange-200">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-orange-500">🍺</span>
            <div class="text-xs text-orange-700 font-medium">Sản phẩm</div>
          </div>
          <div class="text-xl font-bold text-orange-600 card-value">${periodStats.total_quantity}</div>
        </div>
      </div>
    </div>

    <!-- Chart theo kỳ đã chọn -->
    <div class="mb-4">
      <div class="section-title">Biểu đồ doanh thu</div>
      <div class="card">
        <canvas id="periodRevenueChart" style="height: 180px;"></canvas>
      </div>
    </div>

    <!-- All Time Stats - layout grid card giống dashboard -->
    <div class="mb-4">
      <div class="section-title">📊 Tất cả thời gian</div>
      <div class="grid grid-cols-2 gap-3 mt-2">
        <div class="p-3 bg-gradient-to-br from-amber-50 to-white rounded-xl border border-amber-300 shadow-sm">
          <div class="flex items-center gap-1 mb-1">
            <span class="text-amber-500">💵</span>
            <div class="text-xs text-amber-700 font-medium">Doanh thu</div>
          </div>
          <div class="text-lg font-bold text-amber-600 card-value">${formatVND(allTimeStats.revenue)}</div>
        </div>
        <div class="p-3 bg-gradient-to-br from-blue-50 to-white rounded-xl border border-blue-300 shadow-sm">
          <div class="flex items-center gap-1 mb-1">
            <span class="text-blue-500">📈</span>
            <div class="text-xs text-blue-700 font-medium">Lợi nhuận gộp</div>
          </div>
          <div class="text-lg font-bold text-blue-600 card-value">${formatVND(allTimeStats.profit)}</div>
        </div>
        <div class="p-3 bg-gradient-to-br from-red-50 to-white rounded-xl border border-red-300 shadow-sm">
          <div class="flex items-center gap-1 mb-1">
            <span class="text-red-500">📉</span>
            <div class="text-xs text-red-700 font-medium">Tổng chi phí</div>
          </div>
          <div class="text-lg font-bold text-red-600 card-value">-${formatVND(allTimeExpenses.total)}</div>
        </div>
        <div class="p-3 bg-gradient-to-br from-indigo-50 to-indigo-100 rounded-xl border border-indigo-300 shadow-sm">
          <div class="flex items-center gap-1 mb-1">
            <span class="text-indigo-600">✨</span>
            <div class="text-xs text-indigo-700 font-medium">Lợi nhuận ròng</div>
          </div>
          <div class="text-lg font-bold text-indigo-700 card-value">${formatVND(allTimeNetProfit)}</div>
        </div>
        <div class="p-3 bg-gradient-to-br from-gray-50 to-white rounded-xl border border-gray-300 shadow-sm">
          <div class="flex items-center gap-1 mb-1">
            <span class="text-gray-500">📋</span>
            <div class="text-xs text-gray-600 font-medium">Đơn hàng</div>
          </div>
          <div class="text-lg font-bold text-gray-700 card-value">${allTimeStats.order_count}</div>
        </div>
        <div class="p-3 bg-gradient-to-br from-orange-50 to-white rounded-xl border border-orange-300 shadow-sm">
          <div class="flex items-center gap-1 mb-1">
            <span class="text-orange-500">🍺</span>
            <div class="text-xs text-orange-700 font-medium">Sản phẩm</div>
          </div>
          <div class="text-lg font-bold text-orange-600 card-value">${allTimeStats.total_quantity}</div>
        </div>
      </div>
    </div>

    <!-- Top Customers -->
    <div class="mb-4">
      <div class="section-title">🏆 Top khách hàng</div>
      <div class="space-y-2">
        ${topCustomers.length === 0 ? '<div class="text-gray-500 text-center py-4 bg-white rounded-xl">Chưa có dữ liệu</div>' : topCustomers.map((c, i) => `
          <div class="card flex justify-between items-center hover:shadow-md transition-all">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shadow-sm ${i === 0 ? 'bg-gradient-to-br from-yellow-400 to-yellow-500 text-yellow-900' : i === 1 ? 'bg-gradient-to-br from-gray-300 to-gray-400 text-gray-700' : i === 2 ? 'bg-gradient-to-br from-orange-300 to-orange-400 text-orange-900' : 'bg-gray-100 text-gray-600'}">${i + 1}</div>
              <div>
                <div class="font-bold text-sm">${c.name}</div>
                <div class="text-xs text-gray-500">${c.order_count} đơn · ${c.quantity} sản phẩm</div>
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
        ${topProducts.length === 0 ? '<div class="text-gray-500 text-center py-4 bg-white rounded-xl">Chưa có dữ liệu</div>' : topProducts.map((p, i) => `
          <div class="card flex justify-between items-center hover:shadow-md transition-all">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shadow-sm ${i === 0 ? 'bg-gradient-to-br from-yellow-400 to-yellow-500 text-yellow-900' : i === 1 ? 'bg-gradient-to-br from-gray-300 to-gray-400 text-gray-700' : i === 2 ? 'bg-gradient-to-br from-orange-300 to-orange-400 text-orange-900' : 'bg-gray-100 text-gray-600'}">${i + 1}</div>
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
      <div class="bg-white rounded-xl shadow-sm border overflow-hidden" id="recentSalesList">
        ${recentSales.length === 0 ? '<div class="text-gray-500 text-center py-4">Chưa có đơn hàng</div>' : recentSales.map(s => {
          const date = new Date(s.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
          const hasKegUpdate = (s.deliver_kegs || 0) > 0 || (s.return_kegs || 0) > 0;
          
          let typeBadge = '';
          let totalDisplay = '';
          let rowClass = '';
          
          if (s.type === 'replacement') {
            typeBadge = '<span class="bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded text-xs">🔁 Đổi lỗi</span>';
            totalDisplay = '<span class="font-bold text-orange-600">0 đ</span>';
            rowClass = 'bg-orange-50/50';
          } else {
            totalDisplay = '<span class="font-bold text-green-600">' + formatVND(s.total) + '</span>';
          }
          
          return '<div class="flex justify-between items-center p-3 border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors ' + rowClass + '">' +
            '<div class="flex-1">' +
              '<div class="font-medium text-sm">#' + s.id + ' - ' + (s.customer_name || 'Khách lẻ') + ' ' + typeBadge + '</div>' +
              '<div class="text-xs text-gray-500 mt-0.5">' + date + (hasKegUpdate ? ' · 📦' : '') + '</div>' +
            '</div>' +
            '<div class="text-right ml-3">' +
              totalDisplay +
              (s.type !== 'replacement' ? '<div class="text-xs ' + (s.profit > 0 ? 'text-green-600' : 'text-red-500') + '">+' + formatVND(s.profit) + '</div>' : '') +
            '</div>' +
          '</div>';
        }).join('')}
        ${totalPages > 1 ? '<div class="flex justify-center items-center gap-2 mt-3 py-3 bg-gray-50" id="salesPagination">' +
          '<button onclick="loadReportSales(' + (page - 1) + ')" ' + (page === 1 ? 'disabled' : '') + ' ' + 'class="px-4 py-2 rounded-lg ' + (page === 1 ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100 shadow-sm') + '">‹ Trước</button>' +
          '<span class="text-sm text-gray-600 px-2">' + page + '/' + totalPages + '</span>' +
          '<button onclick="loadReportSales(' + (page + 1) + ')" ' + (page === totalPages ? 'disabled' : '') + ' ' + 'class="px-4 py-2 rounded-lg ' + (page === totalPages ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100 shadow-sm') + '">Sau ›</button>' +
        '</div>' : ''}
      </div>
    </div>

    <script>
      const currentPeriod = '${period}';
      const reportSalesPagination = { page: ${page}, totalPages: ${totalPages}, total: ${total} };
      const dailyStats = ${JSON.stringify(dailyStats || [])};
      
      function formatVND(amount) {
        return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
      }

      // Render chart: doanh thu theo ngày (kỳ đã chọn)
      (function renderPeriodChart() {
        const canvas = document.getElementById('periodRevenueChart');
        if (!canvas || typeof Chart === 'undefined') return;

        const ctx = canvas.getContext('2d');
        const rows = Array.isArray(dailyStats) ? dailyStats.slice().reverse() : [];
        const labels = rows.map(r => {
          try {
            return new Date(r.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
          } catch (e) {
            return String(r.date || '');
          }
        });
        const revenueData = rows.map(r => Number(r.revenue || 0));

        if (labels.length === 0) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.font = '14px Inter';
          ctx.fillStyle = '#6b7280';
          ctx.textAlign = 'center';
          ctx.fillText('Chưa có dữ liệu', canvas.width / 2, canvas.height / 2);
          return;
        }

        new Chart(ctx, {
          type: 'bar',
          data: {
            labels,
            datasets: [{
              label: 'Doanh thu',
              data: revenueData,
              backgroundColor: 'rgba(245, 158, 11, 0.35)',
              borderColor: 'rgba(245, 158, 11, 1)',
              borderWidth: 1,
              borderRadius: 6
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (ctx) => ' ' + formatVND(ctx.raw || 0)
                }
              }
            },
            scales: {
              y: {
                ticks: { callback: (v) => formatVND(v) }
              }
            }
          }
        });
      })();
      
      async function loadReportSales(newPage) {
        if (newPage < 1 || newPage > reportSalesPagination.totalPages) return;
        
        const res = await fetch('/report/sales?page=' + newPage + '&period=' + currentPeriod);
        const data = await res.json();
        
        reportSalesPagination.page = data.page;
        reportSalesPagination.totalPages = data.totalPages;
        reportSalesPagination.total = data.total;
        
        const container = document.getElementById('recentSalesList');
        if (data.sales.length === 0) {
          container.innerHTML = '<div class="text-gray-700 text-center py-4">Chưa có đơn hàng</div>';
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
            totalDisplay = '<span class="font-bold text-green-600">' + formatVND(s.total) + '</span>';
          }
          
          return '<div class="flex justify-between items-center p-2 border-b ' + rowClass + '">' +
            '<div>' +
              '<div class="font-medium">#' + s.id + ' - ' + (s.customer_name || 'Khách lẻ') + ' ' + typeBadge + '</div>' +
              '<div class="text-xs text-gray-700">' + date + (hasKegUpdate ? ' • 📦' : '') + '</div>' +
            '</div>' +
            '<div class="text-right">' +
              totalDisplay +
              (s.type !== 'replacement' ? '<div class="text-xs ' + (s.profit > 0 ? 'text-green-600' : 'text-red-500') + '">+' + formatVND(s.profit) + '</div>' : '') +
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

  <div id="bottomNavContainer"></div>
  <script>
    if (!isLoggedIn()) { window.location.href = '/login'; }
  </script>
  <script>
    const bottomNav = getBottomNav('/report');
    document.getElementById('bottomNavContainer').innerHTML = bottomNav;
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
    WHERE s.status != 'returned'
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
    .bottomnav { max-width: 500px; margin: auto; }
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
    <div class="card bg-gradient-to-r from-purple-500 to-purple-600 text-white mb-4 shadow-lg">
      <div class="grid grid-cols-3 gap-3 text-center py-2">
        <div>
          <div class="text-xs opacity-80">Doanh thu</div>
          <div class="font-bold text-lg">${formatVND(totalRevenue)}</div>
        </div>
        <div>
          <div class="text-xs opacity-80">Chi phí</div>
          <div class="font-bold text-lg">${formatVND(totalCost)}</div>
        </div>
        <div>
          <div class="text-xs opacity-80">Lợi nhuận</div>
          <div class="font-bold text-lg">${formatVND(totalProfit)}</div>
        </div>
      </div>
    </div>
    <div class="space-y-2">
      ${products.length === 0 ? '<div class="text-gray-500 text-center py-4 bg-white rounded-xl">Chưa có dữ liệu</div>' : products.map((p, i) => `
        <div class="card hover:shadow-md transition-all">
          <div class="flex justify-between items-center">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shadow-sm ${i === 0 ? 'bg-gradient-to-br from-yellow-400 to-yellow-500 text-yellow-900' : i === 1 ? 'bg-gradient-to-br from-gray-300 to-gray-400 text-gray-700' : i === 2 ? 'bg-gradient-to-br from-orange-300 to-orange-400 text-orange-900' : 'bg-gray-100 text-gray-600'}">${i + 1}</div>
              <div>
                <div class="font-bold">${p.name}</div>
                <div class="text-xs text-gray-500">${p.total_qty} sản phẩm · ${formatVND(p.revenue)}</div>
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
    WHERE s.status != 'returned'
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
    .bottomnav { max-width: 500px; margin: auto; }
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
    <div class="card bg-gradient-to-r from-blue-500 to-blue-600 text-white mb-4 shadow-lg">
      <div class="grid grid-cols-2 gap-3 text-center py-2">
        <div>
          <div class="text-xs opacity-80">Tổng doanh thu</div>
          <div class="font-bold text-lg">${formatVND(totalRevenue)}</div>
        </div>
        <div>
          <div class="text-xs opacity-80">Tổng lợi nhuận</div>
          <div class="font-bold text-lg">${formatVND(totalProfit)}</div>
        </div>
      </div>
    </div>
    <div class="space-y-2">
      ${customers.length === 0 ? '<div class="text-gray-500 text-center py-4 bg-white rounded-xl">Chưa có dữ liệu</div>' : customers.map((c, i) => `
        <a href="/customers/${c.id}" class="card block hover:shadow-md transition-all">
          <div class="flex justify-between items-center">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shadow-sm ${i === 0 ? 'bg-gradient-to-br from-yellow-400 to-yellow-500 text-yellow-900' : i === 1 ? 'bg-gradient-to-br from-gray-300 to-gray-400 text-gray-700' : i === 2 ? 'bg-gradient-to-br from-orange-300 to-orange-400 text-orange-900' : 'bg-gray-100 text-gray-600'}">${i + 1}</div>
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
    WHERE date >= ? AND date <= ? AND status != 'returned'
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
    .bottomnav { max-width: 500px; margin: auto; }
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
      ${salesByDay.length === 0 ? '<div class="text-gray-700 text-center py-4">Chưa có dữ liệu</div>' : salesByDay.map(d => `
        <div class="card">
          <div class="flex justify-between items-center">
            <div>
              <div class="font-bold">${new Date(d.day).toLocaleDateString('vi-VN')}</div>
              <div class="text-xs text-gray-700">${d.orders} đơn hàng</div>
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

module.exports = router;
