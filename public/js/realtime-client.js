/**
 * BeerPOS - Real-time Socket Client
 *
 * Kết nối Socket.IO để nhận cập nhật real-time:
 * - Dashboard KPIs (revenue, orders)
 * - New orders
 * - Inventory changes
 * - Keg updates
 *
 * Usage:
 *   import { initRealtime, onDashboardUpdate } from './realtime-client';
 *   initRealtime();
 *   onDashboardUpdate((data) => updateUI(data));
 */

class RealtimeClient {
  constructor() {
    this.io = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000;
    this.listeners = new Map();
    this.throttleTimers = new Map();

    // Throttle: tránh spam updates trong 1 khoảng ngắn
    this.throttleInterval = 1000; // 1 giây
  }

  /**
   * Initialize Socket.IO connection
   */
  connect() {
    if (this.io) return this.io;

    // Check if socket.io is loaded
    if (typeof io === 'undefined') {
      console.warn('[Realtime] Socket.IO not loaded yet');
      return null;
    }

    try {
      this.io = io({
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: this.reconnectDelay,
        reconnectionAttempts: this.maxReconnectAttempts,
        timeout: 10000
      });

      this._setupListeners();
      return this.io;
    } catch (e) {
      console.error('[Realtime] Connection error:', e);
      return null;
    }
  }

  /**
   * Setup socket event listeners
   */
  _setupListeners() {
    const socket = this.io;

    socket.on('connect', () => {
      console.log('[Realtime] Connected:', socket.id);
      this.connected = true;
      this.reconnectAttempts = 0;
      this._emit('connected', { socketId: socket.id });
    });

    socket.on('disconnect', (reason) => {
      console.log('[Realtime] Disconnected:', reason);
      this.connected = false;
    });

    socket.on('connect_error', (err) => {
      console.error('[Realtime] Connection error:', err.message);
      this.reconnectAttempts++;
    });

    // ── Dashboard updates ────────────────────────────────────────────
    socket.on('report:updated', (data) => {
      this._throttledEmit('dashboard:refresh', data);
    });

    socket.on('order:created', (data) => {
      this._throttledEmit('order:new', data);
    });

    socket.on('order:updated', (data) => {
      this._throttledEmit('order:update', data);
    });

    // ── Inventory updates ────────────────────────────────────────────
    socket.on('inventory:updated', (data) => {
      this._throttledEmit('inventory:refresh', data);
    });

    // ── Keg updates ──────────────────────────────────────────────────
    socket.on('keg:updated', (data) => {
      this._throttledEmit('keg:refresh', data);
    });

    // ── Customer updates ──────────────────────────────────────────────
    socket.on('customer:updated', (data) => {
      this._throttledEmit('customer:refresh', data);
    });

    // ── Refetch request ──────────────────────────────────────────────
    socket.on('refetch:now', (data) => {
      console.log('[Realtime] Refetch requested:', data.entities);
      this._emit('refetch', data);
    });
  }

  /**
   * Throttled emit - tránh spam updates trong khoảng ngắn
   */
  _throttledEmit(event, data) {
    const key = event;

    // Clear existing timer
    if (this.throttleTimers.has(key)) {
      clearTimeout(this.throttleTimers.get(key));
    }

    // Set new timer
    this.throttleTimers.set(key, setTimeout(() => {
      this._emit(event, data);
      this.throttleTimers.delete(key);
    }, this.throttleInterval));
  }

  /**
   * Internal emit - gọi tất cả listeners cho event
   */
  _emit(event, data) {
    if (!this.listeners.has(event)) return;

    const callbacks = this.listeners.get(event);
    callbacks.forEach(cb => {
      try {
        cb(data);
      } catch (e) {
        console.error('[Realtime] Listener error:', e);
      }
    });
  }

  /**
   * Subscribe to event
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   * @returns {Function} unsubscribe function
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);

    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  /**
   * Subscribe once (auto-unsubscribe after first event)
   */
  once(event, callback) {
    const unsubscribe = this.on(event, (data) => {
      unsubscribe();
      callback(data);
    });
    return unsubscribe;
  }

  /**
   * Disconnect
   */
  disconnect() {
    if (this.io) {
      this.io.disconnect();
      this.io = null;
      this.connected = false;
    }
    this.listeners.clear();
    this.throttleTimers.forEach(t => clearTimeout(t));
    this.throttleTimers.clear();
  }

  /**
   * Get connection status
   */
  isConnected() {
    return this.connected && this.io?.connected;
  }
}

// ─── Singleton instance ────────────────────────────────────────────────────────

const realtime = new RealtimeClient();

// ─── Convenience functions ───────────────────────────────────────────────────

/**
 * Initialize realtime connection
 */
function initRealtime() {
  return realtime.connect();
}

/**
 * On dashboard refresh needed (after any mutation)
 */
function onDashboardRefresh(callback) {
  return realtime.on('dashboard:refresh', callback);
}

/**
 * On new order created
 */
function onNewOrder(callback) {
  return realtime.on('order:new', callback);
}

/**
 * On inventory update
 */
function onInventoryUpdate(callback) {
  return realtime.on('inventory:refresh', callback);
}

/**
 * On keg update
 */
function onKegUpdate(callback) {
  return realtime.on('keg:refresh', callback);
}

/**
 * On refetch request (from another client)
 */
function onRefetch(callback) {
  return realtime.on('refetch', callback);
}

/**
 * Check if connected
 */
function isRealtimeConnected() {
  return realtime.isConnected();
}

// ─── Auto-initialize on page load ──────────────────────────────────────────

// Auto-connect if Socket.IO is available
if (typeof io !== 'undefined') {
  // Defer to after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(initRealtime, 100); // Small delay to ensure socket.io.js loaded
    });
  } else {
    setTimeout(initRealtime, 100);
  }
} else {
  console.warn('[Realtime] Socket.IO not found, real-time disabled');
}

// ─── Export ───────────────────────────────────────────────────────────────────

window.RealtimeClient = RealtimeClient;
window.realtime = realtime;
window.initRealtime = initRealtime;
window.onDashboardRefresh = onDashboardRefresh;
window.onNewOrder = onNewOrder;
window.onInventoryUpdate = onInventoryUpdate;
window.onKegUpdate = onKegUpdate;
window.onRefetch = onRefetch;
window.isRealtimeConnected = isRealtimeConnected;