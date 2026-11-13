// BeerPOS Real-time WebSocket Server
// Socket.IO integration for multi-device sync
//
// ── A4: Xác thực & phân quyền ───────────────────────────────────────────────
// Trước A4: mọi client đều kết nối được, và TẤT CẢ join room `admin`.
//   → Driver Portal (mode=driver) nhận event `order:created` chứa cột `profit`
//      (rò rỉ dữ liệu tài chính sang tài xế).
// Sau A4:
//   - Handshake BẮT BUỘC có session hợp lệ (trừ chế độ public).
//   - Room do SERVER quyết định theo role trong DB, KHÔNG theo `mode` client gửi.
//   - Payload gửi cho tài xế được sanitize (bỏ field lợi nhuận / giá vốn / doanh thu).
//   - `mode=driver` từ client KHÔNG còn được tin → driver tự khai báo room admin
//     cũng sẽ bị server gán đúng room `driver`.

const { Server } = require('socket.io');
const logger = require('../utils/logger');
const socketAuth = require('./socketAuth');

const {
  ROLE_ADMIN,
  ROLE_DRIVER,
  ROOM_ADMIN,
  ROOM_DRIVER,
  ROOM_PUBLIC,
  resolveSession,
  roomForRole,
  buildDriverOrderPayload,
} = socketAuth;

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

  // Auth events (A4)
  SESSION_REVOKED: 'session:revoked',
};
// ─── Room definitions ──────────────────────────────────────────────────────────
//
// ADMIN  = admin panel clients (payload đầy đủ)
// DRIVER = Driver Portal (payload ĐÃ sanitize)
// PUBLIC = client không đăng nhập (landing page / menu công khai)
// ALL    = KHÔNG còn client nào join — giữ lại cho tương thích code cũ.
//
// ⚠️ BUG ĐÃ SỬA: trước A4, mọi client (kể cả tài xế) đều join room `all`
// và nhận payload đầy đủ (chứa `profit`). Nay mọi event đi qua emitToRoles()
// để sanitize cho tài xế.

const ROOMS = {
  ADMIN:   ROOM_ADMIN,    // Admin panel clients (full payload)
  DRIVER:  ROOM_DRIVER,   // Driver Portal (sanitized payload)
  PUBLIC:  ROOM_PUBLIC,   // Public-facing clients
  ALL:     'all',        // không còn client nào join (tương thích code cũ)
};

// Event chỉ dành cho admin — tài xế không bao giờ nhận.
const ADMIN_ONLY_EVENTS = new Set([
  EVENTS.EXPENSE_CREATED,
  EVENTS.EXPENSE_UPDATED,
  EVENTS.EXPENSE_DELETED,
  EVENTS.REPORT_UPDATED,
]);

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
  // Dữ liệu nghiệp vụ → đi qua emitToRoles để sanitize cho tài xế.
  if (ADMIN_ONLY_EVENTS.has(event)) {
    io.to(ROOMS.ADMIN).emit(event, { ...buf.payload, _ts: Date.now(), _src: 'server' });
    return;
  }
  emitToRoles(event, buf.payload);
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

// ─── Emit to role-scoped rooms ────────────────────────────────────────────────
//
// Room của DRIVER chỉ nhận payload ĐÃ SANITIZE. Việc sanitize xảy ra ở
// SERVER (không phải client) — client không có quyền quyết định dữ liệu
// nào được nhìn thấy.

/**
 * Gửi event tới admin (payload đầy đủ) và driver (payload đã lọc).
 * @param {string} event
 * @param {object} payload
 */
function emitToRoles(event, payload) {
  if (!io) return;
  const envelope = { ...payload, _ts: Date.now(), _src: 'server' };

  if (!ADMIN_ONLY_EVENTS.has(event)) {
    io.to(ROOMS.ADMIN).emit(event, envelope);
    io.to(ROOMS.DRIVER).emit(event, buildDriverOrderPayload(payload));
  } else {
    io.to(ROOMS.ADMIN).emit(event, envelope);
  }
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

  // ── Middleware: authenticate on connection (A4) ───────────────────────────
  //
  // Bắt buộc có session hợp lệ trong DB. Ngoại lệ: chế độ public (landing
  // page / menu hiển thị) — không có dữ liệu nhạy cảm nên vẫn cho phép,
  // nhưng chỉ join room `public` và KHÔNG nhận event nghiệp vụ.
  io.use((socket, next) => {
    const declaredMode = socket.handshake.query?.mode || socket.handshake.auth?.mode || '';
    const session = resolveSession(socket.handshake);

    if (!session) {
      // Không có session → chỉ cho phép nếu client nói mình là public.
      // Client admin/driver thiếu token sẽ bị từ chối → client phải đăng nhập lại.
      if (declaredMode === 'public') {
        socket.data.role = 'PUBLIC';
        socket.data.username = null;
        logger.info(`[WS] Public connection from ${socket.handshake.address}`);
        return next();
      }
      logger.warn(`[WS] Rejected unauthenticated connection from ${socket.handshake.address}`);
      return next(Object.assign(new Error('Unauthorized'), { data: { code: 'UNAUTHORIZED' } }));
    }

    socket.data.role = session.role || ROLE_ADMIN;
    socket.data.username = session.username;
    socket.data.appUserId = session.appUserId || null;
    logger.info(
      `[WS] Authenticated connection from ${socket.handshake.address}, role=${socket.data.role}`
    );
    next();
  });

  // ── Connection handler ─────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const ip = socket.handshake.address;
    const id = socket.id;
    const role = socket.data.role || 'PUBLIC';

    // Room do SERVER quyết định theo role — KHÔNG theo `mode` client gửi.
    const room =
      role === 'PUBLIC' ? ROOMS.PUBLIC : roomForRole(role);

    socket.join(room);

    logger.info(`[WS] Client connected: ${id} from ${ip}, role=${role}, room=${room}`);

    // Emit connected confirmation
    socket.emit(EVENTS.CONNECTED, {
      socketId: id,
      rooms: [room],
      role,
      username: socket.data.username || null,
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
      // Tài xế chỉ được yêu cầu refetch nhóm dữ liệu thuộc phạm vi của mình.
      const allowed = role === ROLE_DRIVER
        ? ['orders', 'sales', 'inventory', 'products', 'kegs', 'deliveries', 'customers', 'all']
        : null;
      const requested = Array.isArray(entities) && entities.length ? entities : ['all'];
      const filtered = allowed ? requested.filter((e) => allowed.includes(e)) : requested;

      socket.broadcast.emit(EVENTS.REFETCH_NOW, {
        entities: filtered.length ? filtered : ['orders'],
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

  logger.info('[WS] Socket.IO server initialized (A4: auth required)');
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
 * Emit tới MỌI client đã đăng nhập (admin + driver).
 *
 * ⚠️ A4: payload gửi qua hàm này KHÔNG được chứa dữ liệu tài chính vì
 * driver cũng nhận. Chỉ dùng cho tín hiệu điều khiển (ví dụ `refetch:now`).
 * Với dữ liệu nghiệp vụ → dùng emitToRoles() (tự sanitize cho driver).
 */
function emitToAll(event, data) {
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) {
    const role = socket.data?.role || 'PUBLIC';
    if (role === 'PUBLIC') continue;
    const payload = { ...data, _ts: Date.now(), _src: 'server' };
    if (role === ROLE_DRIVER) {
      io.to(socket.id).emit(event, buildDriverOrderPayload(payload));
    } else {
      io.to(socket.id).emit(event, payload);
    }
  }
}

/**
 * Emit to all clients EXCEPT the sender (for broadcasts from server mutations)
 *
 * ⚠️ A4: driver LUÔN nhận bản sanitize — kể cả khi admin nhận bản đầy đủ.
 * Duyệt theo SOCKET (không theo room) để tránh gửi trùng.
 * Client chưa đăng nhập (PUBLIC) không nhận dữ liệu nghiệp vụ.
 */
function broadcast(event, data, excludeSocketId = null) {
    if (!io) return;
  const payload = { ...data, _ts: Date.now(), _src: 'server' };

  for (const socket of io.sockets.sockets.values()) {
    if (excludeSocketId && socket.id === excludeSocketId) continue;
    const role = socket.data?.role || 'PUBLIC';
    // Client chưa đăng nhập (PUBLIC) không nhận dữ liệu nghiệp vụ.
    if (role === 'PUBLIC') continue;
    if (role === ROLE_DRIVER) {
      io.to(socket.id).emit(event, buildDriverOrderPayload(payload));
    } else {
      io.to(socket.id).emit(event, payload);
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
  emitToRoles(EVENTS.ORDER_DELETED, { saleId });
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
  forceRefetchDrivers(entities);
}

/**
 * A4: Gửi tín hiệu refetch riêng cho tài xế, chỉ gồm nhóm dữ liệu thuộc
 * phạm vi của họ (loại bỏ 'reports' / 'dashboard' vì driver bị apiGuard chặn
 * và không có quyền xem báo cáo tài chính).
 * @param {string[]} entities
 */
function forceRefetchDrivers(entities) {
  if (!io) return;
  const allowed = ['orders', 'sales', 'inventory', 'products', 'kegs', 'deliveries', 'customers'];
  const list = (Array.isArray(entities) ? entities : ['all'])
    .filter((e) => e === 'all' || allowed.includes(e));
  io.to(ROOMS.DRIVER).emit(EVENTS.REFETCH_NOW, {
    entities: list.length ? list : ['orders'],
    from: 'server',
    _ts: Date.now(),
    _src: 'server',
  });
}

/**
 * A4: Ngắt kết nối mọi socket đang dùng một token cụ thể.
 * Dùng khi admin đổi mật khẩu / đăng xuất → các thiết bị khác mất phiên
 * ngay lập tức thay vì phải chờ hết hạn 30 ngày.
 *
 * @param {string} token - session token cần vô hiệu hoá
 * @param {string} [reason]
 * @returns {number} số socket bị ngắt
 */
function disconnectToken(token, reason = 'session_revoked') {
  if (!io || !token) return 0;
  let count = 0;
  for (const socket of io.sockets.sockets.values()) {
    const st = socket.handshake?.auth?.token || socket.handshake?.query?.token;
    if (st === token) {
      socket.emit(EVENTS.SESSION_REVOKED, { reason });
      socket.disconnect(true);
      count += 1;
    }
  }
  if (count > 0) logger.info(`[WS] Disconnected ${count} socket(s) for revoked session`);
  return count;
}

/**
 * A4: Ngắt kết nối mọi socket của một user (dùng khi đổi mật khẩu tài xế).
 * @param {string} username
 * @param {string} [reason]
 * @returns {number}
 */
function disconnectUser(username, reason = 'session_revoked') {
  if (!io || !username) return 0;
  let count = 0;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data?.username === username) {
      socket.emit(EVENTS.SESSION_REVOKED, { reason });
      socket.disconnect(true);
      count += 1;
    }
  }
  if (count > 0) logger.info(`[WS] Disconnected ${count} socket(s) for user ${username}`);
  return count;
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
  emitToRoles,
  emitOrderCreated,
  emitOrderUpdated,
    emitOrderDeleted,
  emitInventoryUpdated,
  emitKegUpdated,
  emitCustomerUpdated,
  emitExpense,
  emitReportUpdated,
  forceRefetch,
  forceRefetchDrivers,
  flushCoalesced,
  disconnectToken,
  disconnectUser,
  getIO: () => io,
};

// Cleanup coalesced timers on process exit
process.on('exit', () => {
  flushCoalesced();
});
