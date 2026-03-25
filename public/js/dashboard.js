// Dashboard Page JavaScript
// Tách riêng để dễ bảo trì và cache
// formatVND đã được định nghĩa trong format.js

let revenueChart = null;

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
      todayRevenueEl.className = 'text-base font-medium text-gray-400 italic';
    } else {
      todayRevenueEl.textContent = formatVND(todayRevenue);
      todayRevenueEl.className = 'text-2xl font-bold text-amber-600';
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
      todayProfitEl.className = 'text-base font-medium text-gray-400 italic';
    } else if (todayProfit > 0) {
      todayProfitEl.textContent = formatVND(todayProfit);
      todayProfitEl.className = 'text-2xl font-bold text-green-600';
    } else {
      todayProfitEl.textContent = formatVND(todayProfit);
      todayProfitEl.className = 'text-2xl font-bold text-red-600';
    }
  }

  // Today's expenses
  const todayExpenseAmt = data.expenses?.today || 0;
  const todayExpenseEl = document.getElementById('todayExpense');
  if (todayExpenseEl) {
    if (todayExpenseAmt === 0) {
      todayExpenseEl.textContent = 'Không có chi phí hôm nay';
      todayExpenseEl.className = 'text-base font-medium text-gray-400 italic';
    } else if (todayRevenue === 0) {
      todayExpenseEl.textContent = formatVND(todayExpenseAmt);
      todayExpenseEl.className = 'text-2xl font-bold text-orange-500';
    } else {
      todayExpenseEl.textContent = formatVND(todayExpenseAmt);
      todayExpenseEl.className = 'text-2xl font-bold text-red-500';
    }
  }

  // Net profit this month (profit - expenses)
  const monthProfit = (data.monthStats?.profit || 0) - (data.expenses?.month || 0);
  const monthProfitEl = document.getElementById('monthProfit');
  if (monthProfitEl) {
    if (monthProfit === 0) {
      monthProfitEl.textContent = 'Chưa có dữ liệu';
      monthProfitEl.className = 'text-base font-medium text-gray-400 italic';
    } else if (monthProfit > 0) {
      monthProfitEl.textContent = formatVND(monthProfit);
      monthProfitEl.className = 'text-2xl font-bold text-green-600';
    } else {
      monthProfitEl.textContent = formatVND(monthProfit);
      monthProfitEl.className = 'text-2xl font-bold text-red-600';
    }
  }

  // Month's expenses
  const monthExpenseAmt = data.expenses?.month || 0;
  const monthExpenseEl = document.getElementById('monthExpense');
  if (monthExpenseEl) {
    if (monthExpenseAmt === 0) {
      monthExpenseEl.textContent = 'Không có chi phí';
      monthExpenseEl.className = 'text-base font-medium text-gray-400 italic';
    } else {
      monthExpenseEl.textContent = formatVND(monthExpenseAmt);
      monthExpenseEl.className = 'text-2xl font-bold text-red-500';
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
    
    // Calculate and set percentages
    const inventoryPct = total > 0 ? Math.round((inventory / total) * 100) : 0;
    const emptyPct = total > 0 ? Math.round((emptyCollected / total) * 100) : 0;
    const customerPct = total > 0 ? Math.round((customerHolding / total) * 100) : 0;
    
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
        '<div class="flex justify-between text-sm"><span>' + p.name + '</span><span class="font-bold text-red-600">' + p.stock + ' bình</span></div>'
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
        let colorClass = 'text-yellow-600';
        if (shortfall > 50) {
          colorClass = 'text-red-600';
        } else if (shortfall > 20) {
          colorClass = 'text-orange-500';
        }

        const phoneBtn = c.phone ?
          '<a href="tel:' + c.phone + '" class="ml-2 text-green-600 hover:bg-green-100 rounded px-1">📞</a>' : '';

        return '<div class="flex justify-between items-center text-sm py-1">' +
          '<div class="flex items-center">' +
            '<a href="/customers/' + c.id + '" class="hover:text-green-600">' + c.name + '</a>' +
            phoneBtn +
          '</div>' +
          '<div class="text-right">' +
            '<span class="font-bold ' + colorClass + '">-' + shortfall + ' bình</span>' +
            '<span class="text-gray-400 text-xs ml-1">(' + monthlyQty + ' đã lấy)</span>' +
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
        
        // Style based on sale type
        let totalDisplay = '';
        let rowClass = '';
        if (s.type === 'replacement') {
          totalDisplay = '<span class="font-bold text-orange-600">🔁 Đổi lỗi</span>';
          rowClass = 'bg-orange-50';
        } else {
          totalDisplay = '<span class="font-bold text-green-600">' + formatVND(s.total) + '</span>';
        }
        
        return '<div class="flex justify-between items-center py-2 border-b ' + rowClass + '">' +
          '<div>' +
            '<div class="font-medium">' + s.customer_name + '</div>' +
            '<div class="text-xs text-gray-500">' + date + '</div>' +
          '</div>' +
          '<div>' + totalDisplay + '</div>' +
        '</div>';
      }).join('');
    } else {
      recentSales.innerHTML = '<div class="text-gray-500 text-sm text-center py-4">Chưa có bán hàng nào</div>';
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

  // Update stats display
  setText('totalRevenue6M', formatVND(totalRevenue));
  setText('avgRevenue6M', formatVND(totalNetProfit));
  const growthEl = document.getElementById('growthRevenue6M');
  if (netProfits.length >= 2) {
    if (growthEl) {
      growthEl.textContent = (growth >= 0 ? '+' : '') + growth.toFixed(0) + '%';
      growthEl.className = 'font-bold text-sm ' + (growth >= 0 ? 'text-green-600' : 'text-red-600');
    }
  } else {
    if (growthEl) {
      growthEl.textContent = '-';
      growthEl.className = 'font-bold text-sm text-gray-400';
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
  
  // Bar: amber (doanh thu), Line: indigo (lợi nhuận) - dễ phân biệt hơn
  const barGradient = ctx.createLinearGradient(0, 0, 0, 250);
  barGradient.addColorStop(0, 'rgba(245, 158, 11, 0.9)');
  barGradient.addColorStop(1, 'rgba(217, 119, 6, 0.9)');

  revenueChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Doanh thu',
          data: revenues,
          backgroundColor: barGradient,
          borderRadius: 6,
          barThickness: 'flex',
          barPercentage: 0.7,
          categoryPercentage: 0.85,
          yAxisID: 'y'
        },
        {
          label: 'Lợi nhuận ròng',
          data: netProfits,
          type: 'line',
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.08)',
          borderWidth: 2.5,
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointBackgroundColor: '#6366f1',
          pointBorderColor: '#fff',
          pointBorderWidth: 1,
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
            padding: 16,
            font: { size: 12 }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.85)',
          padding: 12,
          cornerRadius: 8,
          titleFont: { size: 13 },
          bodyFont: { size: 12 },
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
            font: { size: 11 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 10
          }
        },
        y: {
          position: 'left',
          grid: {
            color: 'rgba(0,0,0,0.06)'
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
