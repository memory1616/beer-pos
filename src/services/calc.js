/**
 * Beer POS - Business Logic Services
 * Centralized calculation functions
 * @module calc
 */

/**
 * Calculate total for a single order
 * @param {OrderItem[]} items - Array of order items
 * @returns {number} Total amount
 */
function calcOrderTotal(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return 0;
  }
  return items.reduce((sum, item) => {
    const quantity = Number(item.quantity) || 0;
    const price = Number(item.priceAtTime) || 0;
    return sum + (quantity * price);
  }, 0);
}
exports.calcOrderTotal = calcOrderTotal;

/**
 * Calculate total revenue from orders
 * @param {Order[]} orders - Array of orders
 * @returns {number} Total revenue
 */
function calcTotalRevenue(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    return 0;
  }
  return orders.reduce((sum, order) => {
    return sum + (Number(order.total) || 0);
  }, 0);
}
exports.calcTotalRevenue = calcTotalRevenue;

/**
 * Calculate total units sold from orders
 * @param {Order[]} orders - Array of orders
 * @returns {number} Total units
 */
function calcTotalUnits(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    return 0;
  }
  return orders.reduce((sum, order) => {
    if (!Array.isArray(order.items)) return sum;
    return sum + order.items.reduce((itemSum, item) => {
      return itemSum + (Number(item.quantity) || 0);
    }, 0);
  }, 0);
}
exports.calcTotalUnits = calcTotalUnits;

/**
 * Calculate total expense
 * @param {Expense[]} expenses - Array of expenses
 * @returns {number} Total expense amount
 */
function calcTotalExpense(expenses) {
  if (!Array.isArray(expenses) || expenses.length === 0) {
    return 0;
  }
  return expenses.reduce((sum, expense) => {
    return sum + (Number(expense.amount) || 0);
  }, 0);
}
exports.calcTotalExpense = calcTotalExpense;

/**
 * Calculate profit
 * @param {number} revenue - Total revenue
 * @param {number} expense - Total expense
 * @returns {number} Profit (revenue - expense)
 */
function calcProfit(revenue, expense) {
  const r = Number(revenue) || 0;
  const e = Number(expense) || 0;
  return r - e;
}
exports.calcProfit = calcProfit;

/**
 * Calculate expenses grouped by type
 * @param {Expense[]} expenses - Array of expenses
 * @returns {Object} Object with totals by type
 */
function calcExpensesByType(expenses) {
  const result = {
    fuel: 0,
    food: 0,
    repair: 0,
    other: 0,
    total: 0
  };

  if (!Array.isArray(expenses) || expenses.length === 0) {
    return result;
  }

  for (const expense of expenses) {
    const amount = Number(expense.amount) || 0;
    const type = expense.type || 'other';
    
    if (type === 'fuel') result.fuel += amount;
    else if (type === 'food') result.food += amount;
    else if (type === 'repair') result.repair += amount;
    else result.other += amount;
    
    result.total += amount;
  }

  return result;
}
exports.calcExpensesByType = calcExpensesByType;

/**
 * Calculate daily stats
 * @param {Order[]} orders - Array of orders for the day
 * @param {Expense[]} expenses - Array of expenses for the day
 * @returns {Object} DayStats object
 */
function calcDayStats(orders, expenses) {
  const revenue = calcTotalRevenue(orders);
  const units = calcTotalUnits(orders);
  const expense = calcTotalExpense(expenses);
  const profit = calcProfit(revenue, expense);

  return {
    revenue,
    units,
    profit,
    orderCount: Array.isArray(orders) ? orders.length : 0
  };
}
exports.calcDayStats = calcDayStats;

/**
 * Calculate monthly stats
 * @param {Order[]} orders - Array of orders for the month
 * @param {Expense[]} expenses - Array of expenses for the month
 * @returns {Object} MonthStats object
 */
function calcMonthStats(orders, expenses) {
  const revenue = calcTotalRevenue(orders);
  const units = calcTotalUnits(orders);
  const expense = calcTotalExpense(expenses);
  const profit = calcProfit(revenue, expense);

  return {
    revenue,
    units,
    profit,
    orderCount: Array.isArray(orders) ? orders.length : 0
  };
}
exports.calcMonthStats = calcMonthStats;

/**
 * Validate and sanitize a number
 * @param {*} value - Value to validate
 * @returns {number} Sanitized number or 0
 */
function sanitizeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const num = Number(value);
  return isNaN(num) || num < 0 ? 0 : num;
}
exports.sanitizeNumber = sanitizeNumber;

/**
 * Validate order item
 * @param {Object} item - Order item to validate
 * @returns {Object} Validated order item
 */
function validateOrderItem(item) {
  return {
    productId: String(item.productId || ''),
    name: String(item.name || ''),
    priceAtTime: sanitizeNumber(item.priceAtTime),
    quantity: sanitizeNumber(item.quantity)
  };
}
exports.validateOrderItem = validateOrderItem;

/**
 * Validate expense
 * @param {Object} expense - Expense to validate
 * @returns {Object} Validated expense
 */
function validateExpense(expense) {
  const validTypes = ['fuel', 'food', 'repair', 'other'];
  const type = validTypes.includes(expense.type || '') ? expense.type : 'other';
  
  return {
    id: String(expense.id || ''),
    type,
    amount: sanitizeNumber(expense.amount),
    note: String(expense.note || ''),
    createdAt: sanitizeNumber(expense.createdAt),
    date: String(expense.date || '')
  };
}
exports.validateExpense = validateExpense;
