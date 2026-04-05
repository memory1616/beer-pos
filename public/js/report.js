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
function initDateInputs() { initFilter(); }
function switchQuickFilter(type) { switchFilterType(type); }

function initFilter() {
  var yearEl = document.getElementById('selYear');
  if (yearEl) yearEl.innerHTML = getYearOptions(_selectedYear);

  var monthEl = document.getElementById('selMonth');
  if (monthEl) monthEl.value = _selectedMonth;

  // Set active tab — default "Hôm nay"
  activateTab('today');
  updatePeriodLabel();
  loadReport();
}

function activateTab(type) {
  _filterType = type;
  var tabs = document.querySelectorAll('.period-tab[data-type]');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].dataset.type === type);
  }
}

function switchFilterType(type) {
  activateTab(type);
  updatePeriodLabel();
  loadReport();
}

function toggleMonthDropdown(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  var monthEl = document.getElementById('monthDropdown');
  var yearEl  = document.getElementById('yearDropdown');
  if (!monthEl || !yearEl) { console.error('[REPORT] dropdown elements missing'); return; }
  var isHidden = monthEl.hidden;
  // Close both first
  monthEl.hidden = true;
  yearEl.hidden  = true;
  // Then open month if it was closed
  if (isHidden) {
    monthEl.hidden = false;
    console.log('[REPORT] month dropdown opened');
  } else {
    console.log('[REPORT] month dropdown closed');
  }
}

function toggleYearDropdown(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  var monthEl = document.getElementById('monthDropdown');
  var yearEl  = document.getElementById('yearDropdown');
  if (!monthEl || !yearEl) { console.error('[REPORT] dropdown elements missing'); return; }
  var isHidden = yearEl.hidden;
  // Close both first
  monthEl.hidden = true;
  yearEl.hidden  = true;
  // Then open year if it was closed
  if (isHidden) {
    yearEl.hidden = false;
    console.log('[REPORT] year dropdown opened');
  } else {
    console.log('[REPORT] year dropdown closed');
  }
}

function closeAllDropdowns() {
  var monthEl = document.getElementById('monthDropdown');
  var yearEl  = document.getElementById('yearDropdown');
  if (monthEl) monthEl.hidden = true;
  if (yearEl)  yearEl.hidden  = true;
}

function applyMonthYear() {
  console.log('[DEBUG] applyMonthYear called');
  var monthEl = document.getElementById('selMonth');
  var yearEl  = document.getElementById('selYear');
  if (monthEl) _selectedMonth = parseInt(monthEl.value, 10);
  if (yearEl)  _selectedYear  = parseInt(yearEl.value, 10);

  closeAllDropdowns();
  activateTab('month');
  updatePeriodLabel();
  loadReport();
}

function applyYear() {
  console.log('[DEBUG] applyYear called');
  var yearEl = document.getElementById('selYear');
  if (yearEl) _selectedYear = parseInt(yearEl.value, 10);

  closeAllDropdowns();
  activateTab('year');
  updatePeriodLabel();
  loadReport();
}

// Close dropdowns on outside click
document.addEventListener('click', function(e) {
  if (!e.target.closest('.filter-tab-wrap')) {
    closeAllDropdowns();
  }
});

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

function loadReport() {
  var url = '/report/data?type=' + _filterType;
  if (_filterType === 'month') {
    url += '&month=' + _selectedMonth + '&year=' + _selectedYear;
  } else if (_filterType === 'year') {
    url += '&year=' + _selectedYear;
  }

  fetch(url)
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
    .catch(function(e) { console.error('Load report error:', e); });
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
