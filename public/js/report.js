// BeerPOS Report Page - Filter: preset tabs + month/year dropdowns
console.log('[DEBUG] report.js loading...');
var _currentReportTab = 'sales';
var _reportData = {};
var _chart = null;

// Filter state: 'today' | 'yesterday' | 'month' | 'year'
var _filterType = 'today';
var _selectedMonth = new Date().getMonth() + 1;
var _selectedYear  = new Date().getFullYear();

function getLocalToday() {
  var now = new Date();
  var vn  = new Date(now.getTime() + 7 * 3600000);
  var y   = vn.getUTCFullYear();
  var m   = String(vn.getUTCMonth() + 1).padStart(2, '0');
  var d   = String(vn.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function getMonthName(m) {
  return ['Tháng 1','Tháng 2','Tháng 3','Tháng 4','Tháng 5','Tháng 6',
          'Tháng 7','Tháng 8','Tháng 9','Tháng 10','Tháng 11','Tháng 12'][m - 1] || ('Tháng ' + m);
}

function getYearOptions(current) {
  var currentYear = new Date().getFullYear();
  var opts = [];
  for (var i = currentYear; i >= currentYear - 4; i--) {
    opts.push('<option value="' + i + '"' + (i === current ? ' selected' : '') + '>' + i + '</option>');
  }
  return opts.join('');
}

function getPeriodLabel() {
  if (_filterType === 'today')    return 'Hôm nay, ' + getLocalToday().split('-').reverse().join('/');
  if (_filterType === 'yesterday') return 'Hôm qua';
  if (_filterType === 'month')    return getMonthName(_selectedMonth) + ' ' + _selectedYear;
  if (_filterType === 'year')     return 'Năm ' + _selectedYear;
  return '';
}

function updatePeriodLabel() {
  var el = document.getElementById('periodLabel');
  if (el) el.textContent = getPeriodLabel();
}

// Alias for backward compatibility with cached HTML
function initDateInputs() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFilter);
  } else {
    initFilter();
  }
}
function switchQuickFilter(type) { switchFilterType(type); }

function initFilter() {
  // Dropdown items are built on first open — no need to pre-build here.
  console.log('[REPORT] initFilter done');
  activateTab('today');
  updatePeriodLabel();
  loadReport();
}

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

// ── Month / Year dropdowns (div-based) ──────────────────────────────────────────

function _buildMonthDropdown() {
  var dd = document.getElementById('monthDropdown');
  if (!dd) return;
  dd.innerHTML = '';
  for (var i = 1; i <= 12; i++) {
    var item = document.createElement('div');
    item.className = 'dropdown-item';
    item.innerText = 'Tháng ' + i;
    item.dataset.month = i;
    item.onclick = (function(m) {
      return function() {
        _selectedMonth = m;
        _selectedYear  = _selectedYear || new Date().getFullYear();
        var btnMonth = document.getElementById('btnMonth');
        var btnYear  = document.getElementById('btnYear');
        if (btnMonth) btnMonth.innerText = 'Tháng ' + m;
        if (btnYear)  btnYear.innerText  = _selectedYear;
        closeAllDropdowns();
        activateTab('month');
        updatePeriodLabel();
        loadReport();
      };
    })(i);
    dd.appendChild(item);
  }
}

function _buildYearDropdown() {
  var dd = document.getElementById('yearDropdown');
  if (!dd) return;
  dd.innerHTML = '';
  var currentYear = new Date().getFullYear();
  for (var y = currentYear; y >= currentYear - 4; y--) {
    var item = document.createElement('div');
    item.className = 'dropdown-item';
    item.innerText = y;
    item.dataset.year = y;
    item.onclick = (function(yr) {
      return function() {
        _selectedYear = yr;
        var btnYear = document.getElementById('btnYear');
        if (btnYear) btnYear.innerText = yr;
        closeAllDropdowns();
        activateTab('year');
        updatePeriodLabel();
        loadReport();
      };
    })(y);
    dd.appendChild(item);
  }
}

function toggleMonthDropdown(e) {
  if (e) e.stopPropagation();
  var dd = document.getElementById('monthDropdown');
  var yd = document.getElementById('yearDropdown');
  if (!dd || !yd) return;
  _buildMonthDropdown();
  var wasHidden = dd.classList.contains('hidden');
  dd.classList.add('hidden');
  yd.classList.add('hidden');
  if (wasHidden) {
    var btn = document.getElementById('btnMonth');
    var rect = btn.getBoundingClientRect();
    dd.style.top  = rect.bottom + 'px';
    dd.style.left = rect.left + 'px';
    dd.style.borderRadius = '12px';
    dd.style.background = getComputedStyle(document.documentElement).getPropertyValue('--color-card').trim() || '#fff';
    dd.style.boxShadow = '0 8px 24px rgba(0,0,0,0.15)';
    dd.style.padding = '6px';
    dd.classList.remove('hidden');
  }
  console.log('[REPORT] month dropdown ' + (wasHidden ? 'opened' : 'closed'));
}

function toggleYearDropdown(e) {
  if (e) e.stopPropagation();
  var dd = document.getElementById('yearDropdown');
  var md = document.getElementById('monthDropdown');
  if (!dd || !md) return;
  _buildYearDropdown();
  var wasHidden = dd.classList.contains('hidden');
  dd.classList.add('hidden');
  md.classList.add('hidden');
  if (wasHidden) {
    var btn = document.getElementById('btnYear');
    var rect = btn.getBoundingClientRect();
    dd.style.top  = rect.bottom + 'px';
    dd.style.left = rect.left + 'px';
    dd.style.borderRadius = '12px';
    dd.style.background = getComputedStyle(document.documentElement).getPropertyValue('--color-card').trim() || '#fff';
    dd.style.boxShadow = '0 8px 24px rgba(0,0,0,0.15)';
    dd.style.padding = '6px';
    dd.classList.remove('hidden');
  }
  console.log('[REPORT] year dropdown ' + (wasHidden ? 'opened' : 'closed'));
}

function closeAllDropdowns() {
  var dd = document.getElementById('monthDropdown');
  var yd = document.getElementById('yearDropdown');
  if (dd) dd.classList.add('hidden');
  if (yd) yd.classList.add('hidden');
}

// Attach click-outside close after DOM ready
function _initDropdownClose() {
  document.addEventListener('click', function(e) {
    if (!e.target.closest('.filter-group')) closeAllDropdowns();
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initDropdownClose);
} else {
  _initDropdownClose();
}

function formatVND(amount) {
  if (amount == null || amount === '') return '0 đ';
  var num = Number(amount);
  if (isNaN(num)) return '0 đ';
  return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
}

function switchReportTab(tab) {
  _currentReportTab = tab;
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

// ── Date range helpers (Vietnam UTC+7) ──────────────────────────────────────────
// ── Vietnam date helpers (UTC+7) ────────────────────────────────────────────────
function getVietnamNow() {
  return new Date(new Date().getTime() + 7 * 3600000);
}

// Return {start, end} as UTC+7 Date objects for IndexedDB .between()
function getFilterRange() {
  var vn = getVietnamNow();
  var y = vn.getUTCFullYear();
  var m = vn.getUTCMonth();
  var d = vn.getUTCDate();

  if (_filterType === 'today') {
    return {
      start: new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - 7 * 3600000),
      end:   new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - 7 * 3600000)
    };
  }
  if (_filterType === 'yesterday') {
    var yesterday = new Date(Date.UTC(y, m, d) - 8 * 3600000);
    yesterday.setDate(yesterday.getDate() - 1);
    var yY = yesterday.getUTCFullYear(), yM = yesterday.getUTCMonth(), yD = yesterday.getUTCDate();
    return {
      start: new Date(Date.UTC(yY, yM, yD, 0, 0, 0, 0) - 7 * 3600000),
      end:   new Date(Date.UTC(yY, yM, yD, 23, 59, 59, 999) - 7 * 3600000)
    };
  }
  if (_filterType === 'month') {
    var ym = _selectedYear  || y;
    var mm = _selectedMonth || (m + 1);
    var lastD = new Date(Date.UTC(ym, mm, 0)).getUTCDate();
    return {
      start: new Date(Date.UTC(ym, mm - 1, 1, 0, 0, 0, 0) - 7 * 3600000),
      end:   new Date(Date.UTC(ym, mm - 1, lastD, 23, 59, 59, 999) - 7 * 3600000)
    };
  }
  if (_filterType === 'year') {
    var yy = _selectedYear || y;
    return {
      start: new Date(Date.UTC(yy, 0, 1, 0, 0, 0, 0) - 7 * 3600000),
      end:   new Date(Date.UTC(yy, 11, 31, 23, 59, 59, 999) - 7 * 3600000)
    };
  }
  // Default: today
  return {
    start: new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - 7 * 3600000),
    end:   new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - 7 * 3600000)
  };
}

// ── IndexedDB client-side report loader ────────────────────────────────────────
async function loadReportFromIndexedDB() {
  if (window.dbReady) await window.dbReady.catch(function() {});
  if (!window.db) return null;

  var range = getFilterRange();
  console.log('[REPORT] RANGE:', range.start.toISOString(), '→', range.end.toISOString());

  // Indexed query — requires createdAt in v31 schema + createdAt: new Date() on each sale
  var rows = await window.db.sales
    .where('createdAt')
    .between(range.start, range.end, true, true)
    .toArray();

  console.log('[REPORT] FILTERED:', rows.length);

  var totalRevenue = 0, totalProfit = 0;
  rows.forEach(function(s) {
    totalRevenue += s.total || 0;
    totalProfit  += s.profit  || 0;
  });

  var custIds = [...new Set(rows.map(function(s) { return s.customer_id; }).filter(Boolean))];
  var custMap = {};
  if (custIds.length > 0) {
    var custs = await window.db.customers.where('id').anyOf(custIds).toArray();
    custs.forEach(function(c) { custMap[c.id] = c.name; });
  }
  var sales = rows.map(function(s) {
    return { id: s.id, date: s.date, total: s.total, profit: s.profit, customer_id: s.customer_id, customer_name: custMap[s.customer_id] || 'Khách lẻ' };
  });

  var saleIds = rows.map(function(s) { return s.id; });
  var items = saleIds.length > 0
    ? await window.db.sale_items.where('sale_id').anyOf(saleIds).toArray()
    : [];
  var prodMap = {};
  (await window.db.products.toArray()).forEach(function(p) { prodMap[p.id] = p; });

  var byProduct = {};
  items.forEach(function(it) {
    var key = it.product_id;
    if (!byProduct[key]) byProduct[key] = { product_id: key, name: (prodMap[key] || {}).name || '#' + key, quantity: 0, revenue: 0, profit: 0 };
    byProduct[key].quantity += it.quantity || 0;
    byProduct[key].revenue  += (it.price || 0) * (it.quantity || 0);
    byProduct[key].profit  += ((it.price || 0) - (it.cost_price || 0)) * (it.quantity || 0);
  });

  var totalExpense = 0;
  try {
    var expDateStart = range.start.toISOString().slice(0, 10);
    var expDateEnd   = range.end.toISOString().slice(0, 10);
    var expenses = await window.db.expenses.where('date').between(expDateStart, expDateEnd, true, true).toArray();
    totalExpense = expenses.reduce(function(s, e) { return s + (e.amount || 0); }, 0);
  } catch (_) {}

  return { sales: sales, totalRevenue: totalRevenue, totalProfit: totalProfit, totalExpense: totalExpense,
           totalOrders: rows.length, profitByProduct: Object.values(byProduct), profitByCustomer: [],
           purchases: [], purchaseTotalAmount: 0, purchaseSlipCount: 0 };
}

function loadReport() {
  console.log('[REPORT] filter:', { type: _filterType, month: _selectedMonth, year: _selectedYear });

  loadReportFromIndexedDB()
    .then(function(data) {
      if (!data) return;

      console.log('[REPORT] INDEXEDDB:', data.totalOrders);

      _reportData = data;

      updateSummary(data);
      renderChart(data);
      renderSales(data.sales || []);
      renderProducts(data.profitByProduct || []);
      renderCustomers(data.profitByCustomer || []);
      renderPurchases(data.purchases || [], data.purchaseTotalAmount || 0, data.purchaseSlipCount || 0);
    })
    .catch(function(e) {
      console.error('[REPORT] IndexedDB error:', e);
    });
}

var _reportRefreshTimer = null;
var _reportRefreshInFlight = false;

function shouldRefreshReportEntity(entity) {
  if (!entity) return true;
  return entity === 'sale' || entity === 'expense' || entity === 'purchase' || entity === 'customer' || entity === 'product' || entity === 'sync';
}

function refreshReportFromMutation(reason) {
  if (_reportRefreshInFlight) return;
  _reportRefreshInFlight = true;
  console.log('[CONSISTENCY][Report] refresh', reason || 'mutation');
  fetch('/report/data?type=' + _filterType + (_filterType === 'month' ? '&month=' + _selectedMonth + '&year=' + _selectedYear : _filterType === 'year' ? '&year=' + _selectedYear : ''), { cache: 'no-store' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _reportData = data;
      updateSummary(data);
      renderChart(data);
      renderSales(data.sales || []);
      renderProducts(data.profitByProduct || []);
      renderCustomers(data.profitByCustomer || []);
      renderPurchases(data.purchases || [], data.purchaseTotalAmount || 0, data.purchaseSlipCount || 0);
    })
    .catch(function(e) { console.error('Refresh report error:', e); })
    .finally(function() {
      _reportRefreshInFlight = false;
    });
}

function queueReportRefresh(reason) {
  clearTimeout(_reportRefreshTimer);
  _reportRefreshTimer = setTimeout(function() {
    refreshReportFromMutation(reason || 'mutation');
  }, 180);
}

window.addEventListener('data:mutated', function(evt) {
  var detail = evt && evt.detail ? evt.detail : {};
  if (!shouldRefreshReportEntity(detail.entity)) return;
  queueReportRefresh(detail.entity || 'mutation');
});

function shouldRefreshReportPath(pathname) {
  if (!pathname) return false;
  return pathname.indexOf('/api/sales') === 0 ||
    pathname.indexOf('/api/expenses') === 0 ||
    pathname.indexOf('/api/purchases') === 0 ||
    pathname.indexOf('/api/customers') === 0 ||
    pathname.indexOf('/api/products') === 0 ||
    pathname.indexOf('/api/kegs') === 0 ||
    pathname.indexOf('/report/data') === 0 ||
    pathname.indexOf('/dashboard/data') === 0;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', function(event) {
    var data = event && event.data ? event.data : {};
    if (data.type !== 'DATA_INVALIDATED') return;
    if (!shouldRefreshReportPath(data.path || '')) return;
    queueReportRefresh('sw:' + (data.path || 'unknown'));
  });
}

function updateSummary(data) {
  var revenue    = data.totalRevenue  || 0;
  var grossProfit = data.totalProfit   || 0;
  var orders     = data.totalOrders     || 0;
  var expense    = data.totalExpense    || 0;
  var netProfit  = grossProfit - expense;

  var el;
  el = document.getElementById('statRevenue'); if (el) el.textContent = formatVND(revenue);
  el = document.getElementById('statProfit');  if (el) el.textContent = formatVND(netProfit);
  el = document.getElementById('statOrders');  if (el) el.textContent = orders;
  el = document.getElementById('statExpense'); if (el) el.textContent = formatVND(expense);
  el = document.getElementById('headerProfit'); if (el) el.textContent = formatVND(netProfit);
}

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
    var qty = p.quantity_sold || 0;
    var orderCount = p.order_count || 0;
    html.push(
      '<div class="card p-3 flex items-center justify-between">' +
        '<div class="flex-1 min-w-0">' +
          '<div class="font-medium truncate">' + (p.name || '') + '</div>' +
          '<div class="text-xs text-muted">🍺 ' + qty + ' bình' + (orderCount > 0 ? ' · ' + orderCount + ' đơn' : '') + '</div>' +
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
    var qty = c.quantity || 0;
    var orderCount = c.order_count || 0;
    html.push(
      '<div class="card p-3 flex items-center justify-between">' +
        '<div class="flex-1 min-w-0">' +
          '<div class="font-medium truncate">' + (c.name || '') + '</div>' +
          '<div class="text-xs text-muted">🍺 ' + qty + ' bình' + (orderCount > 0 ? ' · ' + orderCount + ' đơn' : '') + '</div>' +
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
