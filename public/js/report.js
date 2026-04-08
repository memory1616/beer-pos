// BeerPOS Report Page - IndexedDB-only, no API fallback
// All filtering happens client-side via .where('createdAt').between()
(function() {
  var _filterType    = 'today';
  var _selectedMonth = new Date().getMonth() + 1;
  var _selectedYear  = new Date().getFullYear();
  var _reportData    = {};
  var _chart         = null;

  // ── Date helpers (Vietnam UTC+7) ─────────────────────────────────────────────
  // Vietnam is UTC+7
  function getVietnamNow() {
    return new Date(new Date().getTime() + 7 * 3600000);
  }

  // Get Vietnam date components from current time
  function getVietnamDate() {
    var vn = getVietnamNow();
    return {
      y: vn.getUTCFullYear(),
      m: vn.getUTCMonth(),
      d: vn.getUTCDate()
    };
  }

  function toLocalDateStr(d) {
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
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

  function getPeriodLabel() {
    var vn = getVietnamNow();
    if (_filterType === 'today')     return 'Hôm nay, ' + toLocalDateStr(vn).split('-').reverse().join('/');
    if (_filterType === 'yesterday') return 'Hôm qua';
    if (_filterType === 'month')    return getMonthName(_selectedMonth) + ' ' + _selectedYear;
    if (_filterType === 'year')     return 'Năm ' + _selectedYear;
    return '';
  }

  function updatePeriodLabel() {
    var el = document.getElementById('periodLabel');
    if (el) el.textContent = getPeriodLabel();
  }

  // ── Filter range (UTC+7 Date objects for IndexedDB .between()) ─────────────
  function getFilterRange() {
    var vdate = getVietnamDate();
    var y = vdate.y;
    var m = vdate.m;
    var d = vdate.d;

    // Helper: create date at Vietnam midnight (00:00 UTC+7 = 17:00 UTC previous day)
    function vnStartDate(year, month, day) {
      return new Date(Date.UTC(year, month, day) - 7 * 3600000);
    }
    function vnEndDate(year, month, day) {
      return new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - 7 * 3600000);
    }

    if (_filterType === 'today') {
      return {
        start: vnStartDate(y, m, d),
        end:   vnEndDate(y, m, d)
      };
    }
    if (_filterType === 'yesterday') {
      var yesterday = new Date(Date.UTC(y, m, d) - 8 * 3600000);
      yesterday.setDate(yesterday.getDate() - 1);
      var yY = yesterday.getUTCFullYear(), yM = yesterday.getUTCMonth(), yD = yesterday.getUTCDate();
      return {
        start: vnStartDate(yY, yM, yD),
        end:   vnEndDate(yY, yM, yD)
      };
    }
    if (_filterType === 'month') {
      var ym = _selectedYear  || y;
      var mm = _selectedMonth || (m + 1);
      var lastD = new Date(Date.UTC(ym, mm, 0)).getUTCDate();
      return {
        start: vnStartDate(ym, mm - 1, 1),
        end:   vnEndDate(ym, mm - 1, lastD)
      };
    }
    if (_filterType === 'year') {
      var yy = _selectedYear || y;
      return {
        start: vnStartDate(yy, 0, 1),
        end:   vnEndDate(yy, 11, 31)
      };
    }
    return {
      start: vnStartDate(y, m, d),
      end:   vnEndDate(y, m, d)
    };
  }

  // ── IndexedDB loader ─────────────────────────────────────────────────────────
  // Get date range as Vietnam-local date strings (YYYY-MM-DD)
  function getDateRangeStr() {
    var vdate = getVietnamDate();
    var y = vdate.y, m = vdate.m, d = vdate.d;

    function vnDateStr(year, month, day) {
      return year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    }

    if (_filterType === 'today') {
      return { start: vnDateStr(y, m, d), end: vnDateStr(y, m, d) };
    }
    if (_filterType === 'yesterday') {
      var yesterday = new Date(Date.UTC(y, m, d) - 8 * 3600000);
      yesterday.setDate(yesterday.getDate() - 1);
      return { start: vnDateStr(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate()),
               end:   vnDateStr(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate()) };
    }
    if (_filterType === 'month') {
      var ym = _selectedYear  || y;
      var mm = (_selectedMonth || (m + 1));
      var lastD = new Date(Date.UTC(ym, mm, 0)).getUTCDate();
      return { start: vnDateStr(ym, mm - 1, 1), end: vnDateStr(ym, mm - 1, lastD) };
    }
    if (_filterType === 'year') {
      var yy = _selectedYear || y;
      return { start: yy + '-01-01', end: yy + '-12-31' };
    }
    return { start: vnDateStr(y, m, d), end: vnDateStr(y, m, d) };
  }

  async function loadReportFromIndexedDB() {
    if (window.dbReady) await window.dbReady.catch(function() {});
    if (!window.db) return null;

    var dateRange = getDateRangeStr();
    console.log('[REPORT V2] DATE RANGE:', dateRange.start, '→', dateRange.end);

    // Query by date string field (stored as "YYYY-MM-DDTHH:mm:ss" in local time)
    var rows = await window.db.sales
      .where('date')
      .between(dateRange.start, dateRange.end + '\xff', true, true)
      .toArray();

    console.log('[REPORT V2] FILTERED:', rows.length, 'rows');

    var totalRevenue = 0, totalProfit = 0;
    rows.forEach(function(s) {
      totalRevenue += s.total || 0;
      totalProfit  += s.profit  || 0;
    });

    // Load customer names
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

    // Load sale items for product breakdown
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

    // Load expenses for this period (use date string range)
    var totalExpense = 0;
    try {
      var expenses = await window.db.expenses.where('date').between(dateRange.start, dateRange.end, true, true).toArray();
      totalExpense = expenses.reduce(function(s, e) { return s + (e.amount || 0); }, 0);
    } catch (_) {}

    // Build daily aggregation for chart
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

  // ── Main load function ───────────────────────────────────────────────────────
  function loadReport() {
    console.log('[REPORT V2] filter:', { type: _filterType, month: _selectedMonth, year: _selectedYear });

    loadReportFromIndexedDB()
      .then(function(data) {
        if (!data) return;
        console.log('[REPORT V2] INDEXEDDB:', data.totalOrders, 'orders');
        _reportData = data;
        updateSummary(data);
        renderChart(data);
        renderSales(data.sales || []);
        renderProducts(data.profitByProduct || []);
        renderCustomers(data.profitByCustomer || []);
        renderPurchases(data.purchases || [], data.purchaseTotalAmount || 0, data.purchaseSlipCount || 0);
      })
      .catch(function(e) {
        console.error('[REPORT V2] IndexedDB error:', e);
      });
  }

  // ── Build daily aggregation from sales rows ─────────────────────────────────
  function buildDailyData(rows) {
    var byDate = {};
    rows.forEach(function(s) {
      // Use date string directly to avoid timezone issues
      var dateKey = s.date ? s.date.split('T')[0] : '';
      if (!dateKey) return;
      if (!byDate[dateKey]) {
        byDate[dateKey] = { date: dateKey, revenue: 0, profit: 0, expense: 0 };
      }
      byDate[dateKey].revenue += s.total || 0;
      byDate[dateKey].profit  += s.profit  || 0;
    });
    return Object.values(byDate).sort(function(a, b) { return a.date.localeCompare(b.date); });
  }

  // ── Filter actions ───────────────────────────────────────────────────────────
  function activateTab(type) {
    _filterType = type;
    var btns = document.querySelectorAll('.filter-btn[data-type]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].dataset.type === type);
    }
  }

  function switchFilterType(type) {
    activateTab(type);
    updatePeriodLabel();
    loadReport();
  }

  function selectMonth(m) {
    if (!m) return;
    _selectedMonth = parseInt(m, 10);
    _selectedYear  = _selectedYear || new Date().getFullYear();
    activateTab('month');
    updatePeriodLabel();
    loadReport();
  }

  function selectYear(y) {
    if (!y) return;
    _selectedYear = parseInt(y, 10);
    activateTab('year');
    updatePeriodLabel();
    loadReport();
  }

  function initFilter() {
    var selMonth = document.getElementById('selMonth');
    var selYear  = document.getElementById('selYear');
    if (selMonth) {
      for (var mi = 1; mi <= 12; mi++) {
        var optM = document.createElement('option');
        optM.value = mi;
        optM.textContent = 'Tháng ' + mi;
        selMonth.appendChild(optM);
      }
    }
    if (selYear) {
      var currentYear = new Date().getFullYear();
      for (var yi = currentYear; yi >= currentYear - 4; yi--) {
        var optY = document.createElement('option');
        optY.value = yi;
        optY.textContent = yi;
        selYear.appendChild(optY);
      }
    }
    activateTab('today');
    updatePeriodLabel();
    loadReport();
  }

  // Expose for inline onclick handlers
  window.switchFilterType = switchFilterType;
  window.selectMonth     = selectMonth;
  window.selectYear      = selectYear;
  window.initFilter      = initFilter;
  window.loadReport      = loadReport;

  // ── Consistency: refresh from IndexedDB when data changes ─────────────────────
  var _reportRefreshTimer;
  function queueReportRefresh(reason) {
    clearTimeout(_reportRefreshTimer);
    _reportRefreshTimer = setTimeout(function() {
      console.log('[CONSISTENCY][Report V2] refresh:', reason);
      loadReportFromIndexedDB().then(function(data) {
        if (!data) return;
        _reportData = data;
        updateSummary(data);
        renderChart(data);
        renderSales(data.sales || []);
        renderProducts(data.profitByProduct || []);
        renderCustomers(data.profitByCustomer || []);
        renderPurchases(data.purchases || [], data.purchaseTotalAmount || 0, data.purchaseSlipCount || 0);
      }).catch(function(e) { console.error('[CONSISTENCY] IDB refresh error:', e); });
    }, 200);
  }

  window.addEventListener('data:mutated', function(evt) {
    var detail = evt && evt.detail ? evt.detail : {};
    var entity = detail.entity;
    if (entity === 'sale' || entity === 'expense' || entity === 'purchase' ||
        entity === 'customer' || entity === 'product' || entity === 'sync') {
      queueReportRefresh(entity);
    }
  });

  // ── Render: summary stats ───────────────────────────────────────────────────
  function updateSummary(data) {
    var revenue    = data.totalRevenue  || 0;
    var grossProfit = data.totalProfit || 0;
    var orders     = data.totalOrders  || 0;
    var expense    = data.totalExpense || 0;
    var netProfit  = grossProfit - expense;

    var el;
    el = document.getElementById('statRevenue'); if (el) el.textContent = formatVND(revenue);
    el = document.getElementById('statProfit');  if (el) el.textContent = formatVND(netProfit);
    el = document.getElementById('statOrders');  if (el) el.textContent = orders;
    el = document.getElementById('statExpense'); if (el) el.textContent = formatVND(expense);
    el = document.getElementById('headerProfit'); if (el) el.textContent = formatVND(netProfit);
  }

  // ── Render: chart ────────────────────────────────────────────────────────────
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
        plugins: { legend: { labels: { color: '#9ca3af', font: { size: 10 } } } },
        scales: {
          x: { ticks: { color: '#9ca3af', font: { size: 9 } }, grid: { color: '#374151' } },
          y: { ticks: { color: '#9ca3af', callback: function(v) { return (v/1000000).toFixed(1) + 'M'; } }, grid: { color: '#374151' } }
        }
      }
    });
  }

  // ── Render: sales list ──────────────────────────────────────────────────────
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

  // ── Render: products ────────────────────────────────────────────────────────
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

  // ── Render: customers ────────────────────────────────────────────────────────
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
            '<div class="text-xs text-muted">&#127856; ' + (c.quantity || 0) + ' bình</div>' +
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

  // ── Render: purchases ────────────────────────────────────────────────────────
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

  function switchReportTab(tab) {
    var sections = document.querySelectorAll('.report-section');
    for (var i = 0; i < sections.length; i++) {
      var sid = sections[i].id;
      sections[i].classList.toggle('active', sid === 'report' + tab.charAt(0).toUpperCase() + tab.slice(1));
    }
    var tabs = document.querySelectorAll('.report-tab');
    for (var j = 0; j < tabs.length; j++) {
      tabs[j].classList.toggle('active', tabs[j].dataset.tab === tab);
    }
  }
  window.switchReportTab = switchReportTab;
})();
