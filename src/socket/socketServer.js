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

// ─── Emit Throttling / Coalescing ─────────────────────────────────────────────
// Rapid mutations (e.g. bulk imports) can fire hundreds of WS events/sec.
// We coalesce repeated emits of the same event within a short window so that
// only the LAST payload is actually broadcast. This avoids flooding clients
// and spending CPU on the broadcast loop.

const EMIT_COALESCE_MS = 100; // ms — coalesce repeated emits within this window
const _emitBuffers = new Map(); // eventName -> { payload, timer }

function _flushCoalescedEmit(event) {
  const buf = _emitBuffers.get(event);
  if (!buf) return;
  _emitBuffers.delete(event);
  if (!io) return;
  io.to(ROOMS.ALL).emit(event, {
    ...buf.payload,
    _ts: Date.now(),
    _src: 'server',
  });
}

function _coalescedEmit(event, payload) {
  if (!io) return;
  // Keep only the most recent payload; reset the timer
  const existing = _emitBuffers.get(event);
  if (existing) {
    clearTimeout(existing.timer);
    existing.payload = payload;
  } else {
    _emitBuffers.set(event, { payload, timer: null });
  }
  const buf = _emitBuffers.get(event);
  buf.timer = setTimeout(() => _flushCoalescedEmit(event), EMIT_COALESCE_MS);
  // unref so a pending coalesce never keeps the process alive
  if (typeof buf.timer.unref === 'function') buf.timer.unref();
}

// ─── Socket Server Class ──────────────────────────────────────────────────────

let io = null;

function init(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    serveClient: true,
    // Ping timeout: 20s, interval: 25s
    pingTimeout: 20000,
    pingInterval: 25000,
    // Transports: prefer WebSocket first, fall back to HTTP polling if proxy blocks upgrade.
    // This works correctly because Nginx now has Upgrade headers on /socket.io/ location.
    transports: ['websocket', 'polling'],
    // Allow Socket.IO to upgrade the connection when the client requests it
    allowUpgrades: true,
  });

  // ── Middleware: authenticate on connection ──────────────────────────────────
  // BeerPOS uses session-cookie auth on all pages.
  // Socket.IO connections are trusted because:
  //   1. Client must be logged in (session cookie validated on every page load)
  //   2. Admin pages are already protected by auth middleware
  //   3. Public pages (menu display) don't need strict auth
  // So we allow all connections here. If you need strict socket auth later,
  // validate the session cookie or a JWT instead of a separate token.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    // Log the connection attempt for debugging
    logger.info(`[WS] Connection attempt from ${socket.handshake.address}, has_token=${!!token}`);
    // Allow all — auth is handled at page level, not socket level
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
  const payload = { ...data, _ts: Date.now(), _src: 'server' };
  for (const [room, clients] of io.sockets.adapter.rooms) {
    for (const clientId of clients) {
      if (excludeSocketId && clientId === excludeSocketId) continue;
      io.to(clientId).emit(event, payload);
    }
  }
}

/**
 * Flush any pending coalesced emits — call this at the end of bulk operations
 * to make sure the last state is broadcast without waiting the full window.
 */
function flushCoalesced() {
  for (const event of Array.from(_emitBuffers.keys())) {
    const buf = _emitBuffers.get(event);
    if (buf && buf.timer) {
      clearTimeout(buf.timer);
      _flushCoalescedEmit(event);
    }
  }
}

// ─── High-level event emitters ────────────────────────────────────────────────

/**
 * Emit order:created event — coalesced to avoid spam
 * @param {object} sale - The newly created sale
 */
function emitOrderCreated(sale) {
  _coalescedEmit(EVENTS.ORDER_CREATED, { sale });
}

/**
 * Emit order:updated event — coalesced
 */
function emitOrderUpdated(sale) {
  _coalescedEmit(EVENTS.ORDER_UPDATED, { sale });
}

/**
 * Emit order:deleted event — direct (rare event, no coalesce needed)
 */
function emitOrderDeleted(saleId) {
  emitToAll(EVENTS.ORDER_DELETED, { saleId });
}

/**
 * Emit inventory:updated event — coalesced (frequently fires)
 */
function emitInventoryUpdated(inventoryData) {
  _coalescedEmit(EVENTS.INVENTORY_UPDATED, { inventory: inventoryData });
}

/**
 * Emit keg:updated event — coalesced
 */
function emitKegUpdated(kegData) {
  _coalescedEmit(EVENTS.KEG_UPDATED, { kegs: kegData });
}

/**
 * Emit customer:updated event — coalesced
 */
function emitCustomerUpdated(customer) {
  _coalescedEmit(EVENTS.CUSTOMER_UPDATED, { customer });
}

/**
 * Emit expense events — coalesced
 */
function emitExpense(action, expense) {
  const eventMap = {
    created: EVENTS.EXPENSE_CREATED,
    updated: EVENTS.EXPENSE_UPDATED,
    deleted: EVENTS.EXPENSE_DELETED,
  };
  const event = eventMap[action];
  if (event) _coalescedEmit(event, { expense });
}

/**
 * Emit report:updated event — coalesced (many mutations may fire this)
 */
function emitReportUpdated(context = {}) {
  _coalescedEmit(EVENTS.REPORT_UPDATED, context);
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
  flushCoalesced,
  getIO: () => io,
};

// Cleanup coalesced timers on process exit
process.on('exit', () => {
  flushCoalesced();
});
