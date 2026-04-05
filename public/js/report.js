// BeerPOS Report Page
// PERFORMANCE: Separated from HTML, lazy loaded on /report route
var _currentReportTab = 'sales';
var _reportData = {};
var _chart = null;

// Filter state: 'quick' | 'custom'
// Quick filters use _quickPeriod ('today'|'week'|'month')
// Custom uses from/to date inputs
var _filterMode = 'quick';
var _quickPeriod = 'today';
var _quickLabels = {
  today: 'Hôm nay',
  week: '7 ngày qua',
  month: 'Tháng này'
};

// Compute today's local date string (YYYY-MM-DD) in Vietnam timezone
function getLocalToday() {
  var now = new Date();
  var vn = new Date(now.getTime() + 7 * 3600000);
  var y = vn.getUTCFullYear();
  var m = String(vn.getUTCMonth() + 1).padStart(2, '0');
  var d = String(vn.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function initDateInputs() {
  var today = getLocalToday();
  var fromEl = document.getElementById('filterFrom');
  var toEl = document.getElementById('filterTo');
  if (fromEl) fromEl.value = today;
  if (toEl) toEl.value = today;
}

function formatVND(amount) {
  if (amount == null || amount === '') return '0 đ';
  var num = Number(amount);
  if (isNaN(num)) return '0 đ';
  return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
}

function switchQuickFilter(period) {
  _filterMode = 'quick';
  _quickPeriod = period;

  // Highlight active quick filter tab
  var tabs = document.querySelectorAll('.period-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].dataset.period === period);
  }

  // Clear date inputs and remove custom active
  var fromEl = document.getElementById('filterFrom');
  var toEl = document.getElementById('filterTo');
  if (fromEl) fromEl.value = '';
  if (toEl) toEl.value = '';

  updateDateRangeLabel();
  loadReport();
}

function applyDateRange() {
  var fromEl = document.getElementById('filterFrom');
  var toEl = document.getElementById('filterTo');
  if (!fromEl || !toEl || !fromEl.value || !toEl.value) {
    return;
  }
  if (fromEl.value > toEl.value) {
    return;
  }
  _filterMode = 'custom';

  // Deselect quick filter tabs
  var tabs = document.querySelectorAll('.period-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.remove('active');
  }

  updateDateRangeLabel();
  loadReport();
}

function formatDisplayDate(dateStr) {
  if (!dateStr) return '...';
  var parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return parts[2] + '/' + parts[1] + '/' + parts[0];
}

function updateDateRangeLabel() {
  var labelEl = document.getElementById('dateRangeLabel');
  if (!labelEl) return;

  var fromEl = document.getElementById('filterFrom');
  var toEl = document.getElementById('filterTo');

  if (_filterMode === 'quick') {
    labelEl.textContent = _quickLabels[_quickPeriod] || _quickLabels.today;
  } else {
    var f = fromEl && fromEl.value ? formatDisplayDate(fromEl.value) : '';
    var t = toEl && toEl.value ? formatDisplayDate(toEl.value) : '';
    labelEl.textContent = (f && t) ? (f + ' → ' + t) : '...';
  }
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
  var url = '/report/data?mode=' + _filterMode;

  if (_filterMode === 'quick') {
    url += '&period=' + _quickPeriod;
  } else {
    var fromEl = document.getElementById('filterFrom');
    var toEl = document.getElementById('filterTo');
    if (fromEl && fromEl.value) url += '&from=' + fromEl.value;
    if (toEl && toEl.value) url += '&to=' + toEl.value;
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
    })
    .catch(function(e) { console.error('Load report error:', e); });
}

function updateSummary(data) {
  var revenue = data.totalRevenue || 0;
  var grossProfit = data.totalProfit || 0;
  var orders = data.totalOrders || 0;
  var expense = data.totalExpense || 0;
  var netProfit = grossProfit - expense;

  var el;
  el = document.getElementById('statRevenue'); if (el) el.textContent = formatVND(revenue);
  el = document.getElementById('statProfit'); if (el) el.textContent = formatVND(netProfit);
  el = document.getElementById('statOrders'); if (el) el.textContent = orders;
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

  var labels = [];
  var revenues = [];
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
        { label: 'Doanh thu', data: revenues, backgroundColor: 'rgba(59,130,246,0.5)' },
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
