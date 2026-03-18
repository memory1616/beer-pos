/**
 * Beer POS - Format Utilities
 * Shared formatting functions for frontend
 */

const Format = {
  /**
   * Format number as Vietnamese Dong currency
   * @param {number|string|null|undefined} amount - Number to format
   * @returns {string} Formatted string (e.g., "1.000.000 ₫")
   */
  money: function(amount) {
    if (amount === null || amount === undefined || amount === '') {
      return '0 ₫';
    }
    
    const num = Number(amount);
    if (isNaN(num)) {
      return '0 ₫';
    }
    
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(num);
  },

  /**
   * Format number with thousand separators (no currency symbol)
   * @param {number|string|null|undefined} num - Number to format
   * @returns {string} Formatted string (e.g., "1.000.000")
   */
  number: function(num) {
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
   * @param {*} value - Value to parse
   * @param {number} [defaultValue=0] - Default value if parsing fails
   * @returns {number} Parsed number or default
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
   * Format date to Vietnamese format
   * @param {number|string|null|undefined} timestamp - Unix timestamp in milliseconds
   * @returns {string} Formatted date string (e.g., "18/03/2026")
   */
  date: function(timestamp) {
    if (!timestamp) {
      return '';
    }
    
    const date = new Date(Number(timestamp));
    if (isNaN(date.getTime())) {
      return '';
    }
    
    return new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }).format(date);
  },

  /**
   * Format date with time
   * @param {number|string|null|undefined} timestamp - Unix timestamp in milliseconds
   * @returns {string} Formatted date-time string (e.g., "18/03/2026 14:30")
   */
  dateTime: function(timestamp) {
    if (!timestamp) {
      return '';
    }
    
    const date = new Date(Number(timestamp));
    if (isNaN(date.getTime())) {
      return '';
    }
    
    return new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }
};

// Backward compatibility - create global formatVND function
function formatVND(amount) {
  return Format.money(amount);
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Format, formatVND };
}
