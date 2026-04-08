// ============================================================
// report_v2.js — 新报表引擎 (完全不依赖 products / customers 表)
// 设计原则:
//   - 所有数据从 sales + sale_items 两张表读取
//   - product_name / customer_name 来自快照字段（sale_items / sales）
//   - 即使 products / customers 为空，报表仍然正常工作
//
// 公开 API（挂载 window 对象）:
//   window.__reportV2.init()      — 初始化引擎
//   window.__reportV2.reload()   — 重新加载当前筛选条件的数据
//   window.__reportV2.setFilter(type, time, month, year)
// ============================================================

(function () {
  'use strict';

  // ── 全局状态 ───────────────────────────────────────────────
  var state = {
    type: 'sales',    // sales | product | customer | import
    time: 'today',    // today | yesterday | month | year
    month: new Date().getMonth() + 1,
    year: new Date().getFullYear()
  };

  var _data         = null;   // 当前加载的报表数据
  var _loadTimer    = null;
  var _loading      = false;
  var _chart        = null;
  var _dbReadyFlag  = false;

  // ── 日期辅助（越南 UTC+7）─────────────────────────────────
  function getVietnamNow() {
    return new Date(new Date().getTime() + 7 * 3600000);
  }

  function getVietnamDate() {
    var vn = getVietnamNow();
    return { y: vn.getUTCFullYear(), m: vn.getUTCMonth(), d: vn.getUTCDate() };
  }

  // dateRangeStr = { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
  // 用于 IndexedDB .where('date').between()
  function getDateRange() {
    var vdate = getVietnamDate();
    var y = vdate.y, m = vdate.m, d = vdate.d;

    function str(yr, mo, day) {
      return yr + '-' + String(mo + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    }

    if (state.time === 'today') {
      return { start: str(y, m, d), end: str(y, m, d) };
    }
    if (state.time === 'yesterday') {
      var yesterday = new Date(Date.UTC(y, m, d) - 8 * 3600000);
      yesterday.setDate(yesterday.getDate() - 1);
      return {
        start: str(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate()),
        end:   str(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate())
      };
    }
    if (state.time === 'month') {
      var lastD = new Date(Date.UTC(state.year, state.month, 0)).getUTCDate();
      return { start: str(state.year, state.month - 1, 1), end: str(state.year, state.month - 1, lastD) };
    }
    if (state.time === 'year') {
      return { start: state.year + '-01-01', end: state.year + '-12-31' };
    }
    return { start: str(y, m, d), end: str(y, m, d) };
  }

  // 带时间戳的 Date 范围（用于更精确的过滤）
  function getDateRangeFull() {
    var r = getDateRange();
    var start = new Date(r.start + 'T00:00:00+07:00');
    var end   = new Date(r.end   + 'T23:59:59+07:00');
    return { start: start, end: end };
  }

  // ── 格式化金额 ────────────────────────────────────────────
  function fmt(n) {
    return new Intl.NumberFormat('vi-VN').format(n || 0) + ' đ';
  }

  function fmtM(n) {
    return (new Intl.NumberFormat('vi-VN').format(n || 0)) + ' đ';
  }

  // ── 等待 DB ───────────────────────────────────────────────
  function waitForDB() {
    return new Promise(function (resolve, reject) {
      if (!window.db) {
        reject(new Error('window.db 不存在'));
        return;
      }
      if (window.dbReady) {
        window.dbReady.then(resolve).catch(reject);
      } else {
        resolve();
      }
    });
  }

  // ══════════════════════════════════════════════════════════
  // CORE: 加载所有数据（只执行一次，通过 filter 筛选）
  // 不做 JOIN，只做内存中的 filter + aggregate
  // ══════════════════════════════════════════════════════════
  async function loadAllData() {
    var db = window.db;
    var dateRange = getDateRangeFull();
    var dateStr   = getDateRange();

    // 1. 查询符合日期范围的 sales
    var sales = [];
    try {
      sales = await db.sales
        .where('date')
        .between(dateStr.start, dateStr.end + '\xff', true, true)
        .toArray();
    } catch (e) {
      console.warn('[REPORT_V2] sales 查询失败:', e.message || e);
      sales = [];
    }

    if (sales.length === 0) {
      console.log('[REPORT_V2] 指定日期范围内无销售数据:', dateStr.start, '→', dateStr.end);
    } else {
      console.log('[REPORT_V2] 加载销售单:', sales.length, '条 | 日期范围:', dateStr.start, '→', dateStr.end);
    }

    // 2. 查询所有 sale_items
    var saleIds = sales.map(function (s) { return s.id; });
    var items = [];
    if (saleIds.length > 0) {
      try {
        items = await db.sale_items.where('sale_id').anyOf(saleIds).toArray();
      } catch (e) {
        console.warn('[REPORT_V2] sale_items 查询失败:', e.message || e);
        items = [];
      }
    }

    // 3. 构建 item → sale 的内存索引（用于查找 product_name / customer_name）
    var saleMap = {};
    for (var i = 0; i < sales.length; i++) {
      saleMap[sales[i].id] = sales[i];
    }

    // 4. 为每个 item 注入快照字段（绝对不查 products 表）
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var sale = saleMap[it.sale_id] || {};

      // product_name: 优先用 item 自带的快照名，其次 fallback
      if (!it.product_name) {
        it.product_name = 'Sản phẩm #' + (it.product_id || '?');
      }

      // sell_price fallback（item.price 可能缺失）
      if (it.price == null || it.price === '') {
        it.price = 0;
      }

      // cost_price fallback（可能为 0）
      if (it.cost_price == null || it.cost_price === '') {
        it.cost_price = 0;
      }

      // profit fallback
      if (it.profit == null || it.profit === undefined || typeof it.profit !== 'number') {
        it.profit = (Number(it.price) - Number(it.cost_price)) * (Number(it.quantity) || 0);
        it.profit_estimated = true;
      } else {
        it.profit_estimated = !!(it.profit_estimated);
      }

      // customer_name: 从 sale 的快照字段读取
      it._customer_name = sale.customer_name || 'Khách lẻ';
    }

    // 5. 查询 expenses（用于 import 报表）
    var expenses = [];
    try {
      expenses = await db.expenses
        .where('date')
        .between(dateStr.start, dateStr.end, true, true)
        .toArray();
    } catch (e) {
      console.warn('[REPORT_V2] expenses 查询失败:', e.message || e);
    }

    return { sales: sales, items: items, expenses: expenses, dateRange: dateStr };
  }

  // ══════════════════════════════════════════════════════════
  // TASK 4a: 按产品统计利润
  // ══════════════════════════════════════════════════════════
  function getProfitByProduct(items) {
    var byProduct = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var key = it.product_name || ('SP#' + it.product_id);
      if (!byProduct[key]) {
        byProduct[key] = {
          product_id:   it.product_id || null,
          name:         key,
          quantity:     0,
          revenue:      0,
          cost:         0,
          profit:       0,
          estimated:    false
        };
      }
      var qty = Number(it.quantity) || 0;
      var price = Number(it.price) || 0;
      var costPrice = Number(it.cost_price) || 0;
      var profit = Number(it.profit) || 0;

      byProduct[key].quantity += qty;
      byProduct[key].revenue  += price * qty;
      byProduct[key].cost    += costPrice * qty;
      byProduct[key].profit  += profit;
      if (it.profit_estimated) byProduct[key].estimated = true;
    }
    var result = Object.values(byProduct);
    // 按利润降序
    result.sort(function (a, b) { return b.profit - a.profit; });
    return result;
  }

  // ══════════════════════════════════════════════════════════
  // TASK 4b: 按客户统计利润
  // ══════════════════════════════════════════════════════════
  function getProfitByCustomer(items, sales) {
    var byCustomer = {};
    // 建立 sale_id → customer_name 映射
    var saleNameMap = {};
    for (var i = 0; i < sales.length; i++) {
      saleNameMap[sales[i].id] = sales[i].customer_name || 'Khách lẻ';
    }

    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var key = saleNameMap[it.sale_id] || 'Khách lẻ';
      if (!byCustomer[key]) {
        byCustomer[key] = {
          name:         key,
          orderCount:   0,
          revenue:      0,
          cost:         0,
          profit:       0
        };
      }
      var qty = Number(it.quantity) || 0;
      var price = Number(it.price) || 0;
      var profit = Number(it.profit) || 0;

      byCustomer[key].orderCount += 1;  // 每条 item 算 1 条明细
      byCustomer[key].revenue    += price * qty;
      byCustomer[key].cost      += (Number(it.cost_price) || 0) * qty;
      byCustomer[key].profit    += profit;
    }
    var result = Object.values(byCustomer);
    // 按利润降序
    result.sort(function (a, b) { return b.profit - a.profit; });
    return result;
  }

  // ══════════════════════════════════════════════════════════
  // TASK 4c: 按日统计利润
  // ══════════════════════════════════════════════════════════
  function getProfitByTime(sales, items) {
    var byDate = {};
    // 建立 sale_id → date 映射
    var saleDateMap = {};
    for (var i = 0; i < sales.length; i++) {
      saleDateMap[sales[i].id] = (sales[i].date || '').split('T')[0];
    }

    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var dateKey = saleDateMap[it.sale_id] || '';
      if (!dateKey) continue;
      if (!byDate[dateKey]) {
        byDate[dateKey] = { date: dateKey, revenue: 0, cost: 0, profit: 0, orderCount: 0 };
      }
      var qty = Number(it.quantity) || 0;
      byDate[dateKey].revenue    += (Number(it.price) || 0) * qty;
      byDate[dateKey].cost      += (Number(it.cost_price) || 0) * qty;
      byDate[dateKey].profit    += Number(it.profit) || 0;
      byDate[dateKey].orderCount++;
    }
    var result = Object.values(byDate);
    result.sort(function (a, b) { return a.date.localeCompare(b.date); });
    return result;
  }

  // ── 每日数据（用于图表）───────────────────────────────────
  function buildDailyData(sales, items) {
    var byDate = {};
    var saleDateMap = {};
    for (var i = 0; i < sales.length; i++) {
      saleDateMap[sales[i].id] = (sales[i].date || '').split('T')[0];
    }
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var dateKey = saleDateMap[it.sale_id] || '';
      if (!dateKey) continue;
      if (!byDate[dateKey]) {
        byDate[dateKey] = { date: dateKey, revenue: 0, profit: 0, expense: 0 };
      }
      var qty = Number(it.quantity) || 0;
      byDate[dateKey].revenue += (Number(it.price) || 0) * qty;
      byDate[dateKey].profit  += Number(it.profit) || 0;
    }
    return Object.values(byDate).sort(function (a, b) { return a.date.localeCompare(b.date); });
  }

  // ══════════════════════════════════════════════════════════
  // 渲染入口
  // ══════════════════════════════════════════════════════════
  function renderReport(data, expenses) {
    _data = data;
    if (!_data) _data = emptyResult();

    updateSummary(_data, expenses);
    renderChart(_data);
    renderSalesList(_data.salesList || []);
    renderProductsList(_data.profitByProduct || []);
    renderCustomersList(_data.profitByCustomer || []);
    renderImportList(expenses || []);
    activateSection(_data.reportType);
    updatePeriodLabel();
  }

  // ── 更新摘要 ───────────────────────────────────────────────
  function updateSummary(data, expenses) {
    var totalRevenue = data.totalRevenue || 0;
    var grossProfit  = data.totalProfit  || 0;
    var orders       = data.totalOrders  || 0;
    var totalExpense = expenses ? expenses.reduce(function (s, e) { return s + (Number(e.amount) || 0); }, 0) : 0;
    var netProfit    = grossProfit - totalExpense;

    var el;
    el = document.getElementById('statRevenue'); if (el) el.textContent = fmtM(totalRevenue);
    el = document.getElementById('statProfit');  if (el) el.textContent = fmtM(netProfit);
    el = document.getElementById('statOrders');  if (el) el.textContent = orders;
    el = document.getElementById('statExpense'); if (el) el.textContent = fmtM(totalExpense);
    el = document.getElementById('headerProfit'); if (el) el.textContent = fmtM(netProfit);
  }

  // ── 渲染图表 ───────────────────────────────────────────────
  function renderChart(data) {
    var canvas = document.getElementById('chartCanvas');
    if (!canvas) return;
    if (!window.Chart) {
      var script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
      script.onload = function () { buildChart(data); };
      document.head.appendChild(script);
    } else {
      buildChart(data);
    }
  }

  function buildChart(data) {
    var canvas = document.getElementById('chartCanvas');
    if (!canvas || !window.Chart) return;

    var labels = [], revenues = [], netProfits = [];
    var daily = data.daily || [];
    for (var i = 0; i < daily.length; i++) {
      var d = daily[i];
      labels.push(d.date ? d.date.split('-').reverse().slice(0, 2).join('/') : '');
      revenues.push(d.revenue || 0);
      netProfits.push((d.profit || 0) - (d.expense || 0));
    }
    labels.reverse();
    revenues.reverse();
    netProfits.reverse();

    if (_chart) _chart.destroy();
    _chart = new window.Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: 'Doanh thu',       data: revenues,   backgroundColor: 'rgba(59,130,246,0.5)' },
          { label: 'Lợi nhuận ròng',  data: netProfits, backgroundColor: 'rgba(34,197,94,0.5)' }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#9ca3af', font: { size: 10 } } } },
        scales: {
          x: { ticks: { color: '#9ca3af', font: { size: 9 } }, grid: { color: '#374151' } },
          y: {
            ticks: { color: '#9ca3af', callback: function (v) { return (v / 1000000).toFixed(1) + 'M'; } },
            grid: { color: '#374151' }
          }
        }
      }
    });
  }

  // ── 渲染列表 ─────────────────────────────────────────────
  function renderSalesList(sales) {
    var el = document.getElementById('salesList');
    if (!el) return;
    if (!sales || sales.length === 0) {
      el.innerHTML = '<div class="text-center text-muted py-4">Không có đơn hàng</div>';
      return;
    }
    var html = [];
    for (var i = 0; i < sales.length; i++) {
      var s = sales[i];
      var dateStr = s.date ? s.date.split('T')[0].split('-').reverse().join('/') : '';
      html.push(
        '<div class="card p-3 flex items-center justify-between">' +
          '<div><div class="font-medium">' + escHtml(s.customer_name || 'Khách lẻ') + '</div><div class="text-xs text-muted">' + dateStr + '</div></div>' +
          '<div class="text-right">' +
            '<div class="font-bold tabular-nums">' + fmtM(s.total || 0) + '</div>' +
            '<div class="text-xs text-success">+' + fmtM(s.profit || 0) + '</div>' +
          '</div>' +
        '</div>'
      );
    }
    el.innerHTML = html.join('');
  }

  function renderProductsList(products) {
    var el = document.getElementById('productsList');
    if (!el) return;
    if (!products || products.length === 0) {
      el.innerHTML = '<div class="text-center text-muted py-4">Không có dữ liệu</div>';
      return;
    }
    var html = [];
    for (var i = 0; i < products.length; i++) {
      var p = products[i];
      var estimatedNote = p.estimated ? ' <span class="text-xs text-warning">(估算)</span>' : '';
      html.push(
        '<div class="card p-3 flex items-center justify-between">' +
          '<div class="flex-1 min-w-0">' +
            '<div class="font-medium truncate">' + escHtml(p.name || '') + estimatedNote + '</div>' +
            '<div class="text-xs text-muted">&#127858; ' + (p.quantity || 0) + ' bình</div>' +
          '</div>' +
          '<div class="text-right ml-3">' +
            '<div class="font-bold tabular-nums">' + fmtM(p.revenue || 0) + '</div>' +
            '<div class="text-xs text-success">+' + fmtM(p.profit || 0) + '</div>' +
          '</div>' +
        '</div>'
      );
    }
    el.innerHTML = html.join('');
  }

  function renderCustomersList(customers) {
    var el = document.getElementById('customersList');
    if (!el) return;
    if (!customers || customers.length === 0) {
      el.innerHTML = '<div class="text-center text-muted py-4">Không có dữ liệu</div>';
      return;
    }
    var html = [];
    for (var i = 0; i < customers.length; i++) {
      var c = customers[i];
      html.push(
        '<div class="card p-3 flex items-center justify-between">' +
          '<div class="flex-1 min-w-0">' +
            '<div class="font-medium truncate">' + escHtml(c.name || '') + '</div>' +
            '<div class="text-xs text-muted">&#127856; ' + (c.orderCount || 0) + ' đơn</div>' +
          '</div>' +
          '<div class="text-right ml-3">' +
            '<div class="font-bold tabular-nums">' + fmtM(c.revenue || 0) + '</div>' +
            '<div class="text-xs text-success">+' + fmtM(c.profit || 0) + '</div>' +
          '</div>' +
        '</div>'
      );
    }
    el.innerHTML = html.join('');
  }

  function renderImportList(expenses) {
    var el = document.getElementById('purchasesList');
    if (!el) return;
    var totalAmount = expenses.reduce(function (s, e) { return s + (Number(e.amount) || 0); }, 0);
    var summaryHtml =
      '<div class="grid grid-cols-2 gap-2 mb-3">' +
        '<div class="card p-3 text-center">' +
          '<div class="text-xs text-muted">Tổng chi phí</div>' +
          '<div class="font-bold text-danger tabular-nums" style="font-size:14px;">' + fmtM(totalAmount) + '</div>' +
        '</div>' +
        '<div class="card p-3 text-center">' +
          '<div class="text-xs text-muted">Số phiếu</div>' +
          '<div class="font-bold tabular-nums" style="font-size:14px;">' + expenses.length + '</div>' +
        '</div>' +
      '</div>';
    if (!expenses || expenses.length === 0) {
      el.innerHTML = summaryHtml + '<div class="text-center text-muted py-4">Không có dữ liệu nhập hàng</div>';
      return;
    }
    var html = [];
    for (var i = 0; i < expenses.length; i++) {
      var p = expenses[i];
      var dateStr = p.date ? p.date.split('T')[0].split('-').reverse().join('/') : '';
      html.push(
        '<div class="card p-3">' +
          '<div class="flex justify-between items-start mb-1">' +
            '<div class="font-bold text-primary">#' + (p.id || '?') + '</div>' +
            '<div class="text-xs text-muted">' + dateStr + '</div>' +
          '</div>' +
          '<div class="font-bold text-danger tabular-nums mb-1">' + fmtM(p.amount || 0) + '</div>' +
          (p.type ? '<div class="text-xs text-muted">' + escHtml(p.type) + '</div>' : '') +
          (p.note ? '<div class="text-xs text-muted italic">' + escHtml(p.note) + '</div>' : '') +
        '</div>'
      );
    }
    el.innerHTML = summaryHtml + html.join('');
  }

  // ── UI 状态 ───────────────────────────────────────────────
  function activateSection(type) {
    var sectionMap = { sales: 'reportSales', product: 'reportProducts', customer: 'reportCustomers', import: 'reportPurchases' };
    var sectionId = sectionMap[type] || 'reportSales';
    document.querySelectorAll('.report-section').forEach(function (el) {
      el.classList.toggle('active', el.id === sectionId);
    });
    document.querySelectorAll('.report-tab').forEach(function (btn) {
      var map = { sales: 'sales', products: 'product', customers: 'customer', purchases: 'import' };
      btn.classList.toggle('active', map[btn.dataset.tab] === type);
    });
  }

  function updatePeriodLabel() {
    var vn = getVietnamNow();
    var months = ['Tháng 1','Tháng 2','Tháng 3','Tháng 4','Tháng 5','Tháng 6',
                  'Tháng 7','Tháng 8','Tháng 9','Tháng 10','Tháng 11','Tháng 12'];
    var label = '';
    if (state.time === 'today')     label = 'Hôm nay, ' + toLocalDateStr(vn).split('-').reverse().join('/');
    else if (state.time === 'yesterday') label = 'Hôm qua';
    else if (state.time === 'month')     label = (months[state.month - 1] || 'Tháng ' + state.month) + ' ' + state.year;
    else if (state.time === 'year')       label = 'Năm ' + state.year;

    var el = document.getElementById('periodLabel');
    if (el) el.textContent = label;
  }

  function toLocalDateStr(d) {
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  function escHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── 空结果 ───────────────────────────────────────────────
  function emptyResult() {
    return {
      sales: [], salesList: [],
      totalRevenue: 0, totalProfit: 0, totalExpense: 0, totalOrders: 0,
      profitByProduct: [], profitByCustomer: [],
      daily: [], reportType: state.type
    };
  }

  // ══════════════════════════════════════════════════════════
  // 主加载流程
  // ══════════════════════════════════════════════════════════
  function showLoading() {
    _loading = true;
    ['salesList','productsList','customersList','purchasesList'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = '<div class="text-center text-muted py-4">Đang tải...</div>';
    });
  }

  function hideLoading() {
    _loading = false;
  }

  async function doLoad() {
    showLoading();
    try {
      await waitForDB();
      var raw = await loadAllData();

      var items  = raw.items;
      var sales  = raw.sales;
      var expenses = raw.expenses || [];

      // 计算各维度聚合
      var profitByProduct   = getProfitByProduct(items);
      var profitByCustomer  = getProfitByCustomer(items, sales);
      var daily            = buildDailyData(sales, items);

      // 按利润降序排列 salesList
      var salesList = sales.slice().sort(function (a, b) { return (b.profit || 0) - (a.profit || 0); });

      var totalRevenue = items.reduce(function (s, it) { return s + (Number(it.price) || 0) * (Number(it.quantity) || 0); }, 0);
      var totalProfit  = items.reduce(function (s, it) { return s + Number(it.profit) || 0; }, 0);
      var totalOrders  = sales.length;

      var data = {
        sales:             sales,
        salesList:         salesList,
        totalRevenue:      totalRevenue,
        totalProfit:       totalProfit,
        totalExpense:      0,
        totalOrders:       totalOrders,
        profitByProduct:   profitByProduct,
        profitByCustomer:  profitByCustomer,
        daily:             daily,
        reportType:        state.type
      };

      console.log('[REPORT_V2] 数据加载完成:', {
        sales: sales.length, items: items.length,
        totalRevenue: fmt(totalRevenue), totalProfit: fmt(totalProfit),
        profitByProduct: profitByProduct.length,
        profitByCustomer: profitByCustomer.length
      });

      hideLoading();
      renderReport(data, expenses);

    } catch (e) {
      console.error('[REPORT_V2] 加载失败:', e);
      hideLoading();
      renderReport(emptyResult(), []);
    }
  }

  function loadReport() {
    clearTimeout(_loadTimer);
    _loadTimer = setTimeout(doLoad, 50);
  }

  // ── 事件绑定 ───────────────────────────────────────────────
  function initEvents() {
    document.addEventListener('click', function (e) {
      var target = e.target;

      // 时间筛选按钮
      var timeBtn = target.closest('.filter-time-btn');
      if (timeBtn && timeBtn.dataset.time) {
        state.time = timeBtn.dataset.time;
        updateTimeButtons();
        updatePeriodLabel();
        loadReport();
        return;
      }

      // 报表类型按钮
      var typeBtn = target.closest('.report-type-btn');
      if (typeBtn && typeBtn.dataset.type) {
        state.type = typeBtn.dataset.type;
        updateTypeButtons();
        loadReport();
        return;
      }
    });

    // 月份选择
    var selMonth = document.getElementById('selMonth');
    if (selMonth) {
      selMonth.addEventListener('change', function () {
        state.month = parseInt(this.value, 10);
        state.time  = 'month';
        state.year  = state.year || new Date().getFullYear();
        updateTimeButtons();
        updatePeriodLabel();
        loadReport();
      });
    }

    // 年份选择
    var selYear = document.getElementById('selYear');
    if (selYear) {
      selYear.addEventListener('change', function () {
        state.year = parseInt(this.value, 10);
        state.time = state.time === 'year' ? 'year' : 'month';
        updateTimeButtons();
        updatePeriodLabel();
        loadReport();
      });
    }
  }

  function updateTimeButtons() {
    document.querySelectorAll('.filter-time-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.time === state.time);
    });
  }

  function updateTypeButtons() {
    document.querySelectorAll('.report-type-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.type === state.type);
    });
  }

  // ── 初始化（供外部调用）──────────────────────────────────
  function init() {
    console.log('[REPORT_V2] 初始化...');
    initEvents();

    // 填充月份/年份下拉
    var selMonth = document.getElementById('selMonth');
    if (selMonth && selMonth.children.length <= 1) {
      for (var mi = 1; mi <= 12; mi++) {
        var optM = document.createElement('option');
        optM.value = mi;
        optM.textContent = 'Tháng ' + mi;
        selMonth.appendChild(optM);
      }
    }
    var selYear = document.getElementById('selYear');
    if (selYear && selYear.children.length <= 1) {
      var cy = new Date().getFullYear();
      for (var yi = cy; yi >= cy - 4; yi--) {
        var optY = document.createElement('option');
        optY.value = yi;
        optY.textContent = yi;
        selYear.appendChild(optY);
      }
    }

    updateTimeButtons();
    updateTypeButtons();
    updatePeriodLabel();

    if (window.dbReady) {
      window.dbReady.then(function () {
        _dbReadyFlag = true;
        console.log('[REPORT_V2] DB 就绪，开始加载...');
        loadReport();
      }).catch(function () {
        console.warn('[REPORT_V2] DB 就绪失败，尝试加载...');
        loadReport();
      });
    } else {
      loadReport();
    }
  }

  // ── 公开 API ─────────────────────────────────────────────
  window.__reportV2 = {
    init: init,
    reload: loadReport,
    setFilter: function (type, time, month, year) {
      if (type)  state.type  = type;
      if (time)  state.time  = time;
      if (month) state.month = parseInt(month, 10);
      if (year)  state.year  = parseInt(year, 10);
      updateTimeButtons();
      updateTypeButtons();
      updatePeriodLabel();
      loadReport();
    },
    getState: function () { return state; },
    getData:  function () { return _data; }
  };

  console.log('[REPORT_V2] 引擎已加载 — 调用 window.__reportV2.init() 初始化');
})();
