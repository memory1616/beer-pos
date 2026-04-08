/**
 * Beer POS - Frontend Utilities
 * Shared utilities for all frontend JavaScript
 */

const Utils = {
  /**
   * Format number as Vietnamese Dong currency
   */
  formatMoney: function(amount) {
    if (amount === null || amount === undefined || amount === '') return '0 đ';
    const num = Number(amount);
    if (isNaN(num)) return '0 đ';
    return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
  },

  /**
   * Format number with thousand separators
   */
  formatNumber: function(num) {
    if (num === null || num === undefined || num === '') {
      return '0';
    }
    const n = Number(num);
    if (isNaN(n)) {
      return '0';
    }
    return new Intl.NumberFormat('vi-VN').format(n);
  },

  /**
   * Parse string to number safely
   */
  parseNumber: function(value, defaultValue) {
    defaultValue = defaultValue || 0;
    if (value === null || value === undefined || value === '') {
      return defaultValue;
    }
    const num = Number(value);
    return isNaN(num) ? defaultValue : num;
  },

  /**
   * Validate number within range
   */
  validateNumber: function(value, min, max, defaultValue) {
    defaultValue = defaultValue !== undefined ? defaultValue : 0;
    min = min !== undefined ? min : 0;
    max = max !== undefined ? max : Infinity;
    
    if (value === null || value === undefined || value === '') {
      return defaultValue;
    }
    
    const num = Number(value);
    if (isNaN(num)) {
      return defaultValue;
    }
    
    return Math.max(min, Math.min(max, num));
  },

  /**
   * Get today's date string (YYYY-MM-DD)
   */
  getTodayString: function() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  },

  /**
   * Format date to Vietnamese format (DD/MM/YYYY)
   */
  formatDate: function(timestamp) {
    if (!timestamp) return '';
    const date = new Date(Number(timestamp));
    if (isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }).format(date);
  },

  /**
   * Format date with time
   */
  formatDateTime: function(timestamp) {
    if (!timestamp) return '';
    const date = new Date(Number(timestamp));
    if (isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  },

  /**
   * Generate unique ID
   */
  generateId: function() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  },

  /**
   * Show loading overlay
   */
  showLoading: function(message) {
    message = message || 'Dang xu ly...';
    let overlay = document.getElementById('loadingOverlay');
    if (!overlay) {
      if (!document.body) return;
      overlay = document.createElement('div');
      overlay.id = 'loadingOverlay';
      overlay.className = 'fixed inset-0 bg-overlay flex items-center justify-center z-50';
      overlay.innerHTML = '<div class="card p-6 flex flex-col items-center shadow-xl"><div class="spinner mb-4"></div><p class="text-main font-medium" id="loadingMessage">' + message + '</p></div>';
      document.body.appendChild(overlay);
    }
    const msgEl = document.getElementById('loadingMessage');
    if (msgEl) msgEl.textContent = message;
    overlay.classList.remove('hidden');
  },

  /**
   * Hide loading overlay
   */
  hideLoading: function() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
      overlay.classList.add('hidden');
    }
  },

  /**
   * Show toast notification
   */
  showToast: function(message, type) {
    type = type || 'success';
    const bgColor = type === 'success' ? 'bg-success' : (type === 'error' ? 'bg-danger' : 'bg-info');
    if (!document.body) return;
    const toast = document.createElement('div');
    toast.className = 'fixed top-4 right-4 ' + bgColor + ' text-main px-6 py-3 rounded-lg shadow-lg z-50 transform transition-all duration-300 translate-x-full';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(function() { toast.classList.remove('translate-x-full'); }, 100);
    setTimeout(function() {
      toast.classList.add('translate-x-full');
      setTimeout(function() { toast.remove(); }, 300);
    }, 3000);
  },

  /**
   * Calculate order total
   */
  calcOrderTotal: function(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return 0;
    }
    return items.reduce((sum, item) => {
      const quantity = Number(item.quantity) || 0;
      const price = Number(item.priceAtTime) || 0;
      return sum + (quantity * price);
    }, 0);
  },

  /**
   * Debounce function
   */
  debounce: function(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  /**
   * Check if value is empty (null, undefined, empty string, empty array, empty object)
   * @param {*} val
   * @returns {boolean}
   */
  isEmpty: function(val) {
    if (val === null || val === undefined) return true;
    if (typeof val === 'string') return val.trim() === '';
    if (Array.isArray(val)) return val.length === 0;
    if (typeof val === 'object') return Object.keys(val).length === 0;
    return false;
  }
};

// Backward compatibility — delegate to Format.money() (loaded via format.js)
// NOTE: format.js must be loaded BEFORE this file on pages that use formatVND
function formatVND(amount) {
  if (typeof Format !== 'undefined' && Format.money) {
    return Format.money(amount);
  }
  // Fallback if Format is not yet loaded
  if (amount === null || amount === undefined || amount === '') return '0 đ';
  const num = Number(amount);
  if (isNaN(num)) return '0 đ';
  return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
}

/** Global aliases — sales.js, sync.js, v.v. gọi showToast() trực tiếp (không qua Utils.) */
function showLoading(message) {
  return Utils.showLoading(message);
}
function hideLoading() {
  return Utils.hideLoading();
}
function showToast(message, type) {
  return Utils.isEmpty(message) ? null : Utils.showToast(message, type);
}

/** Global isEmpty helper */
function isEmpty(val) {
  return Utils.isEmpty(val);
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Utils, formatVND, showLoading, hideLoading, showToast };
}
