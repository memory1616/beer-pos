/**
 * Beer POS - Session Service
 * Manages daily sessions grouping orders and expenses together
 * @module services/session
 */

const db = require('../../database');
const logger = require('../utils/logger');

const STORAGE_KEY = 'beer_pos_current_session';

/**
 * Get today's date string (YYYY-MM-DD)
 */
function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Generate unique session ID
 */
function generateSessionId() {
  return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

/**
 * Create a new session for today
 */
function createTodaySession() {
  const today = getTodayDate();
  
  // Check if session already exists
  const existing = getSessionByDate(today);
  if (existing) {
    return existing;
  }
  
  const session = {
    id: generateSessionId(),
    date: today,
    orders: [],
    expenses: [],
    totalRevenue: 0,
    totalExpense: 0,
    profit: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  
  // Save to database for persistence
  saveSessionToDb(session);
  
  return session;
}

/**
 * Get session by date
 */
function getSessionByDate(date) {
  try {
    const row = db.prepare('SELECT * FROM sessions WHERE date = ?').get(date);
    if (!row) return null;
    
    return {
      id: row.id,
      date: row.date,
      orders: row.orders ? JSON.parse(row.orders) : [],
      expenses: row.expenses ? JSON.parse(row.expenses) : [],
      totalRevenue: row.total_revenue || 0,
      totalExpense: row.total_expense || 0,
      profit: row.profit || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  } catch (e) {
    logger.error('Error getting session by date', { error: e.message });
    return null;
  }
}

/**
 * Get or create today's session
 */
function getTodaySession() {
  const today = getTodayDate();
  let session = getSessionByDate(today);
  
  if (!session) {
    session = createTodaySession();
  } else {
    // Refresh orders and expenses from database
    session = refreshSessionData(session);
  }
  
  return session;
}

/**
 * Refresh session data from database
 */
function refreshSessionData(session) {
  try {
    // Get today's orders
    const orders = db.prepare(`
      SELECT s.*, GROUP_CONCAT(si.product_id || ':' || si.quantity || ':' || si.price) as items_data
      FROM sales s
      LEFT JOIN sale_items si ON s.id = si.sale_id
      WHERE s.date LIKE ?
      GROUP BY s.id
    `).all(session.date + '%');
    
    // Get today's expenses
    const expenses = db.prepare(`
      SELECT * FROM expenses WHERE date = ?
    `).all(session.date);
    
    // Calculate totals
    let totalRevenue = 0;
    let totalExpense = 0;
    
    orders.forEach(order => {
      totalRevenue += (order.total || 0);
    });
    
    expenses.forEach(expense => {
      totalExpense += (expense.amount || 0);
    });
    
    return {
      ...session,
      orders: orders,
      expenses: expenses,
      totalRevenue: totalRevenue,
      totalExpense: totalExpense,
      profit: totalRevenue - totalExpense,
      updatedAt: Date.now()
    };
  } catch (e) {
    logger.error('Error refreshing session data', { error: e.message });
    return session;
  }
}

/**
 * Save session to database
 */
function saveSessionToDb(session) {
  try {
    db.prepare(`
      INSERT INTO sessions (id, date, orders, expenses, total_revenue, total_expense, profit, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        orders = excluded.orders,
        expenses = excluded.expenses,
        total_revenue = excluded.total_revenue,
        total_expense = excluded.total_expense,
        profit = excluded.profit,
        updated_at = excluded.updated_at
    `).run(
      session.id,
      session.date,
      JSON.stringify(session.orders),
      JSON.stringify(session.expenses),
      session.totalRevenue,
      session.totalExpense,
      session.profit,
      session.createdAt,
      session.updatedAt
    );
    return true;
  } catch (e) {
    logger.error('Error saving session to db', { error: e.message });
    return false;
  }
}

/**
 * Add order to session
 */
function addOrderToSession(orderId, orderData) {
  const session = getTodaySession();
  
  // Add to orders array
  const orderEntry = {
    id: orderId,
    data: orderData,
    addedAt: Date.now()
  };
  
  session.orders.push(orderEntry);
  session.totalRevenue += (orderData.total || 0);
  session.profit = session.totalRevenue - session.totalExpense;
  session.updatedAt = Date.now();
  
  saveSessionToDb(session);
  return session;
}

/**
 * Add expense to session
 */
function addExpenseToSession(expenseId, expenseData) {
  const session = getTodaySession();
  
  // Add to expenses array
  const expenseEntry = {
    id: expenseId,
    data: expenseData,
    addedAt: Date.now()
  };
  
  session.expenses.push(expenseEntry);
  session.totalExpense += (expenseData.amount || 0);
  session.profit = session.totalRevenue - session.totalExpense;
  session.updatedAt = Date.now();
  
  saveSessionToDb(session);
  return session;
}

/**
 * Get session statistics
 */
function getSessionStats(date = null) {
  const targetDate = date || getTodayDate();
  const session = getSessionByDate(targetDate);
  
  if (!session) {
    return {
      date: targetDate,
      revenue: 0,
      expense: 0,
      profit: 0,
      orderCount: 0,
      expenseCount: 0
    };
  }
  
  return {
    date: targetDate,
    revenue: session.totalRevenue,
    expense: session.totalExpense,
    profit: session.profit,
    orderCount: session.orders.length,
    expenseCount: session.expenses.length
  };
}

/**
 * Migrate old data to session format (if needed)
 */
function migrateToSessionFormat() {
  // Check if sessions table exists, if not create it
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        date TEXT UNIQUE NOT NULL,
        orders TEXT,
        expenses TEXT,
        total_revenue REAL DEFAULT 0,
        total_expense REAL DEFAULT 0,
        profit REAL DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER
      )
    `);
    
    // Create index
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date)`);
    
    logger.info('Sessions table ready');
    return true;
  } catch (e) {
    logger.error('Error creating sessions table', { error: e.message });
    return false;
  }
}

/**
 * Check if old localStorage data exists and needs migration
 */
function checkOldDataMigration() {
  try {
    const hasOldOrders = localStorage.getItem('beer_pos_orders') !== null;
    const hasOldExpenses = localStorage.getItem('beer_pos_expenses') !== null;
    
    if (hasOldOrders || hasOldExpenses) {
      logger.info('Old localStorage data found - migration available');
      return {
        needsMigration: true,
        hasOldOrders,
        hasOldExpenses
      };
    }
    
    return { needsMigration: false };
  } catch (e) {
    return { needsMigration: false, error: e.message };
  }
}

/**
 * Migrate old localStorage data to new session format
 */
function migrateOldData() {
  try {
    const oldOrders = JSON.parse(localStorage.getItem('beer_pos_orders') || '[]');
    const oldExpenses = JSON.parse(localStorage.getItem('beer_pos_expenses') || '[]');
    
    if (oldOrders.length === 0 && oldExpenses.length === 0) {
      return { success: true, migrated: 0 };
    }
    
    // Group by date
    const dataByDate = {};
    
    oldOrders.forEach(order => {
      const date = order.date || getTodayDate();
      if (!dataByDate[date]) {
        dataByDate[date] = { orders: [], expenses: [] };
      }
      dataByDate[date].orders.push(order);
    });
    
    oldExpenses.forEach(expense => {
      const date = expense.date || getTodayDate();
      if (!dataByDate[date]) {
        dataByDate[date] = { orders: [], expenses: [] };
      }
      dataByDate[date].expenses.push(expense);
    });
    
    // Create sessions for each date
    let migrated = 0;
    Object.keys(dataByDate).forEach(date => {
      let session = getSessionByDate(date);
      if (!session) {
        session = {
          id: generateSessionId(),
          date: date,
          orders: [],
          expenses: [],
          totalRevenue: 0,
          totalExpense: 0,
          profit: 0,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
      }
      
      // Merge old data
      dataByDate[date].orders.forEach(order => {
        if (!session.orders.find(o => o.id === order.id)) {
          session.orders.push(order);
          session.totalRevenue += (order.total || 0);
        }
      });
      
      dataByDate[date].expenses.forEach(expense => {
        if (!session.expenses.find(e => e.id === expense.id)) {
          session.expenses.push(expense);
          session.totalExpense += (expense.amount || 0);
        }
      });
      
      session.profit = session.totalRevenue - session.totalExpense;
      session.updatedAt = Date.now();
      
      saveSessionToDb(session);
      migrated++;
    });
    
    // Clear old localStorage data
    localStorage.removeItem('beer_pos_orders');
    localStorage.removeItem('beer_pos_expenses');
    
    logger.info(`Migrated ${migrated} sessions from old data`);
    return { success: true, migrated };
  } catch (e) {
    logger.error('Error migrating old data', { error: e.message });
    return { success: false, error: e.message };
  }
}

module.exports = {
  getTodayDate,
  generateSessionId,
  createTodaySession,
  getSessionByDate,
  getTodaySession,
  refreshSessionData,
  addOrderToSession,
  addExpenseToSession,
  getSessionStats,
  migrateToSessionFormat,
  checkOldDataMigration,
  migrateOldData
};
