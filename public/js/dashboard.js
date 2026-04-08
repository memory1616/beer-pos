// Dashboard Page JavaScript
// Tách riêng để dễ bảo trì và cache
// formatVND đã được định nghĩa trong format.js

let revenueChart = null;

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
            '<div class="text-sm font-semibold" style="color:#e2e8f0;">' + p.name + '</div>' +
          '</div>' +
          '<div class="font-bold tabular-nums" style="color:#ef4444;font-size:14px;flex-shrink:0;">' + p.stock + ' bình</div>' +
        '</div>'
      ).join('');
    }
  }
  
  // Render KPI alerts (thiếu bình so với kỳ vọng tháng, có lọc exclude_expected)
  if (data.kpiAlerts && data.kpiAlerts.length > 0) {
    const section = document.getElementById('customerAlertsSection');
    const list = document.getElementById('customerAlertsList');
    const header = document.getElementById('customerAlertsHeader');
    if (section) section.classList.remove('hidden');
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

  // Helper function to safely set text content
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  // Check if there's data
  if (!dailyData || dailyData.length === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '14px Inter';
    ctx.fillStyle = '#9ca3af';
    ctx.textAlign = 'center';
    ctx.fillText('Chưa có dữ liệu', canvas.width / 2, canvas.height / 2);
    
    // Reset stats
    setText('totalRevenue6M', '-');
    setText('avgRevenue6M', '-');
    setText('growthRevenue6M', '-');
    return;
  }

  // Calculate stats
  const revenues = dailyData.map(d => d.revenue || 0);
  const profits = dailyData.map(d => d.profit || 0);
  const netProfits = dailyData.map(d => {
    const profit = d.profit || 0;
    const expense = (d.expenses || 0);
    return Math.max(0, profit - expense);
  });
  const totalRevenue = revenues.reduce((sum, r) => sum + r, 0);
  const avgRevenue = revenues.length > 0 ? totalRevenue / revenues.length : 0;
  const totalNetProfit = netProfits.reduce((sum, n) => sum + n, 0);

  // Calculate growth (today vs yesterday) - based on net profit
  let growth = 0;
  if (netProfits.length >= 2) {
    const today = netProfits[netProfits.length - 1];
    const yesterday = netProfits[netProfits.length - 2];
    growth = yesterday > 0 ? ((today - yesterday) / yesterday * 100) : 0;
  }

  // Update stats display (flex số + đ, không xuống dòng)
  const totalRev6El = document.getElementById('totalRevenue6M');
  const avgRev6El = document.getElementById('avgRevenue6M');
  if (totalRev6El) {
    setMoneyAmount(totalRev6El, totalRevenue, 'primary', { compact: true });
  }
  if (avgRev6El) {
    setMoneyAmount(avgRev6El, totalNetProfit, 'profit', { compact: true });
  }
  const growthEl = document.getElementById('growthRevenue6M');
  if (netProfits.length >= 2) {
    if (growthEl) {
      growthEl.textContent = (growth >= 0 ? '+' : '') + growth.toFixed(0) + '%';
      growthEl.className = 'font-bold text-sm ' + (growth >= 0 ? 'text-success' : 'text-danger');
    }
  } else {
    if (growthEl) {
      growthEl.textContent = '-';
      growthEl.className = 'font-bold text-sm text-muted';
    }
  }

  // Prepare data - last 14 days
  const labels = dailyData.map(d => {
    const date = new Date(d.day);
    return date.getDate() + '/' + (date.getMonth() + 1);
  });
  
  if (revenueChart) {
    revenueChart.destroy();
  }
  
  // Create gradient for revenue bars — clean green
  const gradient = ctx.createLinearGradient(0, 0, 0, 250);
  gradient.addColorStop(0, '#22c55e');
  gradient.addColorStop(1, '#16a34a');

  // Create gradient for net profit line — blue for contrast
  const profitGradient = ctx.createLinearGradient(0, 0, 0, 250);
  profitGradient.addColorStop(0, '#3b82f6');
  profitGradient.addColorStop(1, '#2563eb');

  revenueChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Doanh thu',
          data: revenues,
          backgroundColor: gradient,
          borderRadius: 4,
          barThickness: 16,
          yAxisID: 'y'
        },
        {
          label: 'Lợi nhuận ròng',
          data: netProfits,
          type: 'line',
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: '#3b82f6',
          yAxisID: 'y'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            usePointStyle: true,
            padding: 15
          }
        },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.8)',
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: function(ctx) {
              return ctx.dataset.label + ': ' + formatVND(ctx.raw);
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          },
          ticks: {
            font: { size: 10 },
            color: '#9ca3af'
          }
        },
        y: {
          position: 'left',
          grid: {
            color: '#374151'
          },
          ticks: {
            callback: function(value) {
              return formatVND(value);
            },
            font: { size: 10 },
            color: '#9ca3af'
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
  console.log('[CONSISTENCY][Dashboard] refresh', reason || 'mutation');

  fetch('/dashboard/data', { cache: 'no-store' })
    .then(r => r.json())
    .then(data => {
      initDashboard(data);
    })
    .catch(e => {
      console.error('[CONSISTENCY][Dashboard] refresh error', e);
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