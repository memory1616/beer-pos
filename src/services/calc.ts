/**
 * Beer POS - Business Logic Services
 * Centralized calculation functions
 */

import { Order, OrderItem, Expense, DayStats, MonthStats, ExpensesByType } from '../types/models';

/**
 * Calculate total for a single order
 * @param items - Array of order items
 * @returns Total amount
 */
export function calcOrderTotal(items: OrderItem[]): number {
  if (!Array.isArray(items) || items.length === 0) {
    return 0;
  }
  return items.reduce((sum, item) => {
    const quantity = Number(item.quantity) || 0;
    const price = Number(item.priceAtTime) || 0;
    return sum + (quantity * price);
  }, 0);
}

/**
 * Calculate total revenue from orders
 * @param orders - Array of orders
 * @returns Total revenue
 */
export function calcTotalRevenue(orders: Order[]): number {
  if (!Array.isArray(orders) || orders.length === 0) {
    return 0;
  }
  return orders.reduce((sum, order) => {
    return sum + (Number(order.total) || 0);
  }, 0);
}

/**
 * Calculate total units sold from orders
 * @param orders - Array of orders
 * @returns Total units
 */
export function calcTotalUnits(orders: Order[]): number {
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

/**
 * Calculate total expense
 * @param expenses - Array of expenses
 * @returns Total expense amount
 */
export function calcTotalExpense(expenses: Expense[]): number {
  if (!Array.isArray(expenses) || expenses.length === 0) {
    return 0;
  }
  return expenses.reduce((sum, expense) => {
    return sum + (Number(expense.amount) || 0);
  }, 0);
}

/**
 * Calculate profit
 * @param revenue - Total revenue
 * @param expense - Total expense
 * @returns Profit (revenue - expense)
 */
export function calcProfit(revenue: number, expense: number): number {
  const r = Number(revenue) || 0;
  const e = Number(expense) || 0;
  return r - e;
}

/**
 * Calculate expenses grouped by type
 * @param expenses - Array of expenses
 * @returns Object with totals by type
 */
export function calcExpensesByType(expenses: Expense[]): ExpensesByType {
  const result: ExpensesByType = {
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
    
    if (type in result) {
      result[type as keyof Omit<ExpensesByType, 'total'>] += amount;
    }
    result.total += amount;
  }

  return result;
}

/**
 * Calculate daily stats
 * @param orders - Array of orders for the day
 * @param expenses - Array of expenses for the day
 * @returns DayStats object
 */
export function calcDayStats(orders: Order[], expenses: Expense[]): DayStats {
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

/**
 * Calculate monthly stats
 * @param orders - Array of orders for the month
 * @param expenses - Array of expenses for the month
 * @returns MonthStats object
 */
export function calcMonthStats(orders: Order[], expenses: Expense[]): MonthStats {
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

/**
 * Validate and sanitize a number, returning 0 for invalid values
 * @param value - Value to validate
 * @returns Sanitized number or 0
 */
export function sanitizeNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const num = Number(value);
  return isNaN(num) || num < 0 ? 0 : num;
}

/**
 * Validate order item
 * @param item - Order item to validate
 * @returns Validated order item
 */
export function validateOrderItem(item: Partial<OrderItem>): OrderItem {
  return {
    productId: String(item.productId || ''),
    name: String(item.name || ''),
    priceAtTime: sanitizeNumber(item.priceAtTime),
    quantity: sanitizeNumber(item.quantity)
  };
}

/**
 * Validate expense
 * @param expense - Expense to validate
 * @returns Validated expense
 */
export function validateExpense(expense: Partial<Expense>): Expense {
  const validTypes = ['fuel', 'food', 'repair', 'other'];
  const type = validTypes.includes(expense.type || '') ? expense.type as Expense['type'] : 'other';
  
  return {
    id: String(expense.id || ''),
    type,
    amount: sanitizeNumber(expense.amount),
    note: String(expense.note || ''),
    createdAt: sanitizeNumber(expense.createdAt),
    date: String(expense.date || '')
  };
}
