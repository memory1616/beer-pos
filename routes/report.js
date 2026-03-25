const express = require('express');
const router = express.Router();
const db = require('../database');
const logger = require('../src/utils/logger');

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
  
  // Get expenses for the period (expenses table only has date, no time)
  const periodExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date >= ? AND date <= ?
  `).get(startDate.split(' ')[0], endDate.split(' ')[0]);
  
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
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

    /* Hai nút báo cáo chi tiết — đồng bộ viền amber, dễ chạm */
    .report-detail-link {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      min-height: 108px;
      padding: 14px 10px;
      background: #fff;
      border: 2px solid rgba(251, 191, 36, 0.65);
      border-radius: 18px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04);
      text-decoration: none;
      transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
    }
    .report-detail-link:hover {
      border-color: rgba(245, 158, 11, 0.95);
      box-shadow: 0 6px 20px rgba(245, 158, 11, 0.12);
    }
    .report-detail-link:active {
      transform: scale(0.97);
    }
    .report-detail-link .rd-icon {
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 14px;
      font-size: 1.35rem;
      line-height: 1;
    }
    .report-detail-link .rd-label {
      font-size: 11px;
      font-weight: 700;
      line-height: 1.3;
      text-align: center;
      letter-spacing: 0.01em;
    }

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

  <main class="p-4 pt-14 pb-24 max-w-md mx-auto animate-fade">
    <!-- Báo cáo chi tiết (2 nút — full width, viền amber đồng bộ phần THÁNG NÀY) -->
    <div class="mb-4">
      <div class="text-[10px] font-semibold uppercase tracking-wide text-amber-800/70 mb-2 px-0.5">Báo cáo chi tiết</div>
      <div class="grid grid-cols-2 gap-3">
        <a href="/report/profit-product" class="report-detail-link" aria-label="Lợi nhuận theo sản phẩm">
          <span class="rd-icon bg-gradient-to-br from-violet-100 to-purple-50 text-violet-700 shadow-sm">📦</span>
          <span class="rd-label text-violet-800">Lợi nhuận<br>sản phẩm</span>
        </a>
        <a href="/report/profit-customer" class="report-detail-link" aria-label="Lợi nhuận theo khách hàng">
          <span class="rd-icon bg-gradient-to-br from-indigo-100 to-blue-50 text-indigo-800 shadow-sm">👥</span>
          <span class="rd-label text-indigo-900">Lợi nhuận<br>khách hàng</span>
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
          '<button type="button" onclick="loadReportSales(' + (page - 1) + ')" ' + (page === 1 ? 'disabled' : '') + ' class="px-4 py-2 rounded-lg min-w-[4rem] ' + (page === 1 ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100 shadow-sm') + '">‹ Trước</button>' +
          '<span class="text-sm text-gray-600 px-2">' + page + '/' + totalPages + '</span>' +
          '<button type="button" onclick="loadReportSales(' + (page + 1) + ')" ' + (page === totalPages ? 'disabled' : '') + ' class="px-4 py-2 rounded-lg min-w-[4rem] ' + (page === totalPages ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100 shadow-sm') + '">Sau ›</button>' +
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
          const p = reportSalesPagination.page;
          const tp = reportSalesPagination.totalPages;
          const prevDisabled = p === 1;
          const nextDisabled = p === tp;
          html += '<div class="flex justify-center items-center gap-2 mt-3 py-3 bg-gray-50" id="salesPagination">' +
            '<button type="button" onclick="loadReportSales(' + (p - 1) + ')" ' + (prevDisabled ? 'disabled' : '') + ' class="px-4 py-2 rounded-lg min-w-[4rem] ' + (prevDisabled ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100 shadow-sm') + '">‹ Trước</button>' +
            '<span class="text-sm text-gray-600 px-2">' + p + '/' + tp + '</span>' +
            '<button type="button" onclick="loadReportSales(' + (p + 1) + ')" ' + (nextDisabled ? 'disabled' : '') + ' class="px-4 py-2 rounded-lg min-w-[4rem] ' + (nextDisabled ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100 shadow-sm') + '">Sau ›</button>' +
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
    logger.error('Error generating report', { error: err.message });
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
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
  <main class="p-4 pt-14 pb-24 max-w-md mx-auto">
    <div class="mb-4 shadow-lg rounded-2xl p-4" style="background: linear-gradient(135deg, #a855f7 0%, #7c3aed 100%); color: #fff;">
      <div class="grid grid-cols-3 gap-3 text-center py-2">
        <div>
          <div class="text-xs" style="opacity: 0.9;">Doanh thu</div>
          <div class="font-bold text-lg">${formatVND(totalRevenue)}</div>
        </div>
        <div>
          <div class="text-xs" style="opacity: 0.9;">Chi phí</div>
          <div class="font-bold text-lg">${formatVND(totalCost)}</div>
        </div>
        <div>
          <div class="text-xs" style="opacity: 0.9;">Lợi nhuận</div>
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

// GET /report/profit-customer - Báo cáo lợi nhuận theo khách hàng (theo tháng - năm hoặc năm)
router.get('/profit-customer', (req, res) => {
  const { month, year, startDate, endDate, mode } = req.query;

  const now = new Date();
  let startStr, endStr, labelThangNam;
  const viewMode = mode === 'year' ? 'year' : 'month';

  if (viewMode === 'year' && year) {
    const y = parseInt(year, 10);
    startStr = `${y}-01-01`;
    endStr = `${y}-12-31 23:59:59`;
    labelThangNam = `Năm ${y}`;
  } else if (month && year) {
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    const lastDay = new Date(y, m, 0).getDate();
    startStr = `${y}-${String(m).padStart(2, '0')}-01`;
    endStr = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')} 23:59:59`;
    const thang = ['', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'][m];
    labelThangNam = thang + ' / ' + y;
  } else if (startDate && endDate) {
    startStr = startDate.split(' ')[0];
    endStr = startDate.split(' ')[0] + ' 23:59:59';
    labelThangNam = startStr + ' → ' + endDate.split(' ')[0];
  } else {
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const lastDay = new Date(y, m, 0).getDate();
    startStr = `${y}-${String(m).padStart(2, '0')}-01`;
    endStr = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')} 23:59:59`;
    const thang = ['', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'][m];
    labelThangNam = thang + ' / ' + y;
  }

  const customers = db.prepare(`
    SELECT
      c.id,
      c.name,
      COUNT(s.id) as total_orders,
      SUM(s.total) as revenue,
      SUM(s.profit) as profit
    FROM sales s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.status != 'returned' AND s.type = 'sale'
      AND s.date >= ? AND s.date <= ?
    GROUP BY c.id ORDER BY profit DESC
  `).all(startStr, endStr);

  const totalRevenue = customers.reduce((sum, r) => sum + (r.revenue || 0), 0);
  const totalProfit = customers.reduce((sum, r) => sum + (r.profit || 0), 0);

  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const selectedMonth = month ? parseInt(month, 10) : currentMonth;
  const selectedYear = year ? parseInt(year, 10) : currentYear;

  const monthOptions = [1,2,3,4,5,6,7,8,9,10,11,12].map(m =>
    '<option value="' + m + '"' + (m === selectedMonth ? ' selected' : '') + '>Tháng ' + m + '</option>'
  ).join('');
  const yearOptions = [currentYear, currentYear - 1, currentYear - 2].map(y =>
    '<option value="' + y + '"' + (y === selectedYear ? ' selected' : '') + '>' + y + '</option>'
  ).join('');

  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Lợi nhuận theo khách hàng - Beer POS</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#f59e0b">
  <link rel="stylesheet" href="/css/tailwind.css">
  <link rel="stylesheet" href="/css/unified.css">
  <script src="/js/auth.js"></script>
  <script src="/js/layout.js"></script>
  <style>
    .bottomnav { max-width: 500px; margin: auto; }
    .filter-wrap { overflow: visible !important; }
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
  <main class="p-4 pt-14 pb-24 max-w-md mx-auto">
    <div style="background: #fef3c7; border-radius: 16px; border: 2px solid #f59e0b; padding: 16px; margin-bottom: 16px; overflow: visible;">
      <div class="flex items-center gap-2 mb-3">
        <span style="color: #92400e; font-size: 14px; font-weight: 600;">📅 Chọn kỳ thống kê</span>
      </div>

      <!-- Tab switcher -->
      <div class="flex gap-1 mb-3 p-1 rounded-xl" style="background: #fde68a;">
        <button type="button" id="tabMonth" onclick="switchMode('month')" class="flex-1 py-2 rounded-lg text-sm font-semibold transition-all" style="${viewMode === 'month' ? 'background:white;color:#92400e;box-shadow:0 1px 3px rgba(0,0,0,0.15)' : 'background:transparent;color:#b45309'}">Theo tháng</button>
        <button type="button" id="tabYear" onclick="switchMode('year')" class="flex-1 py-2 rounded-lg text-sm font-semibold transition-all" style="${viewMode === 'year' ? 'background:white;color:#92400e;box-shadow:0 1px 3px rgba(0,0,0,0.15)' : 'background:transparent;color:#b45309'}">Theo năm</button>
      </div>

      <!-- Theo tháng -->
      <div id="panelMonth" style="${viewMode === 'year' ? 'display:none' : ''}">
        <div class="flex gap-2 items-center">
          <select id="selMonth" style="flex: 1; border: 2px solid #f59e0b; border-radius: 8px; padding: 10px 12px; font-size: 14px; background: white; color: #1f2937; min-width: 0; outline: none;">
            ${monthOptions}
          </select>
          <select id="selYearMonth" style="flex: 1; border: 2px solid #f59e0b; border-radius: 8px; padding: 10px 12px; font-size: 14px; background: white; color: #1f2937; min-width: 0; outline: none;">
            ${yearOptions}
          </select>
          <button type="button" onclick="applyMonthYear()" style="background: #ea580c; color: white; border: none; border-radius: 8px; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap;">Xem</button>
        </div>
      </div>

      <!-- Theo năm -->
      <div id="panelYear" style="${viewMode !== 'year' ? 'display:none' : ''}">
        <div class="flex gap-2 items-center">
          <select id="selYear" style="flex: 1; border: 2px solid #f59e0b; border-radius: 8px; padding: 10px 12px; font-size: 14px; background: white; color: #1f2937; min-width: 0; outline: none;">
            ${yearOptions}
          </select>
          <button type="button" onclick="applyYear()" style="background: #ea580c; color: white; border: none; border-radius: 8px; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap;">Xem</button>
        </div>
      </div>

      <div class="text-xs text-gray-500 mt-2">Đang xem: ${labelThangNam}</div>
    </div>
    <div class="mb-4 shadow-lg rounded-2xl p-4" style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #fff;">
      <div class="grid grid-cols-2 gap-3 text-center py-2">
        <div>
          <div class="text-xs" style="opacity: 0.9;">Tổng doanh thu</div>
          <div class="font-bold text-lg">${formatVND(totalRevenue)}</div>
        </div>
        <div>
          <div class="text-xs" style="opacity: 0.9;">Tổng lợi nhuận</div>
          <div class="font-bold text-lg">${formatVND(totalProfit)}</div>
        </div>
      </div>
    </div>
    <div class="space-y-2">
      ${customers.length === 0 ? '<div class="text-gray-500 text-center py-4 bg-white rounded-xl">Chưa có dữ liệu trong tháng này</div>' : customers.map((c, i) => `
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
    function switchMode(mode) {
      const tabMonth = document.getElementById('tabMonth');
      const tabYear = document.getElementById('tabYear');
      const panelMonth = document.getElementById('panelMonth');
      const panelYear = document.getElementById('panelYear');
      if (mode === 'year') {
        tabYear.style.cssText = 'flex:1;py-2:rounded-lg;text-sm:font-semibold;transition-all;background:white;color:#92400e;box-shadow:0 1px 3px rgba(0,0,0,0.15)';
        tabMonth.style.cssText = 'flex:1;py-2:rounded-lg;text-sm:font-semibold;transition-all;background:transparent;color:#b45309';
        panelYear.style.display = '';
        panelMonth.style.display = 'none';
      } else {
        tabMonth.style.cssText = 'flex:1;py-2:rounded-lg;text-sm:font-semibold;transition-all;background:white;color:#92400e;box-shadow:0 1px 3px rgba(0,0,0,0.15)';
        tabYear.style.cssText = 'flex:1;py-2:rounded-lg;text-sm:font-semibold;transition-all;background:transparent;color:#b45309';
        panelMonth.style.display = '';
        panelYear.style.display = 'none';
      }
    }
    function applyMonthYear() {
      const m = document.getElementById('selMonth').value;
      const y = document.getElementById('selYearMonth').value;
      window.location.href = '/report/profit-customer?month=' + m + '&year=' + y;
    }
    function applyYear() {
      const y = document.getElementById('selYear').value;
      window.location.href = '/report/profit-customer?mode=year&year=' + y;
    }
    const bottomNav = getBottomNav('/report');
    document.getElementById('bottomNavContainer').innerHTML = bottomNav;
  </script>
</body>
</html>
  `);
});

module.exports = router;
