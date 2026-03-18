/**
 * Beer POS - Date Utilities
 * Date handling functions
 * @module date
 */

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
 * Get yesterday's date string
 * @returns {string} Date string
 */
function getYesterdayString() {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
exports.getYesterdayString = getYesterdayString;

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
 * Get end of current day timestamp
 * @returns {number} Timestamp in milliseconds
 */
function getDayEnd() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
}
exports.getDayEnd = getDayEnd;

/**
 * Get start of month for a given date
 * @param {Date|number} date - Date object or timestamp
 * @returns {number} Timestamp in milliseconds
 */
function getMonthStartFromDate(date) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}
exports.getMonthStartFromDate = getMonthStartFromDate;

/**
 * Get end of month for a given date
 * @param {Date|number} date - Date object or timestamp
 * @returns {number} Timestamp in milliseconds
 */
function getMonthEndFromDate(date) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
}
exports.getMonthEndFromDate = getMonthEndFromDate;

/**
 * Get current month string (YYYY-MM)
 * @returns {string} Month string
 */
function getCurrentMonthString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
exports.getCurrentMonthString = getCurrentMonthString;

/**
 * Parse date string to timestamp
 * @param {string} dateString - Date string (YYYY-MM-DD)
 * @returns {number} Timestamp in milliseconds
 */
function parseDateString(dateString) {
  if (!dateString) return 0;
  const parts = dateString.split('-');
  if (parts.length !== 3) return 0;
  
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  
  return new Date(year, month, day).getTime();
}
exports.parseDateString = parseDateString;

/**
 * Format timestamp to date string (YYYY-MM-DD)
 * @param {number} timestamp - Timestamp in milliseconds
 * @returns {string} Date string
 */
function formatToDateString(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
exports.formatToDateString = formatToDateString;

/**
 * Get days ago timestamp
 * @param {number} days - Number of days ago
 * @returns {number} Timestamp in milliseconds
 */
function getDaysAgo(days) {
  const now = new Date();
  now.setDate(now.getDate() - days);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
exports.getDaysAgo = getDaysAgo;

/**
 * Get last N days data range
 * @param {number} days - Number of days
 * @returns {Object} { start, end } timestamps
 */
function getLastNDays(days) {
  const end = getDayEnd();
  const start = getDaysAgo(days - 1);
  return { start, end };
}
exports.getLastNDays = getLastNDays;

/**
 * Check if two dates are the same day
 * @param {number} ts1 - First timestamp
 * @param {number} ts2 - Second timestamp
 * @returns {boolean} True if same day
 */
function isSameDay(ts1, ts2) {
  const d1 = new Date(ts1);
  const d2 = new Date(ts2);
  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate();
}
exports.isSameDay = isSameDay;

/**
 * Check if timestamp is today
 * @param {number} timestamp - Timestamp to check
 * @returns {boolean} True if today
 */
function isToday(timestamp) {
  return isSameDay(timestamp, Date.now());
}
exports.isToday = isToday;

/**
 * Get array of last N days
 * @param {number} n - Number of days
 * @returns {string[]} Array of date strings
 */
function getLastNDaysStrings(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return days;
}
exports.getLastNDaysStrings = getLastNDaysStrings;

/**
 * Get Vietnamese day of week
 * @param {number} timestamp - Timestamp
 * @returns {string} Day name
 */
function getDayOfWeek(timestamp) {
  const days = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
  const date = new Date(timestamp);
  return days[date.getDay()];
}
exports.getDayOfWeek = getDayOfWeek;
