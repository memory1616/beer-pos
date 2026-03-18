/**
 * Beer POS - Type Definitions
 * Centralized type definitions for all core models
 * @typedef {Object} Product
 * @property {string} id
 * @property {string} name
 * @property {number} price
 * @property {string} [category]
 * @property {number} [stock]
 * @property {string} [unit]
 */

/**
 * @typedef {Object} OrderItem
 * @property {string} productId
 * @property {string} name
 * @property {number} priceAtTime
 * @property {number} quantity
 */

/**
 * @typedef {Object} Order
 * @property {string} id
 * @property {string} [customerId]
 * @property {string} [customerName]
 * @property {OrderItem[]} items
 * @property {number} total
 * @property {number} createdAt
 * @property {'cash'|'transfer'} [paymentMethod]
 * @property {string} [note]
 */

/**
 * @typedef {Object} Expense
 * @property {string} id
 * @property {'fuel'|'food'|'repair'|'other'} type
 * @property {number} amount
 * @property {string} [note]
 * @property {number} createdAt
 * @property {string} [date]
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} date
 * @property {Order[]} orders
 * @property {Expense[]} expenses
 * @property {number} [totalRevenue]
 * @property {number} [totalExpense]
 * @property {number} [profit]
 */

/**
 * @typedef {'fuel'|'food'|'repair'|'other'} ExpenseType
 */

/**
 * @typedef {'cash'|'transfer'} PaymentMethod
 */

/**
 * @typedef {'pending'|'completed'|'cancelled'} OrderStatus
 */

/**
 * @typedef {Object} DayStats
 * @property {number} revenue
 * @property {number} units
 * @property {number} profit
 * @property {number} orderCount
 */

/**
 * @typedef {Object} MonthStats
 * @property {number} revenue
 * @property {number} units
 * @property {number} profit
 * @property {number} orderCount
 */

/**
 * @typedef {Object} KegStats
 * @property {number} inStock
 * @property {number} atCustomers
 * @property {number} total
 */

/**
 * @typedef {Object} ExpensesByType
 * @property {number} fuel
 * @property {number} food
 * @property {number} repair
 * @property {number} other
 * @property {number} total
 */

/**
 * @typedef {Object} DashboardData
 * @property {DayStats} todayStats
 * @property {MonthStats} monthStats
 * @property {{units: number}} todayUnits
 * @property {KegStats} kegStats
 * @property {{today: number, month: number, todayByType?: ExpensesByType}} [expenses]
 * @property {Product[]} [lowStockProducts]
 * @property {Order[]} [recentSales]
 */

/**
 * @typedef {Object} Customer
 * @property {string} id
 * @property {string} name
 * @property {string} [phone]
 * @property {string} [address]
 * @property {number} [deposit]
 * @property {{lying?: number, standing?: number}} [fridge]
 * @property {Object.<string, number>} [prices]
 * @property {string} [lastOrderDate]
 * @property {number} createdAt
 */

/**
 * @typedef {Object} Device
 * @property {string} id
 * @property {string} customerId
 * @property {'lying'|'standing'} type
 * @property {string} [name]
 * @property {number} createdAt
 */

/**
 * @typedef {Object} Delivery
 * @property {string} id
 * @property {string} customerId
 * @property {string} customerName
 * @property {OrderItem[]}
 * @property {'pending'|'completed'|'cancelled'} status
 * @property {number} createdAt
 * @property {number} [completedAt]
 */

/**
 * @typedef {Object} Purchase
 * @property {string} id
 * @property {string} [supplier]
 * @property {Array<{productId: string, name: string, quantity: number, price: number}>} items
 * @property {number} total
 * @property {number} createdAt
 */

module.exports = {};
