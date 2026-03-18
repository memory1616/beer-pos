/**
 * Beer POS - Utility Functions
 * Formatting and helper utilities
 */

/**
 * Format number as Vietnamese Dong currency
 * @param amount - Number to format
 * @returns Formatted string (e.g., "1.000.000 ₫")
 */
export function formatMoney(amount: number | string | null | undefined): string {
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
}

/**
 * Format number with thousand separators (no currency symbol)
 * @param num - Number to format
 * @returns Formatted string (e.g., "1.000.000")
 */
export function formatNumber(num: number | string | null | undefined): string {
  if (num === null || num === undefined || num === '') {
    return '0';
  }
  
  const n = Number(num);
  if (isNaN(n)) {
    return '0';
  }
  
  return new Intl.NumberFormat('vi-VN').format(n);
}

/**
 * Format date to Vietnamese format
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted date string (e.g., "18/03/2026")
 */
export function formatDate(timestamp: number | string | null | undefined): string {
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

/**
 * Format date with time
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted date-time string (e.g., "18/03/2026 14:30")
 */
export function formatDateTime(timestamp: number | string | null | undefined): string {
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

/**
 * Format time only
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted time string (e.g., "14:30")
 */
export function formatTime(timestamp: number | string | null | undefined): string {
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

/**
 * Get today's date string in YYYY-MM-DD format
 * @returns Date string
 */
export function getTodayString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Get start of current month timestamp
 * @returns Timestamp in milliseconds
 */
export function getMonthStart(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

/**
 * Get start of current day timestamp
 * @returns Timestamp in milliseconds
 */
export function getDayStart(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * Generate unique ID
 * @returns Unique ID string
 */
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * Parse string to number safely
 * @param value - Value to parse
 * @param defaultValue - Default value if parsing fails
 * @returns Parsed number or default
 */
export function parseNumber(value: unknown, defaultValue: number = 0): number {
  if (value === null || value === undefined || value === '') {
    return defaultValue;
  }
  const num = Number(value);
  return isNaN(num) ? defaultValue : num;
}

/**
 * Truncate text with ellipsis
 * @param text - Text to truncate
 * @param maxLength - Maximum length
 * @returns Truncated text
 */
export function truncateText(text: string, maxLength: number = 50): string {
  if (!text || text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + '...';
}
