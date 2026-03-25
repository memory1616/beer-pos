/**
 * Beer POS - WebSocket Service
 * Feature #14: Real-time dashboard update qua WebSocket
 *
 * Cung cấp real-time events cho:
 * - Dashboard stats update
 * - Keg state change
 * - Inventory alerts
 * - New orders notification
 * - Sync status
 */

let io = null;

/**
 * Khởi tạo WebSocket server
 * @param {Object} httpServer - HTTP server instance
 */
function initWebSocket(httpServer) {
  const { Server } = require('socket.io');

  io = new Server(httpServer, {
    cors: {
      origin: '*', // Cho phép tất cả origins trong development
      methods: ['GET', 'POST']
    },
    pingTimeout: 60000,
    pingInterval: 25000
  });

  // Connection handler
  io.on('connection', (socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    // Send initial state on connect
    sendDashboardStats(socket);
    sendKegState(socket);

    // Join rooms
    socket.on('join', (room) => {
      socket.join(room);
      console.log(`[WS] ${socket.id} joined room: ${room}`);
    });

    socket.on('leave', (room) => {
      socket.leave(room);
      console.log(`[WS] ${socket.id} left room: ${room}`);
    });

    // Request current stats
    socket.on('get:dashboard', () => {
      sendDashboardStats(socket);
    });

    socket.on('get:keg', () => {
      sendKegState(socket);
    });

    socket.on('get:inventory', () => {
      sendInventoryStats(socket);
    });

    socket.on('disconnect', () => {
      console.log(`[WS] Client disconnected: ${socket.id}`);
    });
  });

  console.log('[WS] WebSocket server initialized');
  return io;
}

/**
 * Lấy io instance (để sử dụng trong routes)
 */
function getIO() {
  return io;
}

/**
 * Broadcast event tới tất cả clients
 * @param {string} event - Event name
 * @param {any} data - Data to send
 */
function broadcast(event, data) {
  if (io) {
    io.emit(event, {
      ...data,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Broadcast tới một room cụ thể
 * @param {string} room - Room name
 * @param {string} event - Event name
 * @param {any} data - Data to send
 */
function broadcastToRoom(room, event, data) {
  if (io) {
    io.to(room).emit(event, {
      ...data,
      timestamp: new Date().toISOString()
    });
  }
}

// ==================== Specific Broadcast Functions ====================

/**
 * Gửi dashboard stats tới một socket
 */
function sendDashboardStats(socket) {
  try {
    const db = require('../../database');

    const today = new Date().toISOString().split('T')[0];
    const monthStart = today.substring(0, 7) + '-01';

    // Today's sales
    const todaySales = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total, COALESCE(SUM(profit), 0) as profit
      FROM sales
      WHERE date >= ? AND status = 'completed'
    `).get(today);

    // Month sales
    const monthSales = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total, COALESCE(SUM(profit), 0) as profit
      FROM sales
      WHERE date >= ? AND status = 'completed'
    `).get(monthStart);

    // Today's expenses
    const todayExpenses = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM expenses
      WHERE date = ?
    `).get(today);

    // Active customers
    const activeCustomers = db.prepare(`
      SELECT COUNT(*) as count
      FROM customers
      WHERE archived = 0
    `).get();

    // Low stock products
    const lowStock = db.prepare(`
      SELECT COUNT(*) as count
      FROM products
      WHERE stock <= 5 AND stock > 0
    `).get();

    // Out of stock
    const outOfStock = db.prepare(`
      SELECT COUNT(*) as count
      FROM products
      WHERE stock <= 0
    `).get();

    const stats = {
      today: {
        orders: todaySales.count,
        revenue: todaySales.total,
        profit: todaySales.profit,
        expenses: todayExpenses.total,
        net: todaySales.total - todayExpenses.total
      },
      month: {
        orders: monthSales.count,
        revenue: monthSales.total,
        profit: monthSales.profit
      },
      alerts: {
        lowStock: lowStock.count,
        outOfStock: outOfStock.count,
        activeCustomers: activeCustomers.count
      }
    };

    if (socket) {
      socket.emit('dashboard:stats', stats);
    } else {
      broadcast('dashboard:stats', stats);
    }

    return stats;
  } catch (e) {
    console.error('[WS] sendDashboardStats error:', e.message);
    return null;
  }
}

/**
 * Gửi keg state tới một socket hoặc broadcast
 */
function sendKegState(socket) {
  try {
    const { getKegStats } = require('../modules/keg');
    const state = getKegStats();

    if (socket) {
      socket.emit('keg:state', state);
    } else {
      broadcast('keg:state', state);
    }

    return state;
  } catch (e) {
    console.error('[WS] sendKegState error:', e.message);
    return null;
  }
}

/**
 * Gửi inventory stats tới một socket hoặc broadcast
 */
function sendInventoryStats(socket) {
  try {
    const { getInventoryStats } = require('../modules/inventory');
    const stats = getInventoryStats();

    if (socket) {
      socket.emit('inventory:stats', stats);
    } else {
      broadcast('inventory:stats', stats);
    }

    return stats;
  } catch (e) {
    console.error('[WS] sendInventoryStats error:', e.message);
    return null;
  }
}

/**
 * Thông báo có đơn hàng mới
 * @param {Object} sale - Sale data
 */
function notifyNewSale(sale) {
  broadcast('sale:created', {
    type: 'new_order',
    sale
  });
}

/**
 * Thông báo keg state thay đổi
 * @param {Object} state - New keg state
 */
function notifyKegChange(state) {
  broadcast('keg:updated', {
    type: 'keg_change',
    state
  });
}

/**
 * Thông báo inventory thay đổi
 * @param {Object} data - { productId, oldStock, newStock }
 */
function notifyInventoryChange(data) {
  broadcast('inventory:updated', {
    type: 'inventory_change',
    ...data
  });
}

/**
 * Thông báo alert (low stock, out of stock)
 * @param {string} type - Alert type
 * @param {string} message - Alert message
 * @param {Object} data - Additional data
 */
function notifyAlert(type, message, data = {}) {
  broadcast('alert', {
    type,
    message,
    ...data
  });
}

/**
 * Thông báo sync status
 * @param {Object} status - Sync status data
 */
function notifySyncStatus(status) {
  broadcast('sync:status', status);
}

module.exports = {
  initWebSocket,
  getIO,
  broadcast,
  broadcastToRoom,
  sendDashboardStats,
  sendKegState,
  sendInventoryStats,
  notifyNewSale,
  notifyKegChange,
  notifyInventoryChange,
  notifyAlert,
  notifySyncStatus
};
