// Dashboard Page JavaScript
// Tách riêng để dễ bảo trì và cache
// formatVND đã được định nghĩa trong format.js

let revenueChart = null;
let _warningOpen = false;

function toggleWarning() {
  const content = document.getElementById('warningContent');
  const icon = document.getElementById('warningIcon');
  if (!content || !icon) return;
  _warningOpen = !_warningOpen;
  content.classList.toggle('open', _warningOpen);
  icon.classList.toggle('up', _warningOpen);
}

/**
 * Hiển thị số tiền: .money > .value + .unit + phân cấp màu (unified.css).
 * @param {HTMLElement|null} el
 * @param {number} amount
 * @param {'success'|'profit'|'danger'|'neutral'|'primary'} kind — primary = tổng tiền màu brand (chart)
 * @param {{ size?: 'lg'|'stat', compact?: boolean, omitUnit?: boolean }} [opts] compact = ô biểu đồ nhỏ; omitUnit = không hiện "đ" (số bình bán ra)
 */
function setMoneyAmount(el, amount, kind, opts) {
  if (!el || typeof Format === 'undefined') return;
  opts = opts || {};
  var sizeMod = 'money--kpi-stat';
  if (opts.compact) sizeMod = 'money--chart-mini';
  else if (opts.size === 'lg') sizeMod = 'money--kpi-hero';

  var kindClass = {
    success: 'money-success',
    profit: 'money-profit',
    danger: 'money-danger',
    neutral: 'money-neutral',
    primary: 'money-chart-primary'
  }[kind] || 'money-success';

  var unitHtml = opts.omitUnit ? '' : '<span class="unit">đ</span>';

  el.className = 'min-w-0 text-center w-full';
  el.innerHTML =
    '<div class="money ' + sizeMod + ' ' + kindClass + '">' +
      '<span class="value">' + Format.number(amount) + '</span>' +
      unitHtml +
    '</div>';
}

function initDashboard(data) {
  // Set today's date in header
  const dateEl = document.getElementById('dashboardDate');
  if (dateEl) {
    const now = new Date();
    const days = ['Chủ Nhật','Thứ Hai','Thứ Ba','Thứ Tư','Thứ Năm','Thứ Sáu','Thứ Bảy'];
    dateEl.textContent = days[now.getDay()] + ', ' +
      now.getDate().toString().padStart(2,'0') + '/' +
      (now.getMonth()+1).toString().padStart(2,'0') + '/' +
      now.getFullYear();
  }

  // Helper function to safely set text content
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  // Today's revenue
  const todayRevenue = data.todayStats?.revenue || 0;
  const todayRevenueEl = document.getElementById('todayRevenue');
  if (todayRevenueEl) {
    if (todayRevenue === 0) {
      todayRevenueEl.textContent = 'Chưa có dữ liệu hôm nay';
      todayRevenueEl.className = 'text-base font-medium text-muted italic text-center w-full';
    } else {
      // Cùng cỡ số với ô vỏ bình (text-2xl), không dùng hàng phụ “bình”
      setMoneyAmount(todayRevenueEl, todayRevenue, 'success', { size: 'lg' });
    }
  }

  // Today's units sold — cùng cỡ/màu với Doanh thu, không đơn vị "bình"
  const todayUnits = data.todayUnits?.units || 0;
  const todayUnitsEl = document.getElementById('todayUnits');
  if (todayUnitsEl) {
    if (todayUnits === 0) {
      todayUnitsEl.textContent = 'Chưa có dữ liệu hôm nay';
      todayUnitsEl.className = 'text-base font-medium text-muted italic text-center w-full';
    } else {
      setMoneyAmount(todayUnitsEl, todayUnits, 'success', { size: 'lg', omitUnit: true });
    }
  }

  // Net profit today (profit - expenses)
  const todayProfit = (data.todayStats?.profit || 0) - (data.expenses?.today || 0);
  const todayProfitEl = document.getElementById('todayProfit');
  if (todayProfitEl) {
    if (todayProfit === 0) {
      todayProfitEl.textContent = 'Chưa có dữ liệu hôm nay';
      todayProfitEl.className = 'text-base font-medium text-muted italic text-center w-full';
    } else if (todayProfit > 0) {
      setMoneyAmount(todayProfitEl, todayProfit, 'profit', { size: 'stat' });
    } else {
      setMoneyAmount(todayProfitEl, todayProfit, 'danger', { size: 'stat' });
    }
  }

  // Today's expenses
  const todayExpenseAmt = data.expenses?.today || 0;
  const todayExpenseEl = document.getElementById('todayExpense');
  if (todayExpenseEl) {
    if (todayExpenseAmt === 0) {
      todayExpenseEl.textContent = 'Không có chi phí hôm nay';
      todayExpenseEl.className = 'text-base font-medium text-muted italic text-center w-full';
    } else {
      setMoneyAmount(todayExpenseEl, todayExpenseAmt, 'danger', { size: 'stat' });
    }
  }

  // Net profit this month (profit - expenses)
  const monthProfit = (data.monthStats?.profit || 0) - (data.expenses?.month || 0);
  const monthProfitEl = document.getElementById('monthProfit');
  if (monthProfitEl) {
    if (monthProfit === 0) {
      monthProfitEl.textContent = 'Chưa có dữ liệu';
      monthProfitEl.className = 'text-base font-medium text-muted italic text-center w-full';
    } else if (monthProfit > 0) {
      setMoneyAmount(monthProfitEl, monthProfit, 'profit', { size: 'stat' });
    } else {
      setMoneyAmount(monthProfitEl, monthProfit, 'danger', { size: 'stat' });
    }
  }

  // Month's expenses
  const monthExpenseAmt = data.expenses?.month || 0;
  const monthExpenseEl = document.getElementById('monthExpense');
  if (monthExpenseEl) {
    if (monthExpenseAmt === 0) {
      monthExpenseEl.textContent = 'Không có chi phí';
      monthExpenseEl.className = 'text-base font-medium text-muted italic text-center w-full';
    } else {
      setMoneyAmount(monthExpenseEl, monthExpenseAmt, 'danger', { size: 'stat' });
    }
  }
  
  // Set keg stats - from keg state API
  if (data.kegState) {
    const inventory = data.kegState.inventory || 0;
    const emptyCollected = data.kegState.emptyCollected || 0;
    const customerHolding = data.kegState.customerHolding || 0;
    const total = data.kegState.total || 0;
    
    setText('kegInventory', inventory);
    setText('kegEmptyCollected', emptyCollected);
    setText('kegCustomerHolding', customerHolding);
    setText('kegTotal', total);
    
    // % theo 3 ô Kho/Khách/Rỗng (tổng hiển thị); TỔNG VỎ có thể nhỏ hơn khi kho âm
    const sumCards = inventory + emptyCollected + customerHolding;
    const pctBase = sumCards > 0 ? sumCards : (total > 0 ? total : 1);
    const inventoryPct = Math.round((inventory / pctBase) * 100);
    const emptyPct = Math.round((emptyCollected / pctBase) * 100);
    const customerPct = Math.round((customerHolding / pctBase) * 100);
    
    setText('kegInventoryPct', inventoryPct + '%');
    setText('kegEmptyCollectedPct', emptyPct + '%');
    setText('kegCustomerHoldingPct', customerPct + '%');
  } else {
    // Fallback to old format
    setText('kegCustomerHolding', data.kegStats?.atCustomers || 0);
  }
  
  // Store for later use
  window.dashboardData = {
    ...data
  };
  
  // Render low stock (threshold from settings)
  if (data.lowStockProducts && data.lowStockProducts.length > 0) {
    const section = document.getElementById('lowStockSection');
    const list = document.getElementById('lowStockList');
    const header = document.getElementById('lowStockHeader');
    if (section) section.classList.remove('hidden');
    if (header && data.stockLowThreshold) {
      header.textContent = '⚠️ Hàng sắp hết (dưới ' + data.stockLowThreshold + ')';
    }
    if (list) {
      list.innerHTML = data.lowStockProducts.map(p =>
        '<div class="dsh-sale-row" style="padding:10px 0;">' +
          '<div class="dsh-sale-row-left">' +
            '<div class="text-sm font-semibold" style="color:var(--text-primary);">' + p.name + '</div>' +
          '</div>' +
          '<div class="font-bold tabular-nums" style="color:var(--red);font-size:14px;flex-shrink:0;">' + p.stock + ' bình</div>' +
        '</div>'
      ).join('');
    }
  }
  
  // Render KPI alerts (thiếu bình so với kỳ vọng tháng, có lọc exclude_expected)
  if (data.kpiAlerts && data.kpiAlerts.length > 0) {
    const section = document.getElementById('customerAlertsSection');
    const list = document.getElementById('customerAlertsList');
    const header = document.getElementById('customerAlertsHeader');
    const badge = document.getElementById('warningBadge');
    if (section) section.classList.remove('hidden');
    if (badge) badge.textContent = data.kpiAlerts.length;
    if (header) {
      const monthly = data.monthlyExpected || 300;
      const expected = Math.round(data.expectedUnits || 0);
      const elapsed = data.daysElapsed || 0;
      const total = data.daysInMonth || 0;
      header.textContent = monthly + ' bình/tháng · kỳ vọng ' + expected + ' bình sau ' + elapsed + '/' + total + ' ngày';
    }
    if (list) {
      if (!data.kpiAlerts || data.kpiAlerts.length === 0) {
        list.innerHTML = '<div class="text-sm text-muted text-center py-4 px-3">Không có khách nào dưới mức</div>';
      } else {
        list.innerHTML = data.kpiAlerts.map(c => {
          const shortfall = Math.round(Number(c.shortfall) || 0);
          const cls = shortfall > 50 ? 'text-danger font-bold' : shortfall > 20 ? 'text-warning font-semibold' : 'text-warning font-semibold';
          const phoneBtn = c.phone ? '<a href="tel:' + c.phone + '" class="text-success shrink-0">📞</a>' : '';
          return '<div class="dsh-sale-row">' +
            '<div class="dsh-sale-row-left">' +
              '<a href="/customers/' + c.id + '" class="dsh-customer-name">' + c.name + '</a>' +
              phoneBtn +
            '</div>' +
            '<div class="' + cls + ' dsh-shortfall tabular-nums">Thiếu: ' + shortfall + ' bình</div>' +
          '</div>';
        }).join('');
      }
    }
  }
  
  // Render recent sales
  const recentSales = document.getElementById('recentSales');
  if (recentSales) {
    if (data.recentSales && data.recentSales.length > 0) {
      recentSales.innerHTML = data.recentSales.slice(0, 5).map(s => {
        const date = new Date(s.date).toLocaleDateString('vi-VN');

        if (s.type === 'replacement') {
          return '<div class="dsh-sale-row">' +
            '<div class="dsh-sale-row-left">' +
              '<div class="dsh-customer-name">' + (s.customer_name || 'Khách vãng lai') + '</div>' +
              '<div class="dsh-sale-date">' + date + '</div>' +
            '</div>' +
            '<div class="dsh-sale-money"><span class="badge badge-warning">Đổi lỗi</span></div>' +
          '</div>';
        }

        return '<div class="dsh-sale-row">' +
          '<div class="dsh-sale-row-left">' +
            '<div class="dsh-customer-name">' + (s.customer_name || 'Khách vãng lai') + '</div>' +
            '<div class="dsh-sale-date">' + date + '</div>' +
          '</div>' +
          '<div class="dsh-sale-money">' +
            '<span class="dsh-money-val">' + Format.number(s.total) + '</span>' +
            '<span class="dsh-money-unit">đ</span>' +
          '</div>' +
        '</div>';
      }).join('');
    } else {
      recentSales.innerHTML = '<div class="text-muted text-sm text-center py-4">Chưa có bán hàng nào</div>';
    }
  }
  
  // Render revenue chart - daily data for last 14 days
  renderRevenueChart(data.dailyRevenue);
}

function renderRevenueChart(dailyData) {
  const canvas = document.getElementById('revenueChart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  // Filter to current month only
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-indexed
  const monthData = (dailyData || []).filter(function(d) {
    if (!d.day) return false;
    var parts = d.day.split('-');
    return parseInt(parts[0]) === currentYear && parseInt(parts[1]) === currentMonth;
  });

  const revenues = monthData.map(function(d) { return d.revenue || 0; });
  const netProfits = monthData.map(function(d) {
    return Math.max(0, (d.profit || 0) - (d.expenses || 0));
  });
  const labels = monthData.map(function(d) {
    var parts = d.day.split('-');
    return parseInt(parts[2]) + '/' + parseInt(parts[1]);
  });

  if (revenueChart) {
    revenueChart.destroy();
  }

  if (!monthData || monthData.length === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '13px Inter';
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#848E9C';
    ctx.textAlign = 'center';
    ctx.fillText('Chưa có dữ liệu tháng ' + currentMonth + '/' + currentYear, canvas.width / 2, canvas.height / 2);
    return;
  }

  var root = document.documentElement;
  var textColor = getComputedStyle(root).getPropertyValue('--text-muted').trim() || '#848E9C';
  var gridColor = getComputedStyle(root).getPropertyValue('--border').trim() || '#2B3139';
  var primaryColor = getComputedStyle(root).getPropertyValue('--primary').trim() || '#FCD535';
  var greenColor = getComputedStyle(root).getPropertyValue('--green').trim() || '#0ECB81';
  var tooltipBg = getComputedStyle(root).getPropertyValue('--card').trim() || '#1E2329';
  var tooltipText = getComputedStyle(root).getPropertyValue('--text-primary').trim() || '#EAECEF';

  revenueChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Doanh thu',
          data: revenues,
          borderColor: primaryColor,
          backgroundColor: 'rgba(252,213,53,0.08)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: primaryColor,
          yAxisID: 'y'
        },
        {
          label: 'Lợi nhuận',
          data: netProfits,
          borderColor: greenColor,
          backgroundColor: 'rgba(14,203,129,0.06)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: greenColor,
          yAxisID: 'y'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: tooltipBg,
          titleColor: tooltipText,
          bodyColor: textColor,
          borderColor: gridColor,
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: function(ctx) {
              return ' ' + ctx.dataset.label + ': ' + formatVND(ctx.raw);
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: textColor,
            font: { size: 10 },
            maxTicksLimit: 15
          },
          grid: { display: false }
        },
        y: {
          position: 'left',
          grid: { color: gridColor },
          ticks: {
            callback: function(value) { return formatVND(value); },
            font: { size: 10 },
            color: textColor
          }
        }
      }
    }
  });
}

let _dashboardRefreshTimer = null;
let _dashboardRefreshInFlight = false;

function shouldRefreshDashboardEntity(entity) {
  if (!entity) return true;
  return entity === 'sale' || entity === 'expense' || entity === 'customer' || entity === 'product' || entity === 'purchase' || entity === 'sync';
}

function refreshDashboardFromMutation(reason) {
  if (_dashboardRefreshInFlight) return;
  _dashboardRefreshInFlight = true;
  // silenced

  fetch('/dashboard/data', { cache: 'no-store' })
    .then(function(r) {
      if (!r.ok) return Promise.reject(new Error('HTTP ' + r.status));
      return r.json();
    })
    .then(function(data) {
      initDashboard(data);
    })
    .catch(function(e) {
      // silenced
    })
    .finally(() => {
      _dashboardRefreshInFlight = false;
    });
}

function queueDashboardRefresh(reason) {
  clearTimeout(_dashboardRefreshTimer);
  _dashboardRefreshTimer = setTimeout(function() {
    refreshDashboardFromMutation(reason || 'mutation');
  }, 180);
}

window.addEventListener('data:mutated', function(evt) {
  const detail = evt && evt.detail ? evt.detail : {};
  if (!shouldRefreshDashboardEntity(detail.entity)) return;
  queueDashboardRefresh(detail.entity || 'mutation');
});

function shouldRefreshDashboardPath(pathname) {
  if (!pathname) return false;
  return pathname.indexOf('/api/sales') === 0 ||
    pathname.indexOf('/api/expenses') === 0 ||
    pathname.indexOf('/api/purchases') === 0 ||
    pathname.indexOf('/api/customers') === 0 ||
    pathname.indexOf('/api/products') === 0 ||
    pathname.indexOf('/api/kegs') === 0 ||
    pathname.indexOf('/dashboard/data') === 0 ||
    pathname.indexOf('/report/data') === 0;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', function(event) {
    const data = event && event.data ? event.data : {};
    if (data.type !== 'DATA_INVALIDATED') return;
    if (!shouldRefreshDashboardPath(data.path || '')) return;
    queueDashboardRefresh('sw:' + (data.path || 'unknown'));
  });
}