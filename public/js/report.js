// BeerPOS Report Page - Refactored v4
// Global state: window.reportState
// Architecture: type(report) + time(filter) hoàn toàn tách biệt
// DB: safe loader với try/catch, không crash khi thiếu table
(function () {
  // ── Global state (exposed on window) ─────────────────────────────────────
  var now = new Date();
  window.reportState = {
    type: 'sales',      // sales | product | customer | import
    time: 'today',      // today | yesterday | month | year
    month: now.getMonth() + 1,
    year: now.getFullYear()
  };

  // ── Local state ────────────────────────────────────────────────────────────
  var _reportData  = {};
  var _chart       = null;
  var _loadDebounce = null;
  var _isLoading   = false;

  // ── DB health check (run once) ─────────────────────────────────────────────
  function checkDBHealth() {
    var db = window.db;
    if (!db) { console.warn('[REPORT V4][DB] window.db not ready'); return; }

    var tables = ['sales', 'sale_items', 'expenses', 'customers', 'products', 'purchases'];
    tables.forEach(function(t) {
      if (!db[t]) {
        console.warn('[REPORT V4][DB] Table "' + t + '" not found in schema — queries will be skipped');
      }
    });

    // Count rows for debug
    db.sales.count().then(function(n) { console.log('[REPORT V4][DB] sales rows:', n); });
    db.expenses.count().then(function(n) { console.log('[REPORT V4][DB] expenses rows:', n); });
    db.products.count().then(function(n) { console.log('[REPORT V4][DB] products rows:', n); });
    db.customers.count().then(function(n) { console.log('[REPORT V4][DB] customers rows:', n); });
  }

  // ── Date helpers (Vietnam UTC+7) ──────────────────────────────────────────
  function getVietnamNow() {
    return new Date(new Date().getTime() + 7 * 3600000);
  }

  function getVietnamDate() {
    var vn = getVietnamNow();
    return { y: vn.getUTCFullYear(), m: vn.getUTCMonth(), d: vn.getUTCDate() };
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

  // ── Date range (reads from window.reportState.time/month/year) ────────────
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
      var lastD = new Date(Date.UTC(state.year, state.month, 0)).getUTCDate();
      return {
        start: vnStartDate(state.year, state.month - 1, 1),
        end:   vnEndDate(state.year, state.month - 1, lastD)
      };
    }
    if (state.time === 'year') {
      return {
        start: vnStartDate(state.year, 0, 1),
        end:   vnEndDate(state.year, 11, 31)
      };
    }
    return { start: vnStartDate(y, m, d), end: vnEndDate(y, m, d) };
  }

  // String range for IndexedDB .where('date') queries
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
      var lastD = new Date(Date.UTC(state.year, state.month, 0)).getUTCDate();
      return {
        start: vnDateStr(state.year, state.month - 1, 1),
        end:   vnDateStr(state.year, state.month - 1, lastD)
      };
    }
    if (state.time === 'year') {
      return { start: state.year + '-01-01', end: state.year + '-12-31' };
    }
    return { start: vnDateStr(y, m, d), end: vnDateStr(y, m, d) };
  }

  // ── Loading UI ────────────────────────────────────────────────────────────
  function showLoading() {
    _isLoading = true;
    var lists = {
      sales:      document.getElementById('salesList'),
      product:    document.getElementById('productsList'),
      customer:   document.getElementById('customersList'),
      import:     document.getElementById('purchasesList')
    };
    Object.keys(lists).forEach(function(k) {
      var el = lists[k];
      if (el) el.innerHTML = '<div class="text-center text-muted py-4">Đang tải...</div>';
    });
  }

  function hideLoading() {
    _isLoading = false;
  }

  // ── Safe DB access helper ──────────────────────────────────────────────────
  function safeTable(name) {
    var db = window.db;
    if (!db) {
      console.warn('[REPORT V4][DB] window.db not ready');
      return null;
    }
    if (!db[name]) {
      console.warn('[REPORT V4][DB] Table "' + name + '" does not exist in schema');
      return null;
    }
    return db[name];
  }

  // ── Loader: SALES (đơn hàng + chi phí + sản phẩm + khách hàng) ─────────────
  async function loadSalesReport(dateRange) {
    var db = window.db;
    if (!db) { console.warn('[REPORT V4] DB not ready'); return _emptyResult(); }

    var rows = [];
    try {
      var salesTbl = safeTable('sales');
      if (salesTbl) {
        rows = await salesTbl
          .where('date')
          .between(dateRange.start, dateRange.end + '\xff', true, true)
          .toArray();
      }
    } catch (err) {
      console.error('[REPORT V4][SALES] Query failed:', err);
    }
    console.log('[REPORT V4][SALES] rows:', rows.length);

    var totalRevenue = 0, totalProfit = 0;
    rows.forEach(function(s) {
      totalRevenue += s.total || 0;
      totalProfit  += s.profit  || 0;
    });

    // Customer names
    var custIds = [...new Set(rows.map(function(s) { return s.customer_id; }).filter(Boolean))];
    var custMap = {};
    if (custIds.length > 0) {
      var custTbl = safeTable('customers');
      if (custTbl) {
        try {
          var custs = await custTbl.where('id').anyOf(custIds).toArray();
          custs.forEach(function(c) { custMap[c.id] = c.name; });
        } catch (err) {
          console.warn('[REPORT V4][SALES] customers query failed:', err);
        }
      }
    }

    var sales = rows.map(function(s) {
      return {
        id: s.id, date: s.date, total: s.total, profit: s.profit,
        customer_id: s.customer_id,
        customer_name: custMap[s.customer_id] || 'Khách lẻ'
      };
    });

    // Sale items + product breakdown
    var saleIds = rows.map(function(s) { return s.id; });
    var items = [];
    if (saleIds.length > 0) {
      var siTbl = safeTable('sale_items');
      if (siTbl) {
        try {
          items = await siTbl.where('sale_id').anyOf(saleIds).toArray();
        } catch (err) {
          console.warn('[REPORT V4][SALES] sale_items query failed:', err);
        }
      }
    }

    var prodMap = {};
    var prodTbl = safeTable('products');
    if (prodTbl) {
      try {
        var prods = await prodTbl.toArray();
        prods.forEach(function(p) { prodMap[p.id] = p; });
      } catch (err) {
        console.warn('[REPORT V4][SALES] products load failed:', err);
      }
    }

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
    var expTbl = safeTable('expenses');
    if (expTbl) {
      try {
        var expenses = await expTbl.where('date').between(dateRange.start, dateRange.end, true, true).toArray();
        totalExpense = expenses.reduce(function(s, e) { return s + (e.amount || 0); }, 0);
      } catch (err) {
        console.warn('[REPORT V4][SALES] expenses query failed:', err);
      }
    }

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

  // ── Loader: PRODUCT (grouped by sản phẩm) ─────────────────────────────────
  async function loadProductReport(dateRange) {
    var db = window.db;
    if (!db) { console.warn('[REPORT V4] DB not ready'); return _emptyResult(); }

    var rows = [];
    try {
      var salesTbl = safeTable('sales');
      if (salesTbl) {
        rows = await salesTbl
          .where('date')
          .between(dateRange.start, dateRange.end + '\xff', true, true)
          .toArray();
      }
    } catch (err) {
      console.error('[REPORT V4][PRODUCT] sales query failed:', err);
    }

    var saleIds = rows.map(function(s) { return s.id; });
    var items = [];
    if (saleIds.length > 0) {
      var siTbl = safeTable('sale_items');
      if (siTbl) {
        try {
          items = await siTbl.where('sale_id').anyOf(saleIds).toArray();
        } catch (err) {
          console.warn('[REPORT V4][PRODUCT] sale_items query failed:', err);
        }
      }
    }

    var prodMap = {};
    var prodTbl = safeTable('products');
    if (prodTbl) {
      try {
        var prods = await prodTbl.toArray();
        prods.forEach(function(p) { prodMap[p.id] = p; });
      } catch (err) {
        console.warn('[REPORT V4][PRODUCT] products load failed:', err);
      }
    }

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

    var productList = Object.values(byProduct).sort(function(a, b) { return b.revenue - a.revenue; });
    var totalRevenue = productList.reduce(function(s, p) { return s + (p.revenue || 0); }, 0);
    var totalProfit  = productList.reduce(function(s, p) { return s + (p.profit || 0); }, 0);

    console.log('[REPORT V4][PRODUCT] rows:', rows.length, '| products:', productList.length);

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

  // ── Loader: CUSTOMER (grouped by khách hàng) ─────────────────────────────
  async function loadCustomerReport(dateRange) {
    var db = window.db;
    if (!db) { console.warn('[REPORT V4] DB not ready'); return _emptyResult(); }

    var rows = [];
    try {
      var salesTbl = safeTable('sales');
      if (salesTbl) {
        rows = await salesTbl
          .where('date')
          .between(dateRange.start, dateRange.end + '\xff', true, true)
          .toArray();
      }
    } catch (err) {
      console.error('[REPORT V4][CUSTOMER] sales query failed:', err);
    }

    var custIds = [...new Set(rows.map(function(s) { return s.customer_id; }).filter(Boolean))];
    var custMap = {};
    if (custIds.length > 0) {
      var custTbl = safeTable('customers');
      if (custTbl) {
        try {
          var custs = await custTbl.where('id').anyOf(custIds).toArray();
          custs.forEach(function(c) { custMap[c.id] = c; });
        } catch (err) {
          console.warn('[REPORT V4][CUSTOMER] customers query failed:', err);
        }
      }
    }

    var byCustomer = {};
    rows.forEach(function(s) {
      var key = s.customer_id || '__walkin__';
      if (!byCustomer[key]) {
        byCustomer[key] = { customer_id: key, name: custMap[key] ? custMap[key].name : 'Khách lẻ', quantity: 0, revenue: 0, profit: 0 };
      }
      byCustomer[key].quantity += 1;
      byCustomer[key].revenue  += s.total || 0;
      byCustomer[key].profit   += s.profit || 0;
    });

    var customerList = Object.values(byCustomer).sort(function(a, b) { return b.revenue - a.revenue; });
    var totalRevenue = customerList.reduce(function(s, c) { return s + (c.revenue || 0); }, 0);
    var totalProfit  = customerList.reduce(function(s, c) { return s + (c.profit || 0); }, 0);

    console.log('[REPORT V4][CUSTOMER] rows:', rows.length, '| customers:', customerList.length);

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

  // ── Loader: IMPORT (chi phí nhập hàng từ expenses table) ─────────────────
  async function loadImportReport(dateRange) {
    var db = window.db;
    if (!db) { console.warn('[REPORT V4] DB not ready'); return _emptyResult(); }

    // db.js schema: expenses có table expenses với fields: id, type, amount, note, date, synced
    // Table purchases không tồn tại trong schema hiện tại (v37)
    var purchases = [];

    // Thử table purchases trước (nếu có trong future schema)
    var purchasesTbl = safeTable('purchases');
    if (purchasesTbl) {
      try {
        purchases = await purchasesTbl
          .where('date')
          .between(dateRange.start, dateRange.end + '\xff', true, true)
          .toArray();
      } catch (err) {
        console.warn('[REPORT V4][IMPORT] purchases table query failed (fallback to expenses):', err);
        purchases = [];
      }
    } else {
      console.log('[REPORT V4][IMPORT] purchases table not found — using expenses as import data');
    }

    // Nếu không có purchases, dùng expenses có type chứa 'nhap' hoặc 'import'
    if (purchases.length === 0) {
      var expTbl = safeTable('expenses');
      if (expTbl) {
        try {
          var allExpenses = await expTbl.where('date').between(dateRange.start, dateRange.end, true, true).toArray();
          purchases = allExpenses.filter(function(e) {
            var t = (e.type || '').toLowerCase();
            return t.indexOf('nhap') !== -1 || t.indexOf('import') !== -1 || t.indexOf('nhập') !== -1;
          });
          console.log('[REPORT V4][IMPORT] filtered expenses (import type):', purchases.length);
        } catch (err) {
          console.warn('[REPORT V4][IMPORT] expenses query failed:', err);
        }
      }
    }

    var totalAmount = purchases.reduce(function(s, p) { return s + (p.total_amount || p.amount || 0); }, 0);

    console.log('[REPORT V4][IMPORT] rows:', purchases.length, '| total:', totalAmount);

    return {
      sales: [],
      totalRevenue: 0,
      totalProfit:  0,
      totalExpense: totalAmount,
      totalOrders:  0,
      profitByProduct: [],
      profitByCustomer: [],
      purchases: purchases,
      purchaseTotalAmount: totalAmount,
      purchaseSlipCount: purchases.length,
      daily: []
    };
  }

  // ── Empty result helper ────────────────────────────────────────────────────
  function _emptyResult() {
    return {
      sales: [],
      totalRevenue: 0,
      totalProfit:  0,
      totalExpense: 0,
      totalOrders:  0,
      profitByProduct: [],
      profitByCustomer: [],
      purchases: [],
      purchaseTotalAmount: 0,
      purchaseSlipCount: 0,
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

  // ── Main load (debounced) ─────────────────────────────────────────────────
  function loadReport() {
    clearTimeout(_loadDebounce);
    _loadDebounce = setTimeout(function() { _doLoadReport(); }, 50);
  }

  function _doLoadReport() {
    var state    = window.reportState;
    var dateRange = getDateRangeStr();

    console.log('[REPORT V4] STATE:', JSON.stringify(state));
    console.log('[REPORT V4] DATE RANGE:', dateRange.start, '->', dateRange.end);

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
        if (!data) data = _emptyResult();
        console.log('[REPORT V4] RESULT:', state.type, '-', data.totalOrders || 0, 'orders');
        hideLoading();
        _reportData = data;
        updateSummary(data);
        renderChart(data);
        renderSales(data.sales || []);
        renderProducts(data.profitByProduct || []);
        renderCustomers(data.profitByCustomer || []);
        renderPurchases(data.purchases || [], data.purchaseTotalAmount || 0, data.purchaseSlipCount || 0);
        activateReportSection(state.type);
      })
      .catch(function(e) {
        console.error('[REPORT V4] Loader error:', e);
        hideLoading();
        var empty = _emptyResult();
        _reportData = empty;
        updateSummary(empty);
        renderSales([]);
        renderProducts([]);
        renderCustomers([]);
        renderPurchases([], 0, 0);
      });
  }

  // ── State update helpers ──────────────────────────────────────────────────
  function setTimeFilter(time) {
    window.reportState.time = time;
    updateTimeButtons(time);
    updatePeriodLabel();
    console.log('[REPORT V4] Time ->:', time);
    loadReport();
  }

  function setReportType(type) {
    window.reportState.type = type;
    updateReportTypeButtons(type);
    console.log('[REPORT V4] Type ->:', type);
    loadReport();
  }

  function selectMonth(m) {
    if (!m) return;
    window.reportState.month = parseInt(m, 10);
    window.reportState.year  = window.reportState.year || new Date().getFullYear();
    window.reportState.time = 'month';
    updateTimeButtons('month');
    updatePeriodLabel();
    console.log('[REPORT V4] Month ->:', window.reportState.month);
    loadReport();
  }

  function selectYear(y) {
    if (!y) return;
    window.reportState.year = parseInt(y, 10);
    window.reportState.time = 'year';
    updateTimeButtons('year');
    updatePeriodLabel();
    console.log('[REPORT V4] Year ->:', window.reportState.year);
    loadReport();
  }

  // ── UI button states ─────────────────────────────────────────────────────
  function updateTimeButtons(time) {
    var btns = document.querySelectorAll('.filter-time-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].dataset.time === time);
    }
  }

  function updateReportTypeButtons(type) {
    var btns = document.querySelectorAll('.report-type-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].dataset.type === type);
    }
  }

  function activateReportSection(type) {
    var sectionMap = { sales: 'reportSales', product: 'reportProducts', customer: 'reportCustomers', import: 'reportPurchases' };
    var sectionId = sectionMap[type] || 'reportSales';

    document.querySelectorAll('.report-section').forEach(function(el) {
      el.classList.toggle('active', el.id === sectionId);
    });

    document.querySelectorAll('.report-tab').forEach(function(btn) {
      var map = { sales: 'sales', products: 'product', customers: 'customer', purchases: 'import' };
      btn.classList.toggle('active', map[btn.dataset.tab] === type);
    });
  }

  function switchReportTab(tab) {
    var typeMap = { sales: 'sales', products: 'product', customers: 'customer', purchases: 'import' };
    var type = typeMap[tab];
    if (type) setReportType(type);
  }

  // ── Filter init ───────────────────────────────────────────────────────────
  function initFilter() {
    // DB health check
    checkDBHealth();

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

    updateTimeButtons(window.reportState.time);
    updateReportTypeButtons(window.reportState.type);
    updatePeriodLabel();

    // Delegated event listener
    document.addEventListener('click', function(e) {
      var target = e.target;

      var timeBtn = target.closest('.filter-time-btn');
      if (timeBtn && timeBtn.dataset.time) {
        e.preventDefault();
        setTimeFilter(timeBtn.dataset.time);
        return;
      }

      var typeBtn = target.closest('.report-type-btn');
      if (typeBtn && typeBtn.dataset.type) {
        e.preventDefault();
        setReportType(typeBtn.dataset.type);
        return;
      }
    });

    // Wait for db ready, then load
    if (window.dbReady) {
      window.dbReady.then(function() {
        console.log('[REPORT V4] DB ready — loading report');
        loadReport();
      }).catch(function(e) {
        console.error('[REPORT V4] DB ready failed:', e);
        loadReport(); // still try
      });
    } else {
      loadReport();
    }
  }

  // ── Expose public API ──────────────────────────────────────────────────────
  window.reportState     = window.reportState;
  window.setReportType   = setReportType;
  window.setTimeFilter   = setTimeFilter;
  window.selectMonth     = selectMonth;
  window.selectYear      = selectYear;
  window.switchReportTab = switchReportTab;
  window.initFilter      = initFilter;
  window.loadReport      = loadReport;

  // ── Auto-refresh on data mutations ───────────────────────────────────────
  var _reportRefreshTimer;
  function queueReportRefresh(reason) {
    clearTimeout(_reportRefreshTimer);
    _reportRefreshTimer = setTimeout(function() {
      console.log('[REPORT V4][Consistency] refresh:', reason);
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

  // ── Render: summary ───────────────────────────────────────────────────────
  function updateSummary(data) {
    var revenue    = data.totalRevenue  || 0;
    var grossProfit = data.totalProfit  || 0;
    var orders     = data.totalOrders   || 0;
    var expense    = data.totalExpense  || 0;
    var netProfit  = grossProfit - expense;

    var el;
    el = document.getElementById('statRevenue'); if (el) el.textContent = formatVND(revenue);
    el = document.getElementById('statProfit'); if (el) el.textContent = formatVND(netProfit);
    el = document.getElementById('statOrders'); if (el) el.textContent = orders;
    el = document.getElementById('statExpense'); if (el) el.textContent = formatVND(expense);
    el = document.getElementById('headerProfit'); if (el) el.textContent = formatVND(netProfit);
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

  // ── Render: sales ─────────────────────────────────────────────────────────
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
          '<div><div class="font-medium">' + (s.customer_name || 'Khách lẻ') + '</div><div class="text-xs text-secondary">' + dateStr + '</div></div>' +
          '<div class="text-right">' +
            '<div class="font-bold tabular-nums">' + formatVND(s.total) + '</div>' +
            '<div class="text-xs text-success">+' + formatVND(s.profit) + '</div>' +
          '</div>' +
        '</div>'
      );
    }
    el.innerHTML = html.join('');
  }

  // ── Render: products ─────────────────────────────────────────────────────
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
            '<div class="text-xs text-secondary">&#127858; ' + (p.quantity || 0) + ' bình</div>' +
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
            '<div class="text-xs text-secondary">&#127856; ' + (c.quantity || 0) + ' đơn</div>' +
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

  // ── Render: purchases / import ────────────────────────────────────────────
  function renderPurchases(purchases, totalAmount, slipCount) {
    var el = document.getElementById('purchasesList');
    if (!el) return;
    var summaryHtml =
      '<div class="grid grid-cols-2 gap-2 mb-3">' +
        '<div class="card p-3 text-center">' +
          '<div class="text-xs text-secondary">Tổng chi phí</div>' +
          '<div class="font-bold text-danger tabular-nums" style="font-size:14px;">' + formatVND(totalAmount) + '</div>' +
        '</div>' +
        '<div class="card p-3 text-center">' +
          '<div class="text-xs text-secondary">Số phiếu</div>' +
          '<div class="font-bold tabular-nums" style="font-size:14px;">' + slipCount + '</div>' +
        '</div>' +
      '</div>';
    if (!purchases || purchases.length === 0) {
      el.innerHTML = summaryHtml + '<div class="text-center text-muted py-4">Không có dữ liệu nhập hàng</div>';
      return;
    }
    var html = [];
    for (var i = 0; i < purchases.length; i++) {
      var p = purchases[i];
      var dateStr = p.date ? p.date.split('T')[0].split('-').reverse().join('/') : '';
      var amount = p.total_amount || p.amount || 0;
      var typeLabel = p.type ? '<div class="text-xs text-secondary">' + p.type + '</div>' : '';
      html.push(
        '<div class="card p-3">' +
          '<div class="flex justify-between items-start mb-1">' +
            '<div class="font-bold text-primary">#' + (p.id || '?') + '</div>' +
            '<div class="text-xs text-secondary">' + dateStr + '</div>' +
          '</div>' +
          '<div class="font-bold text-danger tabular-nums mb-1">' + formatVND(amount) + '</div>' +
          typeLabel +
          (p.note ? '<div class="text-xs text-secondary italic">' + p.note + '</div>' : '') +
        '</div>'
      );
    }
    el.innerHTML = summaryHtml + html.join('');
  }
})();
