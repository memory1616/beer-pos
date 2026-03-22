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
  
  // Render customer alerts (configurable days no order)
  if (data.customerAlerts && data.customerAlerts.length > 0) {
    const section = document.getElementById('customerAlertsSection');
    const list = document.getElementById('customerAlertsList');
    const header = document.getElementById('customerAlertsHeader');
    if (section) section.classList.remove('hidden');
    if (header && data.customerAlertDays) {
      header.textContent = '⚠️ KH ' + data.customerAlertDays + ' ngày chưa lấy bia';
    }
    if (list) {
      list.innerHTML = data.customerAlerts.map(c => {
        // Color based on days: threshold-1 = yellow, threshold*1.5 = orange, threshold*2+ = red
        const threshold = data.customerAlertDays || 7;
        let colorClass = 'text-yellow-600';
        if (c.days > threshold * 2) {
          colorClass = 'text-red-600';
        } else if (c.days > threshold * 1.5) {
          colorClass = 'text-orange-500';
        }

        const phoneBtn = c.phone ?
          '<a href="tel:' + c.phone + '" class="ml-2 text-green-600 hover:bg-green-100 rounded px-1">📞</a>' : '';

        return '<div class="flex justify-between items-center text-sm py-1">' +
          '<div class="flex items-center">' +
            '<a href="/customers/' + c.id + '" class="hover:text-green-600">' + c.name + '</a>' +
            phoneBtn +
          '</div>' +
          '<span class="font-bold ' + colorClass + '">' + c.days + ' ngày</span>' +
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
  const totalRevenue = revenues.reduce((sum, r) => sum + r, 0);
  const avgRevenue = revenues.length > 0 ? totalRevenue / revenues.length : 0;
  
  // Calculate growth (today vs yesterday)
  let growth = 0;
  if (revenues.length >= 2) {
    const today = revenues[revenues.length - 1];
    const yesterday = revenues[revenues.length - 2];
    growth = yesterday > 0 ? ((today - yesterday) / yesterday * 100) : 0;
  }
  
  // Update stats display
  setText('totalRevenue6M', formatVND(totalRevenue));
  setText('avgRevenue6M', formatVND(avgRevenue));
  const growthEl = document.getElementById('growthRevenue6M');
  if (revenues.length >= 2) {
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
          label: 'Lợi nhuận',
          data: profits,
          type: 'line',
          borderColor: '#f59e0b',
          backgroundColor: profitGradient,
          borderWidth: 2,
          fill: false,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: '#f59e0b',
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
