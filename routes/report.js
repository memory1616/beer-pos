const express = require('express');
const router = express.Router();
const db = require('../database');
const logger = require('../src/utils/logger');

function formatVND(amount) {
  if (amount === null || amount === undefined || amount === '') return '0 đ';
  const num = Number(amount);
  if (isNaN(num)) return '0 đ';
  return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
}

/** Chỉ số đã format — dùng trong .money > .value + .unit (không lặp "đ") */
function formatVNDNumber(amount) {
  if (amount === null || amount === undefined || amount === '') return '0';
  const num = Number(amount);
  if (isNaN(num)) return '0';
  return new Intl.NumberFormat('vi-VN').format(num);
}

// Helper: get Vietnam date string (YYYY-MM-DD) - fix timezone issue
function getVietnamDateStr() {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return vn.getUTCFullYear() + '-' +
    String(vn.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(vn.getUTCDate()).padStart(2, '0');
}

function getDateRange(period) {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000); // Vietnam timezone (UTC+7)
  let startDate, endDate;
  
  const year = vn.getUTCFullYear();
  const month = String(vn.getUTCMonth() + 1).padStart(2, '0');
  const day = String(vn.getUTCDate()).padStart(2, '0');
  const today = `${year}-${month}-${day}`;
  
  endDate = today + ' 23:59:59';
  
  if (period === 'today') {
    startDate = today + ' 00:00:00';
  } else if (period === 'yesterday') {
    const yesterday = new Date(vn);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const y = yesterday.getUTCFullYear();
    const m = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
    const d = String(yesterday.getUTCDate()).padStart(2, '0');
    startDate = `${y}-${m}-${d} 00:00:00`;
    endDate = `${y}-${m}-${d} 23:59:59`;
  } else if (period === 'week') {
    const weekAgo = new Date(vn);
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
    const y = weekAgo.getUTCFullYear();
    const m = String(weekAgo.getUTCMonth() + 1).padStart(2, '0');
    const d = String(weekAgo.getUTCDate()).padStart(2, '0');
    startDate = `${y}-${m}-${d} 00:00:00`;
  } else if (period === 'thisMonth') {
    startDate = `${year}-${month}-01 00:00:00`;
  } else if (period === 'lastMonth') {
    const lastMonth = new Date(vn);
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    const y = lastMonth.getUTCFullYear();
    const m = String(lastMonth.getUTCMonth() + 1).padStart(2, '0');
    const lastMonthDays = new Date(y, lastMonth.getUTCMonth() + 1, 0).getUTCDate();
    startDate = `${y}-${m}-01 00:00:00`;
    endDate = `${y}-${m}-${String(lastMonthDays).padStart(2, '0')} 23:59:59`;
  } else {
    startDate = `${year}-${month}-01 00:00:00`;
  }
  
  // YYYY-MM-DD (VN) — dùng cho WHERE date(s.date) = ? tránh lệch với server TZ
  return { startDate, endDate, todayKey: today };
}

// GET /report
router.get('/', (req, res) => {
  try {
  const period = req.query.period || 'thisMonth';
  const { startDate, endDate, todayKey } = getDateRange(period);
  
  // Revenue & Profit by period — dùng date(col) vì sales.date lưu YYYY-MM-DD (không giờ);
  // status NULL: WHERE status != 'returned' loại hết dòng (NULL != 'returned' là UNKNOWN) → dashboard vẫn có số, báo cáo 0
  // total_quantity là scalar subquery (không FROM sale_items) để luôn có 1 dòng, kể cả hôm nay không có dòng sale_items
  const periodStats = db.prepare(`
    SELECT 
      (SELECT COALESCE(SUM(total), 0) FROM sales WHERE date(date) >= date(?) AND date(date) <= date(?) AND (status IS NULL OR status != 'returned')) as revenue,
      (SELECT COALESCE(SUM(profit), 0) FROM sales WHERE date(date) >= date(?) AND date(date) <= date(?) AND (status IS NULL OR status != 'returned')) as profit,
      (SELECT COUNT(*) FROM sales WHERE date(date) >= date(?) AND date(date) <= date(?) AND (status IS NULL OR status != 'returned')) as order_count,
      (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE date(s.date) >= date(?) AND date(s.date) <= date(?) AND (s.status IS NULL OR s.status != 'returned')) as total_quantity
  `).get(startDate, endDate, startDate, endDate, startDate, endDate, startDate, endDate);
  
  // Get expenses for the period (date có thể là YYYY-MM-DD)
  const periodExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date(date) >= date(?) AND date(date) <= date(?)
  `).get(startDate.split(' ')[0], endDate.split(' ')[0]);
  
  // Calculate net profit (profit - expenses)
  const netProfit = periodStats.profit - periodExpenses.total;
  
  // Daily stats — KHÔNG JOIN sale_items khi SUM(s.total): mỗi đơn nhiều dòng item → nhân đôi doanh thu trên biểu đồ
  const dailyStats = db.prepare(`
    SELECT 
      date(s.date) as date,
      COALESCE(SUM(s.total), 0) as revenue,
      COALESCE(SUM(s.profit), 0) as profit,
      COALESCE(SUM((SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id)), 0) as quantity
    FROM sales s
    WHERE date(s.date) >= date(?) AND date(s.date) <= date(?) AND (s.status IS NULL OR s.status != 'returned')
    GROUP BY date(s.date)
    ORDER BY date(s.date) DESC
    LIMIT 30
  `).all(startDate, endDate);
  
  // Top customers by revenue - use subquery to avoid duplicate counting
  const topCustomers = db.prepare(`
    SELECT 
      c.id,
      c.name,
      (SELECT COALESCE(SUM(s2.total), 0) FROM sales s2 WHERE s2.customer_id = c.id AND date(s2.date) >= date(?) AND date(s2.date) <= date(?) AND (s2.status IS NULL OR s2.status != 'returned')) as revenue,
      (SELECT COALESCE(SUM(si2.quantity), 0) FROM sale_items si2 JOIN sales s3 ON s3.id = si2.sale_id AND s3.customer_id = c.id AND date(s3.date) >= date(?) AND date(s3.date) <= date(?) AND (s3.status IS NULL OR s3.status != 'returned')) as quantity,
      (SELECT COUNT(*) FROM sales s2 WHERE s2.customer_id = c.id AND date(s2.date) >= date(?) AND date(s2.date) <= date(?) AND (s2.status IS NULL OR s2.status != 'returned')) as order_count
    FROM customers c
    WHERE c.archived = 0 AND (SELECT SUM(s2.total) FROM sales s2 WHERE s2.customer_id = c.id AND date(s2.date) >= date(?) AND date(s2.date) <= date(?) AND (s2.status IS NULL OR s2.status != 'returned')) > 0
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
    WHERE date(s.date) >= date(?) AND date(s.date) <= date(?) AND (s.status IS NULL OR s.status != 'returned')
    GROUP BY p.id
    ORDER BY quantity_sold DESC
    LIMIT 10
  `).all(startDate, endDate);
  
  // All time stats - chỉ dùng subquery, không JOIN, đảm bảo tổng toàn bộ thời gian
  const allTimeStats = db.prepare(`
    SELECT 
      (SELECT COALESCE(SUM(total), 0) FROM sales WHERE (status IS NULL OR status != 'returned')) as revenue,
      (SELECT COALESCE(SUM(profit), 0) FROM sales WHERE (status IS NULL OR status != 'returned')) as profit,
      (SELECT COUNT(*) FROM sales WHERE (status IS NULL OR status != 'returned')) as order_count,
      (SELECT COALESCE(SUM(quantity), 0) FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE (s.status IS NULL OR s.status != 'returned')) as total_quantity
  `).get();
  
  // Get all time expenses
  const allTimeExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses
  `).get();
  
  // Calculate all time net profit
  const allTimeNetProfit = allTimeStats.profit - allTimeExpenses.total;
  
  // Recent sales with pagination — cùng ngày VN với getDateRange (todayKey), không dùng new Date() server
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
  let whereClause = '';
  
  if (period === 'thisMonth') {
    const ym = todayKey.slice(0, 7);
    whereClause = ` WHERE strftime('%Y-%m', s.date) = '${ym}'`;
  } else if (period === 'lastMonth') {
    const ym = startDate.split(' ')[0].slice(0, 7);
    whereClause = ` WHERE strftime('%Y-%m', s.date) = '${ym}'`;
  } else if (period === 'today') {
    whereClause = ` WHERE date(s.date) = date('${todayKey}')`;
  } else if (period === 'yesterday') {
    const yk = startDate.split(' ')[0];
    whereClause = ` WHERE date(s.date) = date('${yk}')`;
  } else if (period === 'week') {
    const d0 = startDate.split(' ')[0];
    const d1 = endDate.split(' ')[0];
    whereClause = ` WHERE date(s.date) >= date('${d0}') AND date(s.date) <= date('${d1}')`;
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
  <meta name="mobile-web-app-capable" content="yes">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <link rel="icon" type="image/png" href="/icon-192.png">
  <link rel="stylesheet" href="/css/tailwind.css">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="/js/auth.js"></script>
  <script src="/js/dark-mode.js"></script>
  <link rel="stylesheet" href="/css/unified.css?v=20260414">
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

    /* Fixed header: full width, blur + shadow */
    .report-page-header,
    .report-page-header ~ div:not([class]) ~ header,
    [z-50].bg-card {
      /* Applied via .report-fixed-header class added inline */
    }
    .report-page-header {
      background: rgba(255, 255, 255, 0.92);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--color-border);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
    }
    .report-page-header-inner {
      max-width: 28rem;
      margin-left: auto;
      margin-right: auto;
    }
    /* Sub-pages: apply same style to fixed header without report-page-header class */
    header.fixed.top-0.left-0.right-0.z-50 {
      background: rgba(255, 255, 255, 0.92);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--color-border);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
    }
    .report-main {
      width: 100%;
      max-width: 28rem;
      margin-left: auto;
      margin-right: auto;
      box-sizing: border-box;
      min-width: 0;
      overflow-x: clip;
    }
    /* Lớp ngoài: bề rộng cố định theo main → cuộn được; flex 1 lớp hay bị min-width:auto giãn theo nút */
    .report-filter-outer {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      overflow-x: auto;
      overflow-y: hidden;
      padding-bottom: 6px;
      margin-left: -0.25rem;
      margin-right: -0.25rem;
      padding-left: 0.25rem;
      padding-right: 0.25rem;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
      overscroll-behavior-x: contain;
    }
    .report-filter-outer::-webkit-scrollbar { display: none; height: 0; }
    .report-filter-row {
      display: inline-flex;
      flex-wrap: nowrap;
      gap: 8px;
      vertical-align: top;
      min-width: min-content;
    }
    /* Ghi đè .btn/.btn-primary (width:100%, min-height lớn) — chỉ tab đang chọn có class .btn */
    .report-filter-btn {
      flex: 0 0 auto;
      flex-shrink: 0;
      width: auto !important;
      max-width: none;
      white-space: nowrap;
      min-height: unset !important;
      padding: 6px 12px !important;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      text-align: center;
      line-height: 1.2;
      box-sizing: border-box;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    }
    .report-filter-outer .report-filter-btn.btn-primary {
      background: linear-gradient(135deg, #f59e0b, #f97316);
      color: #fff;
      border: none;
      box-shadow: 0 2px 8px rgba(245, 158, 11, 0.32);
    }
  </style>
</head>
<body class="bg-bg text-main min-h-screen pb-20">
  <!-- TOP BAR -->
  <header class="fixed top-0 left-0 right-0 z-50 report-page-header">
    <div class="report-page-header-inner">
      <div class="flex items-center justify-between px-4 h-12">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-xl shrink-0">📊</span>
          <span class="font-semibold text-sm truncate">Báo cáo</span>
        </div>
        <div class="flex gap-3 text-xl shrink-0">
          <a href="/" class="text-muted hover:bg-bg-hover px-2 rounded">🏠</a>
        </div>
      </div>
    </div>
  </header>

  <main class="p-4 pt-14 pb-24 animate-fade report-main">
    <!-- Quick Report Links -->
    <div class="mb-4">
      <div class="grid grid-cols-3 gap-3">
        <a href="/report/profit-product" class="card text-center py-4 bg-primary/10 border-primary/20 hover:shadow-md transition-all">
          <div class="text-2xl mb-1">📦</div>
          <div class="text-xs font-semibold text-primary">Lợi nhuận<br>sản phẩm</div>
        </a>
        <a href="/report/profit-customer" class="card text-center py-4 bg-info/10 border-info/20 hover:shadow-md transition-all">
          <div class="text-2xl mb-1">👥</div>
          <div class="text-xs font-semibold text-info">Lợi nhuận<br>khách hàng</div>
        </a>
        <a href="/report/import-purchases" class="card text-center py-4 bg-success/10 border-success/20 hover:shadow-md transition-all">
          <div class="text-2xl mb-1">📥</div>
          <div class="text-xs font-semibold text-success">Báo cáo<br>nhập hàng</div>
        </a>
      </div>
    </div>

    <!-- Period: wrapper cuộn + hàng inline-flex (tránh flex min-width:auto làm tràn viewport) -->
    <div class="mb-4 w-full min-w-0 max-w-full">
      <div class="report-filter-outer">
        <div class="report-filter-row">
        <a href="/report?period=today" class="report-filter-btn ${period === 'today' ? 'btn btn-primary' : 'bg-card text-muted border border-muted hover:bg-bg-hover'}">Hôm nay</a>
        <a href="/report?period=yesterday" class="report-filter-btn ${period === 'yesterday' ? 'btn btn-primary' : 'bg-card text-muted border border-muted hover:bg-bg-hover'}">Hôm qua</a>
        <a href="/report?period=week" class="report-filter-btn ${period === 'week' ? 'btn btn-primary' : 'bg-card text-muted border border-muted hover:bg-bg-hover'}">7 ngày</a>
        <a href="/report?period=thisMonth" class="report-filter-btn ${period === 'thisMonth' ? 'btn btn-primary' : 'bg-card text-muted border border-muted hover:bg-bg-hover'}">Tháng này</a>
        <a href="/report?period=lastMonth" class="report-filter-btn ${period === 'lastMonth' ? 'btn btn-primary' : 'bg-card text-muted border border-muted hover:bg-bg-hover'}">Tháng trước</a>
        </div>
      </div>
    </div>

    <!-- Period Stats -->
    <div class="mb-4">
      <div class="section-title">${periodLabel}</div>
      <div class="grid grid-cols-2 gap-3">
        <div class="card stat-card--green">
          <div class="sc-label"><span class="sc-icon">💵</span> Doanh thu</div>
          <div class="sc-value text-xl"><div class="money text-money"><span class="value font-bold tabular-nums">${formatVNDNumber(periodStats.revenue)}</span><span class="unit">đ</span></div></div>
        </div>
        <div class="card stat-card--emerald">
          <div class="sc-label"><span class="sc-icon">📈</span> Lợi nhuận gộp</div>
          <div class="sc-value text-xl" style="color:#059669">${formatVND(periodStats.profit)}</div>
        </div>
        <div class="card stat-card--danger">
          <div class="sc-label"><span class="sc-icon">📉</span> Chi phí</div>
          <div class="sc-value text-xl" style="color:#dc2626">-${formatVND(periodExpenses.total)}</div>
        </div>
        <div class="card stat-card--info">
          <div class="sc-label"><span class="sc-icon">✨</span> Lợi nhuận ròng</div>
          <div class="sc-value text-xl" style="color:#2563eb">${formatVND(netProfit)}</div>
        </div>
        <div class="card stat-card--success">
          <div class="sc-label"><span class="sc-icon">📋</span> Đơn hàng</div>
          <div class="sc-value text-xl">${periodStats.order_count}</div>
        </div>
        <div class="card stat-card--warning">
          <div class="sc-label"><span class="sc-icon">🍺</span> Sản phẩm</div>
          <div class="sc-value text-xl">${periodStats.total_quantity}</div>
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

    <!-- All Time Stats -->
    <div class="mb-4">
      <div class="section-title">Tất cả thời gian</div>
      <div class="grid grid-cols-2 gap-3">
        <div class="card stat-card--green">
          <div class="sc-label"><span class="sc-icon">💵</span> Doanh thu</div>
          <div class="sc-value"><div class="money text-money"><span class="value font-bold tabular-nums">${formatVNDNumber(allTimeStats.revenue)}</span><span class="unit">đ</span></div></div>
        </div>
        <div class="card stat-card--emerald">
          <div class="sc-label"><span class="sc-icon">📈</span> Lợi nhuận gộp</div>
          <div class="sc-value" style="color:#059669">${formatVND(allTimeStats.profit)}</div>
        </div>
        <div class="card stat-card--danger">
          <div class="sc-label"><span class="sc-icon">📉</span> Tổng chi phí</div>
          <div class="sc-value" style="color:#dc2626">-${formatVND(allTimeExpenses.total)}</div>
        </div>
        <div class="card stat-card--info">
          <div class="sc-label"><span class="sc-icon">✨</span> Lợi nhuận ròng</div>
          <div class="sc-value" style="color:#2563eb">${formatVND(allTimeNetProfit)}</div>
        </div>
        <div class="card stat-card--success">
          <div class="sc-label"><span class="sc-icon">📋</span> Đơn hàng</div>
          <div class="sc-value">${allTimeStats.order_count}</div>
        </div>
        <div class="card stat-card--warning">
          <div class="sc-label"><span class="sc-icon">🍺</span> Sản phẩm</div>
          <div class="sc-value">${allTimeStats.total_quantity}</div>
        </div>
      </div>
    </div>

    <!-- Top Customers -->
    <div class="mb-4">
      <div class="section-title">Top khách hàng</div>
      <div class="space-y-2">
        ${topCustomers.length === 0 ? '<div class="empty-state">Chưa có dữ liệu</div>' : topCustomers.map((c, i) => `
          <div class="card card--list-item">
            <div class="flex justify-between items-center">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shadow-sm ${i === 0 ? 'bg-success/20 text-success' : i === 1 ? 'bg-info/20 text-info' : i === 2 ? 'bg-warning/20 text-warning' : 'bg-bg text-muted'}">${i + 1}</div>
                <div>
                  <div class="font-bold text-sm">${c.name}</div>
                  <div class="text-xs text-muted">${c.order_count} đơn · ${c.quantity} sản phẩm</div>
                </div>
              </div>
              <div class="text-right">
                <div class="font-bold text-success">${formatVND(c.revenue)}</div>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Top Products -->
    <div class="mb-4">
      <div class="section-title">Top sản phẩm bán chạy</div>
      <div class="space-y-2">
        ${topProducts.length === 0 ? '<div class="empty-state">Chưa có dữ liệu</div>' : topProducts.map((p, i) => `
          <div class="card card--list-item">
            <div class="flex justify-between items-center">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shadow-sm ${i === 0 ? 'bg-success/20 text-success' : i === 1 ? 'bg-info/20 text-info' : i === 2 ? 'bg-warning/20 text-warning' : 'bg-bg text-muted'}">${i + 1}</div>
                <div>
                  <div class="font-bold text-sm">${p.name}</div>
                  <div class="text-xs text-muted">Doanh thu: ${formatVND(p.revenue)}</div>
                </div>
              </div>
              <div class="text-right">
                <div class="font-bold text-warning">${p.quantity_sold}</div>
                <div class="text-xs text-muted">sản phẩm</div>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Recent Sales -->
    <div class="mb-4">
      <div class="section-title">📋 Đơn hàng gần đây <span class="text-xs font-normal text-muted">(${total} đơn)</span></div>
      <div class="card overflow-hidden" id="recentSalesList">
        ${recentSales.length === 0 ? '<div class="text-muted text-center py-4">Chưa có đơn hàng</div>' : recentSales.map(s => {
          const date = new Date(s.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
          const hasKegUpdate = (s.deliver_kegs || 0) > 0 || (s.return_kegs || 0) > 0;
          
          let typeBadge = '';
          let totalDisplay = '';
          let rowClass = '';
          
          if (s.type === 'replacement') {
            typeBadge = '<span class="bg-warning/10 text-warning px-1.5 py-0.5 rounded text-xs">🔁 Đổi lỗi</span>';
            totalDisplay = '<span class="font-bold text-warning">0 đ</span>';
            rowClass = 'bg-warning/5/50';
          } else {
            totalDisplay = '<span class="font-bold text-success">' + formatVND(s.total) + '</span>';
          }
          
          return '<div class="flex justify-between items-center p-3 border-b border-muted last:border-0 hover:bg-hover transition-colors ' + rowClass + '">' +
            '<div class="flex-1">' +
              '<div class="font-medium text-sm">#' + s.id + ' - ' + (s.customer_name || 'Khách lẻ') + ' ' + typeBadge + '</div>' +
              '<div class="text-xs text-muted mt-0.5">' + date + (hasKegUpdate ? ' · 📦' : '') + '</div>' +
            '</div>' +
            '<div class="text-right ml-3">' +
              totalDisplay +
              (s.type !== 'replacement' ? '<div class="text-xs ' + (s.profit > 0 ? 'text-success' : 'text-danger') + '">+' + formatVND(s.profit) + '</div>' : '') +
            '</div>' +
          '</div>';
        }).join('')}
        ${totalPages > 1 ? '<div class="flex justify-center items-center gap-2 mt-3 py-3 bg-card" id="salesPagination">' +
          '<button type="button" onclick="loadReportSales(' + (page - 1) + ')" ' + (page === 1 ? 'disabled' : '') + ' class="px-4 py-2 rounded-lg min-w-[4rem] ' + (page === 1 ? 'bg-muted text-muted cursor-not-allowed' : 'bg-card border border-muted text-primary hover:bg-hover shadow-sm') + '">‹ Trước</button>' +
          '<span class="text-sm text-main px-2">' + page + '/' + totalPages + '</span>' +
          '<button type="button" onclick="loadReportSales(' + (page + 1) + ')" ' + (page === totalPages ? 'disabled' : '') + ' class="px-4 py-2 rounded-lg min-w-[4rem] ' + (page === totalPages ? 'bg-muted text-muted cursor-not-allowed' : 'bg-card border border-muted text-primary hover:bg-hover shadow-sm') + '">Sau ›</button>' +
        '</div>' : ''}
      </div>
    </div>

    <script>
      const currentPeriod = '${period}';
      const reportSalesPagination = { page: ${page}, totalPages: ${totalPages}, total: ${total} };
      const dailyStats = ${JSON.stringify(dailyStats || [])};
      
      function formatVND(amount) {
        if (amount === null || amount === undefined || amount === '') return '0 đ';
        const num = Number(amount);
        if (isNaN(num)) return '0 đ';
        return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
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
          container.innerHTML = '<div class="text-primary text-center py-4">Chưa có đơn hàng</div>';
          return;
        }
        
        let html = data.sales.map(s => {
          const date = new Date(s.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
          const hasKegUpdate = (s.deliver_kegs || 0) > 0 || (s.return_kegs || 0) > 0;
          
          let typeBadge = '';
          let totalDisplay = '';
          let rowClass = '';
          
          if (s.type === 'replacement') {
            typeBadge = '<span class="bg-warning/10 text-warning px-1.5 py-0.5 rounded text-xs">🔁 Đổi lỗi</span>';
            totalDisplay = '<span class="font-bold text-warning">0 đ</span>';
            rowClass = 'bg-warning/5';
          } else {
            totalDisplay = '<span class="font-bold text-success">' + formatVND(s.total) + '</span>';
          }
          
          return '<div class="flex justify-between items-center p-2 border-b ' + rowClass + '">' +
            '<div>' +
              '<div class="font-medium">#' + s.id + ' - ' + (s.customer_name || 'Khách lẻ') + ' ' + typeBadge + '</div>' +
              '<div class="text-xs text-primary">' + date + (hasKegUpdate ? ' • 📦' : '') + '</div>' +
            '</div>' +
            '<div class="text-right">' +
              totalDisplay +
              (s.type !== 'replacement' ? '<div class="text-xs ' + (s.profit > 0 ? 'text-success' : 'text-danger') + '">+' + formatVND(s.profit) + '</div>' : '') +
            '</div>' +
          '</div>';
        }).join('');
        
        if (reportSalesPagination.totalPages > 1) {
          const p = reportSalesPagination.page;
          const tp = reportSalesPagination.totalPages;
          const prevDisabled = p === 1;
          const nextDisabled = p === tp;
            html += '<div class="flex justify-center items-center gap-2 mt-3 py-3 bg-card" id="salesPagination">' +
              '<button type="button" onclick="loadReportSales(' + (p - 1) + ')" ' + (prevDisabled ? 'disabled' : '') + ' class="px-4 py-2 rounded-lg min-w-[4rem] ' + (prevDisabled ? 'bg-muted text-muted cursor-not-allowed' : 'bg-card border border-muted text-primary hover:bg-hover shadow-sm') + '">‹ Trước</button>' +
            '<span class="text-sm text-main px-2">' + p + '/' + tp + '</span>' +
              '<button type="button" onclick="loadReportSales(' + (p + 1) + ')" ' + (nextDisabled ? 'disabled' : '') + ' class="px-4 py-2 rounded-lg min-w-[4rem] ' + (nextDisabled ? 'bg-muted text-muted cursor-not-allowed' : 'bg-card border border-muted text-primary hover:bg-hover shadow-sm') + '">Sau ›</button>' +
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
  const { startDate, endDate, todayKey } = getDateRange(period);
  
  let salesQuery = `
    SELECT s.id, s.customer_id, s.date, s.total, s.profit, s.type, s.deliver_kegs, s.return_kegs, c.name as customer_name,
      (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id) as quantity
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
  `;
  
  let countQuery = `SELECT COUNT(*) as total FROM sales s`;
  let whereClause = '';
  
  if (period === 'thisMonth') {
    const ym = todayKey.slice(0, 7);
    whereClause = ` WHERE strftime('%Y-%m', s.date) = '${ym}'`;
  } else if (period === 'lastMonth') {
    const ym = startDate.split(' ')[0].slice(0, 7);
    whereClause = ` WHERE strftime('%Y-%m', s.date) = '${ym}'`;
  } else if (period === 'today') {
    whereClause = ` WHERE date(s.date) = date('${todayKey}')`;
  } else if (period === 'yesterday') {
    const yk = startDate.split(' ')[0];
    whereClause = ` WHERE date(s.date) = date('${yk}')`;
  } else if (period === 'week') {
    const d0 = startDate.split(' ')[0];
    const d1 = endDate.split(' ')[0];
    whereClause = ` WHERE date(s.date) >= date('${d0}') AND date(s.date) <= date('${d1}')`;
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
  const { month, year, startDate, endDate } = req.query;
  const now = new Date();
  let startStr, endStr, labelThangNam;

  if (month && year) {
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    const lastDay = new Date(y, m, 0).getDate();
    startStr = `${y}-${String(m).padStart(2, '0')}-01`;
    endStr = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const thang = ['', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'][m];
    labelThangNam = thang + ' / ' + y;
  } else if (startDate && endDate) {
    startStr = startDate.split(' ')[0];
    endStr = endDate.split(' ')[0];
    labelThangNam = startStr + ' → ' + endStr;
  } else {
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const lastDay = new Date(y, m, 0).getDate();
    startStr = `${y}-${String(m).padStart(2, '0')}-01`;
    endStr = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const thang = ['', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'][m];
    labelThangNam = thang + ' / ' + y;
  }
  
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
    WHERE (s.status IS NULL OR s.status != 'returned')
  `;
  
  const params = [];
  if (startStr && endStr) {
    query += ` AND date(s.date) >= date(?) AND date(s.date) <= date(?)`;
    params.push(startStr, endStr);
  }
  
  query += ` GROUP BY p.id ORDER BY profit DESC`;
  
  const products = db.prepare(query).all(...params);
  
  const totalRevenue = products.reduce((sum, r) => sum + (r.revenue || 0), 0);
  const totalCost = products.reduce((sum, r) => sum + (r.cost || 0), 0);
  const totalProfit = products.reduce((sum, r) => sum + (r.profit || 0), 0);
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
  <title>Lợi nhuận theo sản phẩm - Beer POS</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#f59e0b">
  <meta name="mobile-web-app-capable" content="yes">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <link rel="icon" type="image/png" href="/icon-192.png">
  <link rel="stylesheet" href="/css/tailwind.css">
  <link rel="stylesheet" href="/css/unified.css?v=20260414">
  <script src="/js/dark-mode.js"></script>
  <script src="/js/auth.js"></script>
  <style>
    .bottomnav { max-width: 500px; margin: auto; }
    .filter-wrap { overflow: visible !important; }
  </style>
</head>
<body class="bg-bg text-main min-h-screen pb-20">
  <header class="fixed top-0 left-0 right-0 z-50">
    <div class="max-w-md mx-auto px-0">
      <div class="flex items-center justify-between px-4 h-12">
        <div class="flex items-center gap-2 min-w-0">
          <a href="/report" class="text-muted shrink-0">←</a>
          <span class="font-semibold text-sm truncate">Lợi nhuận sản phẩm</span>
        </div>
      </div>
    </div>
  </header>
  <main class="p-4 pt-14 pb-24 max-w-md mx-auto">
    <div class="filter-wrap" style="background: #fef3c7; border-radius: 16px; border: 2px solid #f59e0b; padding: 16px; margin-bottom: 16px; overflow: visible;">
      <div class="flex items-center gap-2 mb-3">
        <span style="color: #92400e; font-size: 14px; font-weight: 600;">📅 Theo tháng - năm</span>
      </div>
      <div class="flex gap-2 items-center">
        <select id="selMonthProd" style="flex: 1; border: 2px solid #f59e0b; border-radius: 8px; padding: 10px 12px; font-size: 14px; background: white; color: #1f2937; min-width: 0; outline: none;">
          ${monthOptions}
        </select>
        <select id="selYearProd" style="flex: 1; border: 2px solid #f59e0b; border-radius: 8px; padding: 10px 12px; font-size: 14px; background: white; color: #1f2937; min-width: 0; outline: none;">
          ${yearOptions}
        </select>
        <button type="button" onclick="applyMonthYearProduct()" style="background: #ea580c; color: white; border: none; border-radius: 8px; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap;">Xem</button>
      </div>
      <div class="text-xs text-muted mt-1">Đang xem: ${labelThangNam}</div>
    </div>
    <div class="card card--summary-purple mb-4 rounded-2xl overflow-hidden shadow-lg">
      <div class="grid grid-cols-3 gap-3 text-center py-4 px-4">
        <div>
          <div class="sum-label">Doanh thu</div>
          <div class="sum-value">${formatVND(totalRevenue)}</div>
        </div>
        <div>
          <div class="sum-label">Chi phí</div>
          <div class="sum-value">${formatVND(totalCost)}</div>
        </div>
        <div>
          <div class="sum-label">Lợi nhuận</div>
          <div class="sum-value">${formatVND(totalProfit)}</div>
        </div>
      </div>
    </div>
    <div class="space-y-2">
      ${products.length === 0 ? '<div class="empty-state">Chưa có dữ liệu</div>' : products.map((p, i) => `
        <div class="card card--list-item">
          <div class="flex justify-between items-center">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shadow-sm ${i === 0 ? 'bg-success/20 text-success' : i === 1 ? 'bg-info/20 text-info' : i === 2 ? 'bg-warning/20 text-warning' : 'bg-bg text-muted'}">${i + 1}</div>
              <div>
                <div class="font-bold">${p.name}</div>
                <div class="text-xs text-muted">${p.total_qty} sản phẩm · ${formatVND(p.revenue)}</div>
              </div>
            </div>
            <div class="text-right">
              <div class="font-bold text-success">${formatVND(p.profit || 0)}</div>
              <div class="text-xs text-muted">${((p.profit || 0) / (p.revenue || 1) * 100).toFixed(1)}%</div>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  </main>
  <div id="bottomNavContainer"></div>
  <script>if (!isLoggedIn()) { window.location.href = '/login'; }</script>
  <script>
    function applyMonthYearProduct() {
      const m = document.getElementById('selMonthProd').value;
      const y = document.getElementById('selYearProd').value;
      window.location.href = '/report/profit-product?month=' + m + '&year=' + y;
    }
    const bottomNav = getBottomNav('/report');
    document.getElementById('bottomNavContainer').innerHTML = bottomNav;
  </script>
</body>
</html>
  `);
});

// GET /report/profit-customer - Báo cáo lợi nhuận theo khách hàng (theo tháng - năm)
router.get('/profit-customer', (req, res) => {
  const { month, year, startDate, endDate } = req.query;

  const now = new Date();
  let startStr, endStr, labelThangNam;

  if (month && year) {
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    const lastDay = new Date(y, m, 0).getDate();
    startStr = `${y}-${String(m).padStart(2, '0')}-01`;
    endStr = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const thang = ['', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'][m];
    labelThangNam = thang + ' / ' + y;
  } else if (startDate && endDate) {
    startStr = startDate.split(' ')[0];
    endStr = endDate.split(' ')[0];
    labelThangNam = startStr + ' → ' + endStr;
  } else {
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const lastDay = new Date(y, m, 0).getDate();
    startStr = `${y}-${String(m).padStart(2, '0')}-01`;
    endStr = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const thang = ['', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'][m];
    labelThangNam = thang + ' / ' + y;
  }

  const startDay = startStr.split(' ')[0];
  const endDay = endStr.split(' ')[0];
  const customers = db.prepare(`
    SELECT 
      c.id,
      c.name,
      COUNT(s.id) as total_orders,
      SUM(s.total) as revenue,
      SUM(s.profit) as profit,
      (SELECT COALESCE(SUM(si.quantity), 0)
       FROM sale_items si
       JOIN sales s2 ON s2.id = si.sale_id
       WHERE s2.customer_id = c.id
         AND (s2.status IS NULL OR s2.status != 'returned')
         AND s2.type = 'sale'
         AND date(s2.date) >= date(?) AND date(s2.date) <= date(?)) as total_bins
    FROM sales s
    JOIN customers c ON c.id = s.customer_id
    WHERE (s.status IS NULL OR s.status != 'returned') AND s.type = 'sale' AND c.archived = 0
      AND date(s.date) >= date(?) AND date(s.date) <= date(?)
    GROUP BY c.id ORDER BY profit DESC
  `).all(startDay, endDay, startDay, endDay);

  const totalRevenue = customers.reduce((sum, r) => sum + (r.revenue || 0), 0);
  const totalProfit = customers.reduce((sum, r) => sum + (r.profit || 0), 0);
  const totalBins = customers.reduce((sum, r) => sum + (r.total_bins || 0), 0);

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
  <meta name="mobile-web-app-capable" content="yes">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <link rel="icon" type="image/png" href="/icon-192.png">
  <link rel="stylesheet" href="/css/tailwind.css">
  <link rel="stylesheet" href="/css/unified.css?v=20260414">
  <script src="/js/dark-mode.js"></script>
  <script src="/js/auth.js"></script>
  <script src="/js/layout.js?v=20260403"></script>
  <style>
    .bottomnav { max-width: 500px; margin: auto; }
    .filter-wrap { overflow: visible !important; }
  </style>
</head>
<body class="bg-bg text-main min-h-screen pb-20">
  <header class="sticky top-0 bg-card border-b border-muted z-50">
    <div class="flex items-center justify-between px-4 h-12 max-w-md mx-auto">
      <div class="flex items-center gap-2">
        <a href="/report" class="text-muted">←</a>
        <span class="font-semibold text-sm">Lợi nhuận khách hàng</span>
      </div>
    </div>
  </header>
  <main class="p-4 pt-14 pb-24 max-w-md mx-auto">
    <div style="background: #fef3c7; border-radius: 16px; border: 2px solid #f59e0b; padding: 16px; margin-bottom: 16px; overflow: visible;">
      <div class="flex items-center gap-2 mb-3">
        <span style="color: #92400e; font-size: 14px; font-weight: 600;">📅 Theo tháng - năm</span>
      </div>
      <div class="flex gap-2 items-center">
        <select id="selMonth" style="flex: 1; border: 2px solid #f59e0b; border-radius: 8px; padding: 10px 12px; font-size: 14px; background: white; color: #1f2937; min-width: 0; outline: none;">
          ${monthOptions}
        </select>
        <select id="selYear" style="flex: 1; border: 2px solid #f59e0b; border-radius: 8px; padding: 10px 12px; font-size: 14px; background: white; color: #1f2937; min-width: 0; outline: none;">
          ${yearOptions}
        </select>
        <button type="button" onclick="applyMonthYear()" style="background: #ea580c; color: white; border: none; border-radius: 8px; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap;">Xem</button>
      </div>
      <div class="text-xs text-muted mt-1">Đang xem: ${labelThangNam}</div>
    </div>
    <div class="card card--summary-blue mb-4 rounded-2xl overflow-hidden shadow-lg">
      <div class="grid grid-cols-3 gap-2 text-center py-4 px-4">
        <div>
          <div class="sum-label">Tổng doanh thu</div>
          <div class="sum-value" style="font-size:1rem">${formatVND(totalRevenue)}</div>
        </div>
        <div>
          <div class="sum-label">Tổng lợi nhuận</div>
          <div class="sum-value" style="font-size:1rem">${formatVND(totalProfit)}</div>
        </div>
        <div>
          <div class="sum-label">Tổng số bình</div>
          <div class="sum-value">${totalBins}</div>
        </div>
      </div>
    </div>
    <div class="space-y-2">
      ${customers.length === 0 ? '<div class="empty-state">Chưa có dữ liệu trong tháng này</div>' : customers.map((c, i) => `
        <div class="card card--list-item"><a href="/customers/${c.id}" class="flex justify-between items-center">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shadow-sm ${i === 0 ? 'bg-success/20 text-success' : i === 1 ? 'bg-info/20 text-info' : i === 2 ? 'bg-warning/20 text-warning' : 'bg-bg text-muted'}">${i + 1}</div>
            <div>
              <div class="font-bold">${c.name}</div>
              <div class="text-xs text-muted">${c.total_orders} đơn hàng · ${c.total_bins || 0} bình</div>
            </div>
          </div>
          <div class="text-right">
            <div class="font-bold text-success">${formatVND(c.profit || 0)}</div>
            <div class="text-xs text-muted">${formatVND(c.revenue || 0)}</div>
          </div>
        </a></div>
      `).join('')}
    </div>
  </main>
  <div id="bottomNavContainer"></div>
  <script>if (!isLoggedIn()) { window.location.href = '/login'; }</script>
  <script>
    function applyMonthYear() {
      const m = document.getElementById('selMonth').value;
      const y = document.getElementById('selYear').value;
      window.location.href = '/report/profit-customer?month=' + m + '&year=' + y;
    }
    (function() {
      var el = document.getElementById('bottomNavContainer');
      if (el && typeof getBottomNav === 'function') el.innerHTML = getBottomNav('/report');
    })();
  </script>
</body>
</html>
  `);
});

// GET /report/import-purchases - Báo cáo nhập hàng (theo tháng - năm, giống profit-customer)
router.get('/import-purchases', (req, res) => {
  const { month, year, startDate, endDate } = req.query;

  const now = new Date();
  let startStr, endStr, labelThangNam;

  if (month && year) {
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    const lastDay = new Date(y, m, 0).getDate();
    startStr = `${y}-${String(m).padStart(2, '0')}-01`;
    endStr = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const thang = ['', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'][m];
    labelThangNam = thang + ' / ' + y;
  } else if (startDate && endDate) {
    startStr = startDate.split(' ')[0];
    endStr = endDate.split(' ')[0];
    labelThangNam = startStr + ' → ' + endStr;
  } else {
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const lastDay = new Date(y, m, 0).getDate();
    startStr = `${y}-${String(m).padStart(2, '0')}-01`;
    endStr = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const thang = ['', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'][m];
    labelThangNam = thang + ' / ' + y;
  }

  const startDay = startStr.split(' ')[0];
  const endDay = endStr.split(' ')[0];

  const totals = db.prepare(`
    SELECT COUNT(*) as slip_count, COALESCE(SUM(total_amount), 0) as total_amount
    FROM purchases p
    WHERE date(p.date) >= date(?) AND date(p.date) <= date(?)
  `).get(startDay, endDay);

  const qtyRow = db.prepare(`
    SELECT COALESCE(SUM(pi.quantity), 0) as total_qty
    FROM purchase_items pi
    JOIN purchases p ON p.id = pi.purchase_id
    WHERE date(p.date) >= date(?) AND date(p.date) <= date(?)
  `).get(startDay, endDay);

  const purchasesList = db.prepare(`
    SELECT p.id, p.date, p.total_amount, p.note,
      (SELECT GROUP_CONCAT(pi.quantity || '× ' || pr.name)
       FROM purchase_items pi JOIN products pr ON pi.product_id = pr.id WHERE pi.purchase_id = p.id) as items_summary,
      (SELECT COUNT(*) FROM purchase_items WHERE purchase_id = p.id) as line_count
    FROM purchases p
    WHERE date(p.date) >= date(?) AND date(p.date) <= date(?)
    ORDER BY datetime(p.date) DESC, p.id DESC
  `).all(startDay, endDay);

  const byProduct = db.prepare(`
    SELECT pr.id, pr.name,
      SUM(pi.quantity) as qty,
      COALESCE(SUM(pi.total_price), 0) as amount
    FROM purchase_items pi
    JOIN purchases p ON p.id = pi.purchase_id
    JOIN products pr ON pr.id = pi.product_id
    WHERE date(p.date) >= date(?) AND date(p.date) <= date(?)
    GROUP BY pr.id
    ORDER BY amount DESC, qty DESC
  `).all(startDay, endDay);

  const slipCount = totals?.slip_count || 0;
  const totalAmount = totals?.total_amount || 0;
  const totalQty = qtyRow?.total_qty || 0;

  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const selectedMonth = month ? parseInt(month, 10) : currentMonth;
  const selectedYear = year ? parseInt(year, 10) : currentYear;

  const monthOptions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(m =>
    '<option value="' + m + '"' + (m === selectedMonth ? ' selected' : '') + '>Tháng ' + m + '</option>'
  ).join('');
  const yearOptions = [currentYear, currentYear - 1, currentYear - 2].map(y =>
    '<option value="' + y + '"' + (y === selectedYear ? ' selected' : '') + '>' + y + '</option>'
  ).join('');

  function formatPurchaseDay(raw) {
    if (!raw) return '—';
    const s = String(raw).trim().split(/[\sT]/)[0];
    const p = s.split('-');
    if (p.length === 3) return p[2] + '/' + p[1] + '/' + p[0];
    return s;
  }

  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Báo cáo nhập hàng - Beer POS</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#f59e0b">
  <meta name="mobile-web-app-capable" content="yes">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <link rel="icon" type="image/png" href="/icon-192.png">
  <link rel="stylesheet" href="/css/tailwind.css">
  <link rel="stylesheet" href="/css/unified.css?v=20260414">
  <script src="/js/dark-mode.js"></script>
  <script src="/js/auth.js"></script>
  <script src="/js/layout.js?v=20260403"></script>
  <style>
    .bottomnav { max-width: 500px; margin: auto; }
    .filter-wrap { overflow: visible !important; }
  </style>
</head>
<body class="bg-bg text-main min-h-screen pb-20">
  <header class="fixed top-0 left-0 right-0 z-50">
    <div class="max-w-md mx-auto px-0">
      <div class="flex items-center justify-between px-4 h-12">
        <div class="flex items-center gap-2 min-w-0">
          <a href="/report" class="text-muted shrink-0">←</a>
          <span class="font-semibold text-sm truncate">Báo cáo nhập hàng</span>
        </div>
      </div>
    </div>
  </header>
  <main class="p-4 pt-14 pb-24 max-w-md mx-auto">
    <div style="background: #fef3c7; border-radius: 16px; border: 2px solid #f59e0b; padding: 16px; margin-bottom: 16px; overflow: visible;">
      <div class="flex items-center gap-2 mb-3">
        <span style="color: #92400e; font-size: 14px; font-weight: 600;">📅 Theo tháng - năm</span>
      </div>
      <div class="flex gap-2 items-center">
        <select id="selMonthImp" style="flex: 1; border: 2px solid #f59e0b; border-radius: 8px; padding: 10px 12px; font-size: 14px; background: white; color: #1f2937; min-width: 0; outline: none;">
          ${monthOptions}
        </select>
        <select id="selYearImp" style="flex: 1; border: 2px solid #f59e0b; border-radius: 8px; padding: 10px 12px; font-size: 14px; background: white; color: #1f2937; min-width: 0; outline: none;">
          ${yearOptions}
        </select>
        <button type="button" onclick="applyMonthYearImport()" style="background: #ea580c; color: white; border: none; border-radius: 8px; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap;">Xem</button>
      </div>
      <div class="text-xs text-muted mt-1">Đang xem: ${labelThangNam}</div>
    </div>
    <div class="card card--summary-teal mb-4 rounded-2xl overflow-hidden shadow-lg">
      <div class="grid grid-cols-3 gap-2 text-center py-4 px-4">
        <div>
          <div class="sum-label">Tổng tiền nhập</div>
          <div class="sum-value" style="font-size:1rem">${formatVND(totalAmount)}</div>
        </div>
        <div>
          <div class="sum-label">Số phiếu</div>
          <div class="sum-value">${slipCount}</div>
        </div>
        <div>
          <div class="sum-label">Tổng SL</div>
          <div class="sum-value">${totalQty}</div>
        </div>
      </div>
    </div>
    <div class="section-title text-xs font-bold text-muted uppercase tracking-wide mb-2">Chi tiết phiếu nhập</div>
    <div class="space-y-2 mb-6">
      ${purchasesList.length === 0 ? '<div class="empty-state border-primary/20">Chưa có phiếu nhập trong tháng này</div>' : purchasesList.map((p) => `
        <div class="card card--list-item">
          <div class="flex justify-between items-start gap-2 mb-1">
            <div class="font-bold text-primary">#${p.id}</div>
            <div class="text-xs font-medium text-muted whitespace-nowrap">🗓 ${formatPurchaseDay(p.date)}</div>
          </div>
          <div class="text-lg font-bold text-success mb-1">${formatVND(p.total_amount || 0)}</div>
          ${p.items_summary ? `<div class="text-xs text-main leading-snug">${String(p.items_summary).replace(/,/g, ', ')}</div>` : ''}
          ${p.note ? `<div class="text-xs text-muted mt-1 italic">${String(p.note)}</div>` : ''}
        </div>
      `).join('')}
    </div>
    <div class="section-title text-xs font-bold text-muted uppercase tracking-wide mb-2">Tổng hợp theo sản phẩm</div>
    <div class="space-y-2">
      ${byProduct.length === 0 ? '<div class="empty-state border-primary/20">Không có dòng hàng</div>' : byProduct.map((row, i) => `
        <div class="card card--list-item">
          <div class="flex justify-between items-center gap-2">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-9 h-9 rounded-full flex items-center justify-center font-bold text-xs shadow-sm shrink-0 ${i === 0 ? 'bg-success/20 text-success' : 'bg-info/20 text-info'}">${i + 1}</div>
              <div class="min-w-0">
                <div class="font-bold truncate">${row.name}</div>
                <div class="text-xs text-muted">${row.qty} đơn vị</div>
              </div>
            </div>
            <div class="text-right shrink-0">
              <div class="font-bold text-success">${formatVND(row.amount || 0)}</div>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
    <p class="text-center mt-4"><a href="/purchases?tab=history" class="text-sm text-primary font-semibold underline">Mở trang nhập hàng</a></p>
  </main>
  <div id="bottomNavContainer"></div>
  <script>if (!isLoggedIn()) { window.location.href = '/login'; }</script>
  <script>
    function applyMonthYearImport() {
      var m = document.getElementById('selMonthImp').value;
      var y = document.getElementById('selYearImp').value;
      window.location.href = '/report/import-purchases?month=' + m + '&year=' + y;
    }
    (function() {
      var el = document.getElementById('bottomNavContainer');
      if (el && typeof getBottomNav === 'function') el.innerHTML = getBottomNav('/report');
    })();
  </script>
</body>
</html>
  `);
});

module.exports = router;
