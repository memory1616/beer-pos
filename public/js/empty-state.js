/**
 * Beer POS - Empty State Component
 * Consistent empty UI across all pages
 */

/**
 * Generate empty state HTML
 * @param {string} type - 'search', 'no-data', 'error', 'offline'
 * @param {object} options - { title, message, action, icon }
 */
function getEmptyState(type, options = {}) {
  const icons = {
    search: '🔍',
    'no-data': '📭',
    error: '⚠',
    offline: '📡',
    'no-results': '🔎',
    'loading-failed': '🔄',
    'no-customers': '👤',
    'no-products': '🍺',
    'no-sales': '📝',
    'no-expenses': '💰'
  };

  const defaultMessages = {
    search: 'Không tìm thấy kết quả',
    'no-data': 'Chưa có dữ liệu',
    error: 'Đã xảy ra lỗi',
    offline: 'Không có kết nối mạng',
    'no-results': 'Không có kết quả phù hợp',
    'loading-failed': 'Không thể tải dữ liệu',
    'no-customers': 'Chưa có khách hàng nào',
    'no-products': 'Chưa có sản phẩm nào',
    'no-sales': 'Chưa có đơn hàng nào',
    'no-expenses': 'Chưa có chi phí nào'
  };

  const defaultTitles = {
    search: 'Không tìm thấy',
    'no-data': 'Trống',
    error: 'Lỗi',
    offline: 'Offline',
    'no-results': 'Không có kết quả',
    'loading-failed': 'Lỗi tải dữ liệu',
    'no-customers': 'Chưa có khách hàng',
    'no-products': 'Chưa có sản phẩm',
    'no-sales': 'Chưa có đơn hàng',
    'no-expenses': 'Chưa có chi phí'
  };

  const icon = options.icon || icons[type] || icons['no-data'];
  const title = options.title || defaultTitles[type] || 'Thông báo';
  const message = options.message || defaultMessages[type] || '';
  const actionLabel = options.actionLabel || '';
  const actionHandler = options.action || '';
  const actionIcon = options.actionIcon || '+';

  return `
    <div class="empty-state" role="status" aria-label="${title}">
      <span class="empty-state__icon" aria-hidden="true">${icon}</span>
      <h3 class="empty-state__title">${escapeHtml(title)}</h3>
      ${message ? `<p class="empty-state__message">${escapeHtml(message)}</p>` : ''}
      ${actionLabel ? `
        <button 
          class="btn btn--primary empty-state__action"
          onclick="${actionHandler}"
          aria-label="${actionLabel}"
        >
          <span>${actionIcon}</span>
          <span>${escapeHtml(actionLabel)}</span>
        </button>
      ` : ''}
    </div>
  `;
}

/**
 * Generate skeleton loading HTML
 */
function getSkeleton(type = 'list', count = 3) {
  const skeletons = {
    list: () => `
      <div class="skeleton-list">
        ${Array(count).fill(0).map(() => `
          <div class="skeleton-item">
            <div class="skeleton-item__avatar">
              <div class="skeleton skeleton--avatar"></div>
            </div>
            <div class="skeleton-item__content">
              <div class="skeleton skeleton--title"></div>
              <div class="skeleton skeleton--text" style="width: 80%;"></div>
              <div class="skeleton skeleton--text" style="width: 60%;"></div>
            </div>
          </div>
        `).join('')}
      </div>
    `,
    card: () => `
      <div class="card">
        <div class="skeleton skeleton--title"></div>
        <div class="skeleton skeleton--text"></div>
        <div class="skeleton skeleton--text" style="width: 70%;"></div>
        <div class="skeleton skeleton--text" style="width: 50%;"></div>
      </div>
      <div class="card">
        <div class="skeleton skeleton--title"></div>
        <div class="skeleton skeleton--text"></div>
        <div class="skeleton skeleton--text" style="width: 60%;"></div>
      </div>
    `,
    table: () => `
      <div style="padding: 16px;">
        <div class="skeleton skeleton--text" style="width: 30%; margin-bottom: 16px;"></div>
        ${Array(count).fill(0).map(() => `
          <div style="display: flex; gap: 12px; margin-bottom: 12px; align-items: center;">
            <div class="skeleton" style="width: 40px; height: 40px; border-radius: 50%;"></div>
            <div style="flex: 1;">
              <div class="skeleton skeleton--text" style="width: 60%;"></div>
              <div class="skeleton skeleton--text" style="width: 40%;"></div>
            </div>
          </div>
        `).join('')}
      </div>
    `,
    dashboard: () => `
      <div style="padding: 16px;">
        <div class="skeleton" style="height: 120px; border-radius: 14px; margin-bottom: 16px;"></div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div class="skeleton" style="height: 80px; border-radius: 12px;"></div>
          <div class="skeleton" style="height: 80px; border-radius: 12px;"></div>
          <div class="skeleton" style="height: 80px; border-radius: 12px;"></div>
          <div class="skeleton" style="height: 80px; border-radius: 12px;"></div>
        </div>
      </div>
    `,
    form: () => `
      <div style="padding: 20px;">
        <div class="skeleton skeleton--text" style="width: 30%; margin-bottom: 20px;"></div>
        <div style="margin-bottom: 16px;">
          <div class="skeleton" style="height: 44px; border-radius: 10px;"></div>
        </div>
        <div style="margin-bottom: 16px;">
          <div class="skeleton" style="height: 44px; border-radius: 10px;"></div>
        </div>
        <div style="margin-bottom: 20px;">
          <div class="skeleton" style="height: 44px; border-radius: 10px;"></div>
        </div>
        <div class="skeleton" style="height: 48px; border-radius: 10px;"></div>
      </div>
    `
  };

  return skeletons[type] ? skeletons[type]() : skeletons.list();
}

/**
 * Escape HTML
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Expose globally
window.__emptyState = {
  get: getEmptyState,
  skeleton: getSkeleton
};