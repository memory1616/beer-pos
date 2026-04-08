// BeerPOS Report Page - Refactored v3
// Global state: window.reportState
// Architecture: type(report) + time(filter) hoàn toàn tách biệt
(function () {
  // ── Global state (exposed on window) ─────────────────────────────────────
  var now = new Date();
  window.reportState = {
    type: 'sales',          // sales | product | customer | import
    time: 'today',          // today | yesterday | month | year
    month: now.getMonth() + 1,
    year: now.getFullYear()
  };

  // ── Local state ────────────────────────────────────────────────────────────
  var _reportData = {};
  var _chart = null;
  var _loadDebounce = null;
  var _isLoading = false;

  // ── Date helpers (Vietnam UTC+7) ──────────────────────────────────────────
  function getVietnamNow() {
    return new Date(new Date().getTime() + 7 * 3600000);
  }

  function getVietnamDate() {
    var vn = getVietnamNow();
    return {
      y: vn.getUTCFullYear(),
      m: vn.getUTCMonth(),
      d: vn.getUTCDate()
    };
  }

  function toLocalDateStr(d) {
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  function formatVND(amount) {
    if (amount == null || amount === '') return '0 đ';
    var num = Number(amount);
    if (isNaN(num)) return '0 đ';
    return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
  }

  function getMonthName(m) {
    return ['Tháng 1','Tháng 2','Tháng 3','Tháng 4','Tháng 5','Tháng 6',
            'Tháng 7','Tháng 8','Tháng 9','Tháng 10','Tháng 11','Tháng 12'][m - 1] || ('Tháng ' + m);
  }

  // ── Period label (reads from window.reportState) ─────────────────────────
  function getPeriodLabel() {
    var state = window.reportState;
    var vn = getVietnamNow();
    if (state.time === 'today')     return 'Hôm nay, ' + toLocalDateStr(vn).split('-').reverse().join('/');
    if (state.time === 'yesterday') return 'Hôm qua';
    if (state.time === 'month')     return getMonthName(state.month) + ' ' + state.year;
    if (state.time === 'year')      return 'Năm ' + state.year;
    return '';
  }

  function updatePeriodLabel() {
    var el = document.getElementById('periodLabel');
    if (el) el.textContent = getPeriodLabel();
  }

  // ── Date range calculation (reads from window.reportState.time/month/year) ─
  function getFilterRange() {
    var state = window.reportState;
    var vdate = getVietnamDate();
    var y = vdate.y, m = vdate.m, d = vdate.d;

    function vnStartDate(year, month, day) {
      return new Date(Date.UTC(year, month, day) - 7 * 3600000);
    }
    function vnEndDate(year, month, day) {
      return new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - 7 * 3600000);
    }

    if (state.time === 'today') {
      return { start: vnStartDate(y, m, d), end: vnEndDate(y, m, d) };
    }
    if (state.time === 'yesterday') {
      var yesterday = new Date(Date.UTC(y, m, d) - 8 * 3600000);
      yesterday.setDate(yesterday.getDate() - 1);
      return {
        start: vnStartDate(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate()),
        end:   vnEndDate(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate())
      };
    }
    if (state.time === 'month') {
      var ym = state.year;
      var mm = state.month;
      var lastD = new Date(Date.UTC(ym, mm, 0)).getUTCDate();
      return {
        start: vnStartDate(ym, mm - 1, 1),
        end:   vnEndDate(ym, mm - 1, lastD)
      };
    }
    if (state.time === 'year') {
      var yy = state.year;
      return {
        start: vnStartDate(yy, 0, 1),
        end:   vnEndDate(yy, 11, 31)
      };
    }
    return { start: vnStartDate(y, m, d), end: vnEndDate(y, m, d) };
  }

  // Date string range (for IndexedDB string field queries)
  function getDateRangeStr() {
    var state = window.reportState;
    var vdate = getVietnamDate();
    var y = vdate.y, m = vdate.m, d = vdate.d;

    function vnDateStr(year, month, day) {
      return year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    }

    if (state.time === 'today') {
      return { start: vnDateStr(y, m, d), end: vnDateStr(y, m, d) };
    }
    if (state.time === 'yesterday') {
      var yesterday = new Date(Date.UTC(y, m, d) - 8 * 3600000);
      yesterday.setDate(yesterday.getDate() - 1);
      return {
        start: vnDateStr(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate()),
        end:   vnDateStr(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate())
      };
    }
    if (state.time === 'month') {
      var ym = state.year;
      var mm = state.month;
      var lastD = new Date(Date.UTC(ym, mm, 0)).getUTCDate();
      return { start: vnDateStr(ym, mm - 1, 1), end: vnDateStr(ym, mm - 1, lastD) };
    }
    if (state.time === 'year') {
      var yy = state.year;
      return { start: yy + '-01-01', end: yy + '-12-31' };
    }
    return { start: vnDateStr(y, m, d), end: vnDateStr(y, m, d) };
  }

  // ── Loading UI ────────────────────────────────────────────────────────────
  function showLoading() {
    _isLoading = true;
    var state = window.reportState;
    var lists = {
      sales:      document.getElementById('salesList'),
      product:    document.getElementById('productsList'),
      customer:   document.getElementById('customersList'),
      import:     document.getElementById('purchasesList')
    };
    Object.values(lists).forEach(function(el) {
      if (el) el.innerHTML = '<div class="text-center text-muted py-4">Đang tải...</div>';
    });
  }

  function hideLoading() {
    _isLoading = false;
  }

  // ── IndexedDB loaders (each report type has its own query) ─────────────────

  // Load sales report
  async function loadSalesReport(dateRange) {
    if (!window.db) return null;
    console.log('[REPORT V3] SALES query:', dateRange.start, '->', dateRange.end);
    var rows = await window.db.sales
      .where('date')
      .between(dateRange.start, dateRange.end + '\xff', true, true)
      .toArray();
    console.log('[REPORT V3] SALES rows:', rows.length);

    var totalRevenue = 0, totalProfit = 0;
    rows.forEach(function(s) {
      totalRevenue += s.total || 0;
      totalProfit  += s.profit  || 0;
    });

    // Customer name map
    var custIds = [...new Set(rows.map(function(s) { return s.customer_id; }).filter(Boolean))];
    var custMap = {};
    if (custIds.length > 0) {
      var custs = await window.db.customers.where('id').anyOf(custIds).toArray();
      custs.forEach(function(c) { custMap[c.id] = c.name; });
    }
    var sales = rows.map(function(s) {
      return {
        id: s.id, date: s.date, total: s.total, profit: s.profit,
        customer_id: s.customer_id,
        customer_name: custMap[s.customer_id] || 'Khách lẻ'
      };
    });

    // Sale items for product breakdown
    var saleIds = rows.map(function(s) { return s.id; });
    var items = saleIds.length > 0
      ? await window.db.sale_items.where('sale_id').anyOf(saleIds).toArray()
      : [];
    var prodMap = {};
    (await window.db.products.toArray()).forEach(function(p) { prodMap[p.id] = p; });

    var byProduct = {};
    items.forEach(function(it) {
      var key = it.product_id;
      if (!byProduct[key]) {
        byProduct[key] = { product_id: key, name: (prodMap[key] || {}).name || '#' + key, quantity: 0, revenue: 0, profit: 0 };
      }
      byProduct[key].quantity += it.quantity || 0;
      byProduct[key].revenue  += (it.price || 0) * (it.quantity || 0);
      byProduct[key].profit   += ((it.price || 0) - (it.cost_price || 0)) * (it.quantity || 0);
    });

    // Expenses
    var totalExpense = 0;
    try {
      var expenses = await window.db.expenses.where('date').between(dateRange.start, dateRange.end, true, true).toArray();
      totalExpense = expenses.reduce(function(s, e) { return s + (e.amount || 0); }, 0);
    } catch (_) {}

    var daily = buildDailyData(rows);

    return {
      sales: sales,
      totalRevenue: totalRevenue,
      totalProfit:  totalProfit,
      totalExpense: totalExpense,
      totalOrders:  rows.length,
      profitByProduct: Object.values(byProduct),
      profitByCustomer: [],
      purchases: [],
      purchaseTotalAmount: 0,
      purchaseSlipCount: 0,
      daily: daily
    };
  }

  // Load product report (grouped by product)
  async function loadProductReport(dateRange) {
    if (!window.db) return null;
    console.log('[REPORT V3] PRODUCT query:', dateRange.start, '->', dateRange.end);

    var rows = await window.db.sales
      .where('date')
      .between(dateRange.start, dateRange.end + '\xff', true, true)
      .toArray();

    var saleIds = rows.map(function(s) { return s.id; });
    var items = saleIds.length > 0
      ? await window.db.sale_items.where('sale_id').anyOf(saleIds).toArray()
      : [];
    var prodMap = {};
    (await window.db.products.toArray()).forEach(function(p) { prodMap[p.id] = p; });

    var byProduct = {};
    items.forEach(function(it) {
      var key = it.product_id;
      if (!byProduct[key]) {
        byProduct[key] = {
          product_id: key,
          name: (prodMap[key] || {}).name || '#' + key,
          quantity: 0, revenue: 0, profit: 0
        };
      }
      byProduct[key].quantity += it.quantity || 0;
      byProduct[key].revenue  += (it.price || 0) * (it.quantity || 0);
      byProduct[key].profit   += ((it.price || 0) - (it.cost_price || 0)) * (it.quantity || 0);
    });

    var productList = Object.values(byProduct).sort(function(a, b) { return b.revenue - a.revenue; });
    var totalRevenue = productList.reduce(function(s, p) { return s + (p.revenue || 0); }, 0);
    var totalProfit  = productList.reduce(function(s, p) { return s + (p.profit || 0); }, 0);

    return {
      sales: [],
      totalRevenue: totalRevenue,
      totalProfit:  totalProfit,
      totalExpense: 0,
      totalOrders:  rows.length,
      profitByProduct: productList,
      profitByCustomer: [],
      purchases: [],
      purchaseTotalAmount: 0,
      purchaseSlipCount: 0,
      daily: []
    };
  }

  // Load customer report (grouped by customer)
  async function loadCustomerReport(dateRange) {
    if (!window.db) return null;
    console.log('[REPORT V3] CUSTOMER query:', dateRange.start, '->', dateRange.end);

    var rows = await window.db.sales
      .where('date')
      .between(dateRange.start, dateRange.end + '\xff', true, true)
      .toArray();

    var custIds = [...new Set(rows.map(function(s) { return s.customer_id; }).filter(Boolean))];
    var custMap = {};
    if (custIds.length > 0) {
      var custs = await window.db.customers.where('id').anyOf(custIds).toArray();
      custs.forEach(function(c) { custMap[c.id] = c; });
    }

    var byCustomer = {};
    rows.forEach(function(s) {
      var key = s.customer_id || '__walkin__';
      if (!byCustomer[key]) {
        byCustomer[key] = {
          customer_id: key,
          name: custMap[key] ? custMap[key].name : 'Khách lẻ',
          quantity: 0, revenue: 0, profit: 0
        };
      }
      byCustomer[key].quantity += 1; // 1 order per row
      byCustomer[key].revenue  += s.total || 0;
      byCustomer[key].profit   += s.profit || 0;
    });

    var customerList = Object.values(byCustomer).sort(function(a, b) { return b.revenue - a.revenue; });
    var totalRevenue = customerList.reduce(function(s, c) { return s + (c.revenue || 0); }, 0);
    var totalProfit  = customerList.reduce(function(s, c) { return s + (c.profit || 0); }, 0);

    return {
      sales: [],
      totalRevenue: totalRevenue,
      totalProfit:  totalProfit,
      totalExpense: 0,
      totalOrders:  rows.length,
      profitByProduct: [],
      profitByCustomer: customerList,
      purchases: [],
      purchaseTotalAmount: 0,
      purchaseSlipCount: 0,
      daily: []
    };
  }

  // Load import/purchase report
  async function loadImportReport(dateRange) {
    if (!window.db) return null;
    console.log('[REPORT V3] IMPORT query:', dateRange.start, '->', dateRange.end);

    var purchases = await window.db.purchases
      .where('date')
      .between(dateRange.start, dateRange.end + '\xff', true, true)
      .toArray();

    var totalAmount = purchases.reduce(function(s, p) { return s + (p.total_amount || 0); }, 0);

    return {
      sales: [],
      totalRevenue: 0,
      totalProfit:  0,
      totalExpense: 0,
      totalOrders:  0,
      profitByProduct: [],
      profitByCustomer: [],
      purchases: purchases,
      purchaseTotalAmount: totalAmount,
      purchaseSlipCount: purchases.length,
      daily: []
    };
  }

  // ── Build daily aggregation ────────────────────────────────────────────────
  function buildDailyData(rows) {
    var byDate = {};
    rows.forEach(function(s) {
      var dateKey = s.date ? s.date.split('T')[0] : '';
      if (!dateKey) return;
      if (!byDate[dateKey]) byDate[dateKey] = { date: dateKey, revenue: 0, profit: 0, expense: 0 };
      byDate[dateKey].revenue += s.total || 0;
      byDate[dateKey].profit  += s.profit || 0;
    });
    return Object.values(byDate).sort(function(a, b) { return a.date.localeCompare(b.date); });
  }

  // ── Main load function (reads from window.reportState) ───────────────────
  function loadReport() {
    clearTimeout(_loadDebounce);
    _loadDebounce = setTimeout(function() {
      _doLoadReport();
    }, 50);
  }

  function _doLoadReport() {
    var state = window.reportState;
    var dateRange = getDateRangeStr();

    console.log('[REPORT V3] STATE:', JSON.stringify(state));
    console.log('[REPORT V3] DATE RANGE:', dateRange.start, '->', dateRange.end);

    showLoading();

    var loader;
    switch (state.type) {
      case 'sales':    loader = loadSalesReport(dateRange);    break;
      case 'product':  loader = loadProductReport(dateRange);  break;
      case 'customer': loader = loadCustomerReport(dateRange); break;
      case 'import':   loader = loadImportReport(dateRange);   break;
      default:         loader = loadSalesReport(dateRange);
    }

    loader
      .then(function(data) {
        if (!data) return;
        console.log('[REPORT V3] RESULT:', state.type, '-', data.totalOrders, 'orders');
        hideLoading();
        _reportData = data;
        updateSummary(data);
        renderChart(data);
        renderSales(data.sales || []);
        renderProducts(data.profitByProduct || []);
        renderCustomers(data.profitByCustomer || []);
        renderPurchases(data.purchases || [], data.purchaseTotalAmount || 0, data.purchaseSlipCount || 0);

        // Activate the correct report section
        activateReportSection(state.type);
      })
      .catch(function(e) {
        console.error('[REPORT V3] Error:', e);
        hideLoading();
      });
  }

  // ── State update helpers ──────────────────────────────────────────────────

  // Update time filter (today / yesterday / month / year)
  function setTimeFilter(time) {
    window.reportState.time = time;
    updateTimeButtons(time);
    updatePeriodLabel();
    console.log('[REPORT V3] Time changed to:', time);
    loadReport();
  }

  // Update report type (sales / product / customer / import)
  function setReportType(type) {
    window.reportState.type = type;
    updateReportTypeButtons(type);
    console.log('[REPORT V3] Type changed to:', type);
    loadReport();
  }

  function selectMonth(m) {
    if (!m) return;
    window.reportState.month = parseInt(m, 10);
    window.reportState.year  = window.reportState.year || new Date().getFullYear();
    window.reportState.time = 'month';
    updateTimeButtons('month');
    updatePeriodLabel();
    console.log('[REPORT V3] Month selected:', window.reportState.month);
    loadReport();
  }

  function selectYear(y) {
    if (!y) return;
    window.reportState.year = parseInt(y, 10);
    window.reportState.time = 'year';
    updateTimeButtons('year');
    updatePeriodLabel();
    console.log('[REPORT V3] Year selected:', window.reportState.year);
    loadReport();
  }

  // ── UI: button active states ──────────────────────────────────────────────

  function updateTimeButtons(time) {
    document.querySelectorAll('.filter-time-btn').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.time === time);
    });
  }

  function updateReportTypeButtons(type) {
    document.querySelectorAll('.report-type-btn').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.type === type);
    });
  }

  function activateReportSection(type) {
    // Map report type to section id
    var sectionMap = {
      sales:    'reportSales',
      product:  'reportProducts',
      customer: 'reportCustomers',
      import:   'reportPurchases'
    };
    var sectionId = sectionMap[type] || 'reportSales';

    // Show/hide sections
    document.querySelectorAll('.report-section').forEach(function(el) {
      el.classList.toggle('active', el.id === sectionId);
    });

    // Highlight tab button
    document.querySelectorAll('.report-tab').forEach(function(btn) {
      var btnType = btn.dataset.tab; // tab values: sales/products/customers/purchases
      var typeMap = { sales: 'sales', products: 'product', customers: 'customer', purchases: 'import' };
      btn.classList.toggle('active', typeMap[btnType] === type);
    });
  }

  // ── Tab switching (used by report type tab bar) ──────────────────────────
  function switchReportTab(tab) {
    var typeMap = { sales: 'sales', products: 'product', customers: 'customer', purchases: 'import' };
    var type = typeMap[tab];
    if (type) {
      setReportType(type);
    }
  }

  // ── Filter initialization ─────────────────────────────────────────────────
  function initFilter() {
    // Populate month select
    var selMonth = document.getElementById('selMonth');
    if (selMonth) {
      for (var mi = 1; mi <= 12; mi++) {
        var optM = document.createElement('option');
        optM.value = mi;
        optM.textContent = 'Tháng ' + mi;
        selMonth.appendChild(optM);
      }
    }

    // Populate year select
    var selYear = document.getElementById('selYear');
    if (selYear) {
      var currentYear = new Date().getFullYear();
      for (var yi = currentYear; yi >= currentYear - 4; yi--) {
        var optY = document.createElement('option');
        optY.value = yi;
        optY.textContent = yi;
        selYear.appendChild(optY);
      }
    }

    // Set initial active state
    updateTimeButtons(window.reportState.time);
    updateReportTypeButtons(window.reportState.type);
    updatePeriodLabel();

    // Attach delegated event listeners
    document.addEventListener('click', function(e) {
      var target = e.target;

      // Time filter buttons
      var timeBtn = target.closest('.filter-time-btn');
      if (timeBtn && timeBtn.dataset.time) {
        e.preventDefault();
        setTimeFilter(timeBtn.dataset.time);
        return;
      }

      // Report type buttons (the tab bar)
      var typeBtn = target.closest('.report-type-btn');
      if (typeBtn && typeBtn.dataset.type) {
        e.preventDefault();
        setReportType(typeBtn.dataset.type);
        return;
      }
    });

    // Initial load
    loadReport();
  }

  // ── Expose public API on window ────────────────────────────────────────────
  window.reportState  = window.reportState;
  window.setReportType   = setReportType;
  window.setTimeFilter    = setTimeFilter;
  window.selectMonth      = selectMonth;
  window.selectYear       = selectYear;
  window.switchReportTab  = switchReportTab;
  window.initFilter       = initFilter;
  window.loadReport       = loadReport;

  // ── Auto-refresh on data mutations ─────────────────────────────────────────
  var _reportRefreshTimer;
  function queueReportRefresh(reason) {
    clearTimeout(_reportRefreshTimer);
    _reportRefreshTimer = setTimeout(function() {
      console.log('[REPORT V3][Consistency] refresh triggered by:', reason);
      _doLoadReport();
    }, 300);
  }

  window.addEventListener('data:mutated', function(evt) {
    var detail = evt && evt.detail ? evt.detail : {};
    var entity = detail.entity;
    if (entity === 'sale' || entity === 'expense' || entity === 'purchase' ||
        entity === 'customer' || entity === 'product' || entity === 'sync') {
      queueReportRefresh(entity);
    }
  });

  // ── Render: summary stats ──────────────────────────────────────────────────
  function updateSummary(data) {
    var revenue     = data.totalRevenue  || 0;
    var grossProfit  = data.totalProfit   || 0;
    var orders       = data.totalOrders   || 0;
    var expense      = data.totalExpense  || 0;
    var netProfit    = grossProfit - expense;

    var el;
    el = document.getElementById('statRevenue'); if (el) el.textContent = formatVND(revenue);
    el = document.getElementById('statProfit');  if (el) el.textContent = formatVND(netProfit);
    el = document.getElementById('statOrders');  if (el) el.textContent = orders;
    el = document.getElementById('statExpense');if (el) el.textContent = formatVND(expense);
    el = document.getElementById('headerProfit');if (el) el.textContent = formatVND(netProfit);
  }

  // ── Render: chart ─────────────────────────────────────────────────────────
  function renderChart(data) {
    var canvas = document.getElementById('chartCanvas');
    if (!canvas) return;

    if (!window.Chart) {
      var script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
      script.onload = function() { buildChart(data); };
      document.head.appendChild(script);
    } else {
      buildChart(data);
    }
  }

  function buildChart(data) {
    var canvas = document.getElementById('chartCanvas');
    if (!canvas || !window.Chart) return;

    var labels     = [];
    var revenues   = [];
    var netProfits = [];

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
          { label: 'Doanh thu',      data: revenues,   backgroundColor: 'rgba(59,130,246,0.5)' },
          { label: 'Lợi nhuận ròng', data: netProfits, backgroundColor: 'rgba(34,197,94,0.5)' }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: '#9ca3af', font: { size: 10 } } }
        },
        scales: {
          x: { ticks: { color: '#9ca3af', font: { size: 9 } }, grid: { color: '#374151' } },
          y: {
            ticks: { color: '#9ca3af', callback: function(v) { return (v/1000000).toFixed(1) + 'M'; } },
            grid: { color: '#374151' }
          }
        }
      }
    });
  }

  // ── Render: sales list ────────────────────────────────────────────────────
  function renderSales(sales) {
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
          '<div><div class="font-medium">' + (s.customer_name || 'Khách lẻ') + '</div><div class="text-xs text-muted">' + dateStr + '</div></div>' +
          '<div class="text-right">' +
            '<div class="font-bold tabular-nums">' + formatVND(s.total) + '</div>' +
            '<div class="text-xs text-success">+' + formatVND(s.profit) + '</div>' +
          '</div>' +
        '</div>'
      );
    }
    el.innerHTML = html.join('');
  }

  // ── Render: products ───────────────────────────────────────────────────────
  function renderProducts(products) {
    var el = document.getElementById('productsList');
    if (!el) return;
    if (!products || products.length === 0) {
      el.innerHTML = '<div class="text-center text-muted py-4">Không có dữ liệu</div>';
      return;
    }
    var html = [];
    for (var i = 0; i < products.length; i++) {
      var p = products[i];
      html.push(
        '<div class="card p-3 flex items-center justify-between">' +
          '<div class="flex-1 min-w-0">' +
            '<div class="font-medium truncate">' + (p.name || '') + '</div>' +
            '<div class="text-xs text-muted">&#127858; ' + (p.quantity || 0) + ' bình</div>' +
          '</div>' +
          '<div class="text-right ml-3">' +
            '<div class="font-bold tabular-nums">' + formatVND(p.revenue || 0) + '</div>' +
            '<div class="text-xs text-success">+' + formatVND(p.profit || 0) + '</div>' +
          '</div>' +
        '</div>'
      );
    }
    el.innerHTML = html.join('');
  }

  // ── Render: customers ─────────────────────────────────────────────────────
  function renderCustomers(customers) {
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
            '<div class="font-medium truncate">' + (c.name || '') + '</div>' +
            '<div class="text-xs text-muted">&#127856; ' + (c.quantity || 0) + ' đơn</div>' +
          '</div>' +
          '<div class="text-right ml-3">' +
            '<div class="font-bold tabular-nums">' + formatVND(c.revenue || 0) + '</div>' +
            '<div class="text-xs text-success">+' + formatVND(c.profit || 0) + '</div>' +
          '</div>' +
        '</div>'
      );
    }
    el.innerHTML = html.join('');
  }

  // ── Render: purchases ─────────────────────────────────────────────────────
  function renderPurchases(purchases, totalAmount, slipCount) {
    var el = document.getElementById('purchasesList');
    if (!el) return;
    var summaryHtml =
      '<div class="grid grid-cols-2 gap-2 mb-3">' +
        '<div class="card p-3 text-center">' +
          '<div class="text-xs text-muted">Tổng tiền nhập</div>' +
          '<div class="font-bold text-danger tabular-nums" style="font-size:14px;">' + formatVND(totalAmount) + '</div>' +
        '</div>' +
        '<div class="card p-3 text-center">' +
          '<div class="text-xs text-muted">Số phiếu</div>' +
          '<div class="font-bold tabular-nums" style="font-size:14px;">' + slipCount + '</div>' +
        '</div>' +
      '</div>';
    if (!purchases || purchases.length === 0) {
      el.innerHTML = summaryHtml + '<div class="text-center text-muted py-4">Không có phiếu nhập</div>';
      return;
    }
    var html = [];
    for (var i = 0; i < purchases.length; i++) {
      var p = purchases[i];
      var dateStr = p.date ? p.date.split('T')[0].split('-').reverse().join('/') : '';
      html.push(
        '<div class="card p-3">' +
          '<div class="flex justify-between items-start mb-1">' +
            '<div class="font-bold text-primary">#' + p.id + '</div>' +
            '<div class="text-xs text-muted">' + dateStr + '</div>' +
          '</div>' +
          '<div class="font-bold text-danger tabular-nums mb-1">' + formatVND(p.total_amount || 0) + '</div>' +
          (p.note ? '<div class="text-xs text-muted italic">' + p.note + '</div>' : '') +
        '</div>'
      );
    }
    el.innerHTML = summaryHtml + html.join('');
  }
})();
