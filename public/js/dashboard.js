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

  // Set today's revenue
  setText('todayRevenue', formatVND(data.todayStats?.revenue || 0));

  // Set today's units
  setText('todayUnits', data.todayUnits?.units || 0);

  // Net profit today (profit - expenses)
  const todayProfit = (data.todayStats?.profit || 0) - (data.expenses?.today || 0);
  setText('todayProfit', formatVND(Math.max(0, todayProfit)));
  // Highlight negative in red
  const todayProfitEl = document.getElementById('todayProfit');
  if (todayProfitEl) {
    todayProfitEl.className = 'text-2xl font-bold ' + (todayProfit >= 0 ? 'text-green-600' : 'text-red-600');
  }

  // Today's expenses
  setText('todayExpense', formatVND(data.expenses?.today || 0));

  // Net profit this month (profit - expenses)
  const monthProfit = (data.monthStats?.profit || 0) - (data.expenses?.month || 0);
  setText('monthProfit', formatVND(Math.max(0, monthProfit)));
  // Highlight negative in red
  const monthProfitEl = document.getElementById('monthProfit');
  if (monthProfitEl) {
    monthProfitEl.className = 'text-2xl font-bold ' + (monthProfit >= 0 ? 'text-green-600' : 'text-red-600');
  }

  // Month's expenses
  setText('monthExpense', formatVND(data.expenses?.month || 0));
  
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
