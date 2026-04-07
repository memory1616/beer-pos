// BeerPOS Real-time WebSocket Server
// Socket.IO integration for multi-device sync

const { Server } = require('socket.io');
const logger = require('../utils/logger');

// ─── Event Definitions ────────────────────────────────────────────────────────

const EVENTS = {
  // Order/Sale events
  ORDER_CREATED:   'order:created',
  ORDER_UPDATED:   'order:updated',
  ORDER_DELETED:   'order:deleted',

  // Inventory events
  INVENTORY_UPDATED: 'inventory:updated',

  // Keg/shell events
  KEG_UPDATED:     'keg:updated',

  // Customer events
  CUSTOMER_UPDATED: 'customer:updated',

  // Expense events
  EXPENSE_CREATED: 'expense:created',
  EXPENSE_UPDATED: 'expense:updated',
  EXPENSE_DELETED: 'expense:deleted',

  // Report events
  REPORT_UPDATED:  'report:updated',

  // System events
  CONNECTED:       'connected',
  PING:             'ping',
  REFETCH_NOW:     'refetch:now',
};

// ─── Room definitions ──────────────────────────────────────────────────────────

const ROOMS = {
  ADMIN:   'admin',    // Admin panel clients
  PUBLIC:  'public',   // Public-facing clients
  ALL:     'all',      // All connected clients
};

// ─── Socket Server Class ──────────────────────────────────────────────────────

let io = null;

function init(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    // Serve static socket.io client from /socket.io/
    serveClient: true,
    // Ping timeout: 20s, interval: 25s
    pingTimeout: 20000,
    pingInterval: 25000,
    // Transports: prefer websocket, fall back to polling
    transports: ['websocket', 'polling'],
  });

  // ── Middleware: authenticate on connection ──────────────────────────────────
  io.use((socket, next) => {
    // Allow all connections in dev mode; in production check auth token
    const isDev = process.env.NODE_ENV !== 'production';
    if (isDev) return next();

    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    // Validate token against sessions DB
    try {
      const db = require('../../database');
      const session = db.prepare(
        "SELECT * FROM auth_sessions WHERE token = ? AND expires_at > datetime('now')"
      ).get(token);
      if (!session) return next(new Error('Invalid or expired token'));
      socket.session = session;
    } catch (err) {
      logger.warn('Socket auth DB error', { error: err.message });
      return next(new Error('Auth server error'));
    }
    next();
  });

  // ── Connection handler ─────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const ip = socket.handshake.address;
    const id = socket.id;
    const mode = socket.handshake.query?.mode || 'admin';

    logger.info(`[WS] Client connected: ${id} from ${ip}, mode=${mode}`);

    // Join room based on app mode
    const room = mode === 'public' ? ROOMS.PUBLIC : ROOMS.ADMIN;
    socket.join(room);
    socket.join(ROOMS.ALL);

    // Emit connected confirmation
    socket.emit(EVENTS.CONNECTED, {
      socketId: id,
      rooms: [room, ROOMS.ALL],
      serverTime: new Date().toISOString(),
    });

    // ── Ping handler ────────────────────────────────────────────────────────
    socket.on(EVENTS.PING, (cb) => {
      if (typeof cb === 'function') cb({ pong: true, serverTime: Date.now() });
      else socket.emit(EVENTS.PING, { pong: true, serverTime: Date.now() });
    });

    // ── Manual refetch request ──────────────────────────────────────────────
    socket.on('request:refetch', (data, cb) => {
      const { entities } = data || {};
      socket.broadcast.emit(EVENTS.REFETCH_NOW, {
        entities: entities || ['all'],
        from: id,
        serverTime: Date.now(),
      });
      if (typeof cb === 'function') cb({ acknowledged: true });
    });

    // ── Disconnect handler ────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      logger.info(`[WS] Client disconnected: ${id}, reason=${reason}`);
    });

    // ── Error handler ─────────────────────────────────────────────────────
    socket.on('error', (err) => {
      logger.error('[WS] Socket error', { socketId: id, error: err.message });
    });
  });

  // ── Global error handler ────────────────────────────────────────────────────
  io.on('connection_error', (err) => {
    logger.warn('[WS] Connection error', { error: err.message, code: err.code });
  });

  logger.info('[WS] Socket.IO server initialized');
  return io;
}

// ─── Emit helper functions ────────────────────────────────────────────────────

/**
 * Emit to all admin clients
 */
function emitToAdmin(event, data) {
  if (!io) return;
  io.to(ROOMS.ADMIN).emit(event, {
    ...data,
    _ts: Date.now(),
    _src: 'server',
  });
}

/**
 * Emit to all public clients
 */
function emitToPublic(event, data) {
  if (!io) return;
  io.to(ROOMS.PUBLIC).emit(event, {
    ...data,
    _ts: Date.now(),
    _src: 'server',
  });
}

/**
 * Emit to all clients (admin + public)
 */
function emitToAll(event, data) {
  if (!io) return;
  io.to(ROOMS.ALL).emit(event, {
    ...data,
    _ts: Date.now(),
    _src: 'server',
  });
}

/**
 * Emit to all clients EXCEPT the sender (for broadcasts from server mutations)
 */
function broadcast(event, data, excludeSocketId = null) {
  if (!io) return;
  for (const [room, clients] of io.sockets.adapter.rooms) {
    for (const clientId of clients) {
      if (excludeSocketId && clientId === excludeSocketId) continue;
      io.to(clientId).emit(event, {
        ...data,
        _ts: Date.now(),
        _src: 'server',
      });
    }
  }
}

// ─── High-level event emitters ────────────────────────────────────────────────

/**
 * Emit order:created event
 * @param {object} sale - The newly created sale
 */
function emitOrderCreated(sale) {
  logger.debug('[WS] Emitting order:created', { saleId: sale?.id });
  emitToAll(EVENTS.ORDER_CREATED, { sale });
}

/**
 * Emit order:updated event
 * @param {object} sale - The updated sale
 */
function emitOrderUpdated(sale) {
  logger.debug('[WS] Emitting order:updated', { saleId: sale?.id });
  emitToAll(EVENTS.ORDER_UPDATED, { sale });
}

/**
 * Emit order:deleted event
 * @param {number|string} saleId - The deleted sale ID
 */
function emitOrderDeleted(saleId) {
  logger.debug('[WS] Emitting order:deleted', { saleId });
  emitToAll(EVENTS.ORDER_DELETED, { saleId });
}

/**
 * Emit inventory:updated event
 * @param {object} inventoryData - Current inventory state
 */
function emitInventoryUpdated(inventoryData) {
  logger.debug('[WS] Emitting inventory:updated');
  emitToAll(EVENTS.INVENTORY_UPDATED, { inventory: inventoryData });
}

/**
 * Emit keg:updated event
 * @param {object} kegData - Current keg stats
 */
function emitKegUpdated(kegData) {
  logger.debug('[WS] Emitting keg:updated');
  emitToAll(EVENTS.KEG_UPDATED, { kegs: kegData });
}

/**
 * Emit customer:updated event
 * @param {object} customer - Updated customer
 */
function emitCustomerUpdated(customer) {
  logger.debug('[WS] Emitting customer:updated', { customerId: customer?.id });
  emitToAll(EVENTS.CUSTOMER_UPDATED, { customer });
}

/**
 * Emit expense events
 * @param {string} action - 'created' | 'updated' | 'deleted'
 * @param {object} expense - Expense data
 */
function emitExpense(action, expense) {
  logger.debug(`[WS] Emitting expense:${action}`, { expenseId: expense?.id });
  const eventMap = {
    created: EVENTS.EXPENSE_CREATED,
    updated: EVENTS.EXPENSE_UPDATED,
    deleted: EVENTS.EXPENSE_DELETED,
  };
  const event = eventMap[action];
  if (event) emitToAll(event, { expense });
}

/**
 * Emit report:updated event (after any data mutation that affects reports)
 * @param {object} context - Context info about what changed
 */
function emitReportUpdated(context = {}) {
  logger.debug('[WS] Emitting report:updated', context);
  emitToAll(EVENTS.REPORT_UPDATED, context);
}

/**
 * Force all clients to refetch specific entities
 * @param {string[]} entities - e.g. ['orders', 'inventory', 'reports']
 */
function forceRefetch(entities) {
  logger.debug('[WS] Force refetch', { entities });
  emitToAll(EVENTS.REFETCH_NOW, { entities, from: 'server' });
}

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = {
  init,
  EVENTS,
  ROOMS,
  emitToAdmin,
  emitToPublic,
  emitToAll,
  broadcast,
  emitOrderCreated,
  emitOrderUpdated,
  emitOrderDeleted,
  emitInventoryUpdated,
  emitKegUpdated,
  emitCustomerUpdated,
  emitExpense,
  emitReportUpdated,
  forceRefetch,
  getIO: () => io,
};