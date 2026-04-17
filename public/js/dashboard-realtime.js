/**
 * BeerPOS - Dashboard Real-time Updates
 *
 * Kết hợp Socket.IO client với dashboard để tự động cập nhật
 * KPIs mà không cần reload trang.
 */

(function() {
  // Chờ DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRealtimeDashboard);
  } else {
    initRealtimeDashboard();
  }
})();

function initRealtimeDashboard() {
  // Khởi tạo realtime client
  if (typeof initRealtime === 'function') {
    initRealtime();
    console.log('[Dashboard] Realtime client initialized');
  }

  // ── Lắng nghe events ─────────────────────────────────────────────────────────

  // Dashboard refresh (sau khi có mutation)
  if (typeof onDashboardRefresh === 'function') {
    onDashboardRefresh(handleDashboardRefresh);
  }

  // New order created
  if (typeof onNewOrder === 'function') {
    onNewOrder(handleNewOrder);
  }

  // Keg updates
  if (typeof onKegUpdate === 'function') {
    onKegUpdate(handleKegUpdate);
  }

  // Refetch request (từ client khác)
  if (typeof onRefetch === 'function') {
    onRefetch(handleRefetchRequest);
  }

  // ── Event handlers ───────────────────────────────────────────────────────────

  let refreshTimer = null;

  function handleDashboardRefresh(data) {
    console.log('[Dashboard] Refresh triggered:', data);

    // Debounce: chỉ refresh 1 lần sau 500ms
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshDashboardKPIs();
    }, 500);
  }

  function handleNewOrder(data) {
    console.log('[Dashboard] New order:', data?.sale?.id);

    // Hiệu ứng notification
    showRealtimeToast('🆕 Đơn mới!', data?.sale?.customer_name || 'Khách lẻ');

    // Refresh KPIs sau 1s
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshDashboardKPIs();
    }, 1000);
  }

  function handleKegUpdate(data) {
    console.log('[Dashboard] Keg updated:', data?.kegs);
    refreshKegStats();
  }

  function handleRefetchRequest(data) {
    console.log('[Dashboard] Refetch requested for:', data?.entities);

    if (data?.entities?.includes('all') || data?.entities?.includes('dashboard')) {
      refreshDashboardKPIs();
    }
  }

  // ── Refresh functions ─────────────────────────────────────────────────────────

  /**
   * Refresh dashboard KPIs (chỉ phần KPIs, không reload toàn bộ trang)
   */
  async function refreshDashboardKPIs() {
    try {
      // Nếu có batch API, dùng nó
      if (typeof loadDashboardOptimized === 'function') {
        const data = await loadDashboardOptimized(true); // force refresh
        if (typeof initDashboard === 'function' && data) {
          updateKPIsOnly(data);
        }
      } else {
        // Fallback: fetch trực tiếp
        const res = await fetch('/dashboard/data', { cache: 'no-store' });
        const data = await res.json();
        if (typeof initDashboard === 'function' && data) {
          updateKPIsOnly(data);
        }
      }
    } catch (e) {
      console.error('[Dashboard] Refresh error:', e);
    }
  }

  /**
   * Update KPIs only (không re-render toàn bộ dashboard)
   * Tối ưu: chỉ cập nhật các elements cần thiết
   */
  function updateKPIsOnly(data) {
    // Update today's revenue
    const todayRevenue = data.todayStats?.revenue || 0;
    const todayRevenueEl = document.getElementById('todayRevenue');
    if (todayRevenueEl && typeof setMoneyAmount === 'function') {
      setMoneyAmount(todayRevenueEl, todayRevenue, 'success', { size: 'lg' });
    }

    // Update today's units
    const todayUnits = data.todayUnits?.units || 0;
    const todayUnitsEl = document.getElementById('todayUnits');
    if (todayUnitsEl && typeof setMoneyAmount === 'function') {
      setMoneyAmount(todayUnitsEl, todayUnits, 'success', { size: 'lg', omitUnit: true });
    }

    // Update today's profit
    const todayProfit = (data.todayStats?.profit || 0) - (data.expenses?.today || 0);
    const todayProfitEl = document.getElementById('todayProfit');
    if (todayProfitEl && typeof setMoneyAmount === 'function') {
      if (todayProfit > 0) {
        setMoneyAmount(todayProfitEl, todayProfit, 'profit', { size: 'stat' });
      } else if (todayProfit < 0) {
        setMoneyAmount(todayProfitEl, todayProfit, 'danger', { size: 'stat' });
      }
    }

    // Update today's expense
    const todayExpense = data.expenses?.today || 0;
    const todayExpenseEl = document.getElementById('todayExpense');
    if (todayExpenseEl && typeof setMoneyAmount === 'function') {
      if (todayExpense > 0) {
        setMoneyAmount(todayExpenseEl, todayExpense, 'danger', { size: 'stat' });
      }
    }

    // Update month profit
    const monthProfit = (data.monthStats?.profit || 0) - (data.expenses?.month || 0);
    const monthProfitEl = document.getElementById('monthProfit');
    if (monthProfitEl && typeof setMoneyAmount === 'function') {
      if (monthProfit > 0) {
        setMoneyAmount(monthProfitEl, monthProfit, 'profit', { size: 'stat' });
      } else if (monthProfit < 0) {
        setMoneyAmount(monthProfitEl, monthProfit, 'danger', { size: 'stat' });
      }
    }

    // Update month expense
    const monthExpense = data.expenses?.month || 0;
    const monthExpenseEl = document.getElementById('monthExpense');
    if (monthExpenseEl && typeof setMoneyAmount === 'function') {
      if (monthExpense > 0) {
        setMoneyAmount(monthExpenseEl, monthExpense, 'danger', { size: 'stat' });
      }
    }

    // Update keg state
    if (data.kegState) {
      const kegInventory = document.getElementById('kegInventory');
      const kegEmptyCollected = document.getElementById('kegEmptyCollected');
      const kegCustomerHolding = document.getElementById('kegCustomerHolding');
      const kegTotal = document.getElementById('kegTotal');

      if (kegInventory) kegInventory.textContent = data.kegState.inventory || 0;
      if (kegEmptyCollected) kegEmptyCollected.textContent = data.kegState.emptyCollected || 0;
      if (kegCustomerHolding) kegCustomerHolding.textContent = data.kegState.customerHolding || 0;
      if (kegTotal) kegTotal.textContent = data.kegState.total || 0;
    }

    // Update recent sales
    if (data.recentSales && data.recentSales.length > 0) {
      renderRecentSales(data.recentSales);
    }

    // Update chart
    if (data.dailyRevenue) {
      renderRevenueChart(data.dailyRevenue);
    }

    console.log('[Dashboard] KPIs updated');
  }

  /**
   * Refresh keg stats only
   */
  async function refreshKegStats() {
    try {
      const res = await fetch('/api/kegs/stats', { cache: 'no-store' });
      const data = await res.json();

      if (data.inventory !== undefined) {
        const kegInventory = document.getElementById('kegInventory');
        if (kegInventory) kegInventory.textContent = data.inventory;
      }

      // Flash effect
      const kegSection = document.querySelector('.keg-section');
      if (kegSection) {
        kegSection.classList.add('flash');
        setTimeout(() => kegSection.classList.remove('flash'), 500);
      }
    } catch (e) {
      console.error('[Dashboard] Keg refresh error:', e);
    }
  }

  /**
   * Render recent sales
   */
  function renderRecentSales(sales) {
    const container = document.getElementById('recentSales');
    if (!container) return;

    container.innerHTML = sales.slice(0, 5).map(s => {
      const date = new Date(s.date).toLocaleDateString('vi-VN');
      return `
        <div class="dsh-sale-row">
          <div class="dsh-sale-row-left">
            <div class="dsh-customer-name">${s.customer_name || 'Khách lẻ'}</div>
            <div class="dsh-sale-date">${date}</div>
          </div>
          <div class="dsh-sale-money">
            <span class="dsh-money-val">${Format?.number(s.total) || s.total}</span>
            <span class="dsh-money-unit">đ</span>
          </div>
        </div>
      `;
    }).join('');
  }

  /**
   * Show realtime toast notification
   */
  function showRealtimeToast(icon, message) {
    // Flash badge
    const badge = document.createElement('div');
    badge.style.cssText = `
      position: fixed;
      top: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--card);
      border: 2px solid var(--primary);
      border-radius: 12px;
      padding: 12px 20px;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      z-index: 9999;
      animation: slideDown 0.3s ease;
    `;
    badge.innerHTML = `<span style="font-size:20px">${icon}</span><span style="font-weight:600">${message}</span>`;
    document.body.appendChild(badge);

    setTimeout(() => {
      badge.style.opacity = '0';
      badge.style.transform = 'translateX(-50%) translateY(-20px)';
      setTimeout(() => badge.remove(), 300);
    }, 2500);
  }

  console.log('[Dashboard] Real-time updates initialized');
}

// ─── CSS animations (injected) ──────────────────────────────────────────────────

const dashboardRealtimeCSS = document.createElement('style');
dashboardRealtimeCSS.textContent = `
  @keyframes slideDown {
    from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }

  .keg-section.flash {
    animation: flash 0.5s ease;
  }

  @keyframes flash {
    0%, 100% { background: var(--card); }
    50% { background: var(--primary-dim); }
  }

  .fuzzy-highlight {
    background: var(--primary);
    color: var(--btn-primary-color);
    border-radius: 2px;
    padding: 0 2px;
  }

  .fuzzy-search-wrapper {
    position: relative;
    width: 100%;
  }

  .fuzzy-search-input-wrap {
    position: relative;
  }

  .fuzzy-search-input {
    width: 100%;
    height: 48px;
    padding: 0 40px 0 16px;
    border: 2px solid var(--border);
    border-radius: 12px;
    background: var(--card);
    color: var(--text-primary);
    font-size: 16px;
    outline: none;
    transition: border-color 0.2s;
  }

  .fuzzy-search-input:focus {
    border-color: var(--primary);
  }

  .fuzzy-search-clear {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    width: 24px;
    height: 24px;
    border: none;
    background: var(--bg-hover);
    color: var(--text-secondary);
    border-radius: 50%;
    cursor: pointer;
    font-size: 16px;
  }

  .fuzzy-search-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    margin-top: 4px;
    max-height: 300px;
    overflow-y: auto;
    z-index: 100;
    box-shadow: 0 4px 20px rgba(0,0,0,0.2);
  }

  .fuzzy-search-item {
    padding: 12px 16px;
    cursor: pointer;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .fuzzy-search-item:last-child {
    border-bottom: none;
  }

  .fuzzy-search-item.selected {
    background: var(--primary-dim);
  }

  .fuzzy-search-item:hover {
    background: var(--bg-hover);
  }

  .fuzzy-search-item-name {
    font-weight: 500;
    color: var(--text-primary);
  }

  .fuzzy-search-item-meta {
    display: flex;
    gap: 12px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .fuzzy-search-empty {
    padding: 20px;
    text-align: center;
    color: var(--text-secondary);
  }

  .fuzzy-search-add-new {
    margin-top: 8px;
    padding: 8px 16px;
    background: var(--primary);
    color: var(--btn-primary-color);
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 600;
  }

  .tier-badge.vip {
    background: var(--warning);
    color: var(--btn-primary-color);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
    margin-right: 4px;
  }
`;

document.head.appendChild(dashboardRealtimeCSS);