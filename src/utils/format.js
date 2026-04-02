/**
 * Beer POS - Utility Functions
 * Formatting and helper utilities
 * @module format
 */

/**
 * Format number as Vietnamese Dong currency
 * @param {number|string|null|undefined} amount - Number to format
   * @returns {string} Formatted string (e.g., "1.000.000 đ")
 */
function formatMoney(amount) {
  if (amount === null || amount === undefined || amount === '') return '0 đ';
  const num = Number(amount);
  if (isNaN(num)) return '0 đ';
  return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
}
exports.formatMoney = formatMoney;

/**
 * Format number with thousand separators (no currency symbol)
 * @param {number|string|null|undefined} num - Number to format
 * @returns {string} Formatted string (e.g., "1.000.000")
 */
function formatNumber(num) {
  if (num === null || num === undefined || num === '') {
    return '0';
  }
  
  const n = Number(num);
  if (isNaN(n)) {
    return '0';
  }
  
  return new Intl.NumberFormat('vi-VN').format(n);
}
exports.formatNumber = formatNumber;

/**
 * Format date to Vietnamese format
 * @param {number|string|null|undefined} timestamp - Unix timestamp in milliseconds
 * @returns {string} Formatted date string (e.g., "18/03/2026")
 */
function formatDate(timestamp) {
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
}
exports.formatDate = formatDate;

/**
 * Format date with time
 * @param {number|string|null|undefined} timestamp - Unix timestamp in milliseconds
 * @returns {string} Formatted date-time string (e.g., "18/03/2026 14:30")
 */
function formatDateTime(timestamp) {
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
exports.formatDateTime = formatDateTime;

/**
 * Format time only
 * @param {number|string|null|undefined} timestamp - Unix timestamp in milliseconds
 * @returns {string} Formatted time string (e.g., "14:30")
 */
function formatTime(timestamp) {
  if (!timestamp) {
    return '';
  }
  
  const date = new Date(Number(timestamp));
  if (isNaN(date.getTime())) {
    return '';
  }
  
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}
exports.formatTime = formatTime;

/**
 * Get today's date string in YYYY-MM-DD format
 * @returns {string} Date string
 */
function getTodayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
exports.getTodayString = getTodayString;

/**
 * Get start of current month timestamp
 * @returns {number} Timestamp in milliseconds
 */
function getMonthStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}
exports.getMonthStart = getMonthStart;

/**
 * Get start of current day timestamp
 * @returns {number} Timestamp in milliseconds
 */
function getDayStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
exports.getDayStart = getDayStart;

/**
 * Generate unique ID
 * @returns {string} Unique ID string
 */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}
exports.generateId = generateId;

/**
 * Parse string to number safely
 * @param {*} value - Value to parse
 * @param {number} [defaultValue=0] - Default value if parsing fails
 * @returns {number} Parsed number or default
 */
function parseNumber(value, defaultValue) {
  defaultValue = defaultValue || 0;
  if (value === null || value === undefined || value === '') {
    return defaultValue;
  }
  const num = Number(value);
  return isNaN(num) ? defaultValue : num;
}
exports.parseNumber = parseNumber;

/**
 * Truncate text with ellipsis
 * @param {string} text - Text to truncate
 * @param {number} [maxLength=50] - Maximum length
 * @returns {string} Truncated text
 */
function truncateText(text, maxLength) {
  maxLength = maxLength || 50;
  if (!text || text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + '...';
}
exports.truncateText = truncateText;
