// Dashboard Page JavaScript
// Tách riêng để dễ bảo trì và cache
// formatVND đã được định nghĩa trong format.js

let revenueChart = null;

/**
 * Hiển thị số tiền: flex 1 hàng, không xuống dòng, chuẩn fintech.
 * Số lớn + "đ" nhỏ thấp hơn → nhìn xịn như app tài chính.
 * @param {HTMLElement|null} el
 * @param {number} amount
 * @param {string} colorClass - ví dụ 'text-success'
 * @param {{ numClass?: string, sufClass?: string, size?: 'sm'|'lg'|'stat' }} [opts]
 *   stat = ô KPI 2 cột mobile (một dòng, cỡ chữ vừa); lg = số lớn; sm = mặc định cũ
 */
function setMoneyAmount(el, amount, colorClass, opts) {
  if (!el || typeof Format === 'undefined') return;
  opts = opts || {};
  var isLarge = opts.size === 'lg';
  var isStat = opts.size === 'stat';

  // Number: KPI nửa màn hình — text nhỏ hơn text-3xl để không tràn / không ngắt dòng
  var numClass = opts.numClass;
  if (!numClass) {
    if (isStat) {
      numClass =
        'text-sm font-bold leading-tight tabular-nums tracking-tight whitespace-nowrap sm:text-base';
    } else if (isLarge) {
      numClass = 'text-2xl font-bold tracking-tight leading-none tabular-nums whitespace-nowrap sm:text-3xl';
    } else {
      numClass = 'text-[22px] font-bold tracking-tight leading-none tabular-nums';
    }
  }

  // "đ": nhỏ hơn, thấp xuống (mb-0.5), mờ hơn để không cạnh tranh với số
  var sufClass = opts.sufClass || 'text-[10px] sm:text-xs mb-0.5 opacity-70 shrink-0 whitespace-nowrap';

  el.className = 'min-w-0';
  el.innerHTML =
    '<div class="card-stat-amount ' + (colorClass || '') + '">' +
    '<span class="' + numClass + '">' + Format.number(amount) + '</span>' +
    '<span class="' + sufClass + '">đ</span>' +
    '</div>';
}

function initDashboard(data) {
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
      todayRevenueEl.className = 'text-base font-medium text-muted italic';
    } else {
      setMoneyAmount(todayRevenueEl, todayRevenue, 'text-primary', { size: 'stat' });
    }
  }

  // Set today's units
  setText('todayUnits', data.todayUnits?.units || 0);

  // Net profit today (profit - expenses)
  const todayProfit = (data.todayStats?.profit || 0) - (data.expenses?.today || 0);
  const todayProfitEl = document.getElementById('todayProfit');
  if (todayProfitEl) {
    if (todayProfit === 0) {
      todayProfitEl.textContent = 'Chưa có dữ liệu hôm nay';
      todayProfitEl.className = 'text-base font-medium text-muted italic';
    } else if (todayProfit > 0) {
      setMoneyAmount(todayProfitEl, todayProfit, 'text-success', { size: 'stat' });
    } else {
      setMoneyAmount(todayProfitEl, todayProfit, 'text-danger', { size: 'stat' });
    }
  }

  // Today's expenses
  const todayExpenseAmt = data.expenses?.today || 0;
  const todayExpenseEl = document.getElementById('todayExpense');
  if (todayExpenseEl) {
    if (todayExpenseAmt === 0) {
      todayExpenseEl.textContent = 'Không có chi phí hôm nay';
      todayExpenseEl.className = 'text-base font-medium text-muted italic';
    } else {
      setMoneyAmount(todayExpenseEl, todayExpenseAmt, 'text-danger', { size: 'stat' });
    }
  }

  // Net profit this month (profit - expenses)
  const monthProfit = (data.monthStats?.profit || 0) - (data.expenses?.month || 0);
  const monthProfitEl = document.getElementById('monthProfit');
  if (monthProfitEl) {
    if (monthProfit === 0) {
      monthProfitEl.textContent = 'Chưa có dữ liệu';
      monthProfitEl.className = 'text-base font-medium text-muted italic';
    } else if (monthProfit > 0) {
      setMoneyAmount(monthProfitEl, monthProfit, 'text-success', { size: 'stat' });
    } else {
      setMoneyAmount(monthProfitEl, monthProfit, 'text-danger', { size: 'stat' });
    }
  }

  // Month's expenses
  const monthExpenseAmt = data.expenses?.month || 0;
  const monthExpenseEl = document.getElementById('monthExpense');
  if (monthExpenseEl) {
    if (monthExpenseAmt === 0) {
      monthExpenseEl.textContent = 'Không có chi phí';
      monthExpenseEl.className = 'text-base font-medium text-muted italic';
    } else {
      setMoneyAmount(monthExpenseEl, monthExpenseAmt, 'text-danger', { size: 'stat' });
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
        '<div class="flex justify-between text-sm"><span>' + p.name + '</span><span class="font-bold text-danger">' + p.stock + ' bình</span></div>'
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
      header.textContent = '⚠️ Dưới mức kỳ vọng (' + monthly + ' bình/tháng, kỳ vọng đạt ' + expected + ' bình sau ' + elapsed + '/' + total + ' ngày)';
    }
    if (list) {
      list.innerHTML = data.kpiAlerts.map(c => {
        const shortfall = Math.round(Number(c.shortfall) || 0);
        const monthlyQty = Number(c.monthly_qty) || 0;
        let colorClass = 'text-warning';
        if (shortfall > 50) {
          colorClass = 'text-danger';
        } else if (shortfall > 20) {
          colorClass = 'text-warning';
        }

        const phoneBtn = c.phone ?
          '<a href="tel:' + c.phone + '" class="ml-2 text-success hover:bg-success/10 rounded px-1">📞</a>' : '';

        return '<div class="flex justify-between items-center text-sm py-1">' +
          '<div class="flex items-center">' +
            '<a href="/customers/' + c.id + '" class="hover:text-success">' + c.name + '</a>' +
            phoneBtn +
          '</div>' +
          '<div class="text-right">' +
            '<span class="font-bold ' + colorClass + '">-' + shortfall + ' bình</span>' +
            '<span class="text-muted text-xs ml-1">(' + monthlyQty + ' đã lấy)</span>' +
          '</div>' +
        '</div>';
      }).join('');
    }
  }
  
  // Render recent sales
  const recentSales = document.getElementById('recentSales');
  if (recentSales) {
    if (data.recentSales && data.recentSales.length > 0) {
      recentSales.innerHTML = data.recentSales.slice(0, 5).map(s => {
        const date = new Date(s.date).toLocaleDateString('vi-VN');

        let moneyHtml = '';
        if (s.type === 'replacement') {
          moneyHtml = '<span class="badge badge-warning">🔁 Đổi lỗi</span>';
        } else {
          const formatted = Format.number(s.total);
          moneyHtml = '<span class="money text-money">' + formatted + '<span class="unit"> đ</span></span>';
        }

        return '<div class="flex justify-between items-center py-3 border-b border-muted">' +
          '<div>' +
            '<div class="font-semibold text-main">' + s.customer_name + '</div>' +
            '<div class="text-xs text-muted mt-0.5">' + date + '</div>' +
          '</div>' +
          '<div>' + moneyHtml + '</div>' +
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
    setMoneyAmount(totalRev6El, totalRevenue, 'text-primary', {
      numClass: 'text-sm font-bold tracking-tight tabular-nums',
      sufClass: 'text-xs mb-0.5 opacity-70 shrink-0'
    });
  }
  if (avgRev6El) {
    setMoneyAmount(avgRev6El, totalNetProfit, 'text-success', {
      numClass: 'text-sm font-bold tracking-tight tabular-nums',
      sufClass: 'text-xs mb-0.5 opacity-70 shrink-0'
    });
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
  
  // Create gradient for revenue bars
  const gradient = ctx.createLinearGradient(0, 0, 0, 250);
  gradient.addColorStop(0, '#22c55e');
  gradient.addColorStop(1, '#16a34a');
  
  // Create gradient for profit line
  const profitGradient = ctx.createLinearGradient(0, 0, 0, 250);
  profitGradient.addColorStop(0, '#f59e0b');
  profitGradient.addColorStop(1, '#d97706');

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
          borderColor: '#16a34a',
          backgroundColor: 'rgba(22, 163, 74, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: '#16a34a',
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
            font: { size: 10 }
          }
        },
        y: {
          position: 'left',
          grid: {
            color: '#f3f4f6'
          },
          ticks: {
            callback: function(value) {
              return formatVND(value);
            },
            font: { size: 10 }
          }
        }
      }
    }
  });
}
