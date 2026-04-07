/**
 * BeerPOS Real-time Client Manager
 * ─────────────────────────────────────────────────────────────────────────────
 * - Connects to Socket.IO server on app start
 * - Listens for all data-change events and triggers refetch
 * - BroadcastChannel for multi-tab sync (tabs update together)
 * - Offline queue: queues events when disconnected, replays on reconnect
 * - Debug logging with `[WS][Client]` prefix
 * - Exposes global `window.Realtime` API for manual use
 *
 * Usage:
 *   // Auto-initialized on load
 *   Realtime.forceRefetch(['orders', 'inventory']);
 *   Realtime.getStatus();
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────────

  const BCAST_CHANNEL = 'beerpos-realtime';
  const BCAST_EVENT   = 'beerpos-sync';

  // Debounce delay for refetch (ms) — prevents rapid-fire on burst events
  const REFETCH_DEBOUNCE = 100;

  // ── State ────────────────────────────────────────────────────────────────────

  let _socket      = null;
  let _connected    = false;
  let _debug        = false;
  let _refetchTimer = null;
  let _pendingRefetch = new Set();
  let _bc           = null;
  let _bcastSupported = false;
  let _initCalled    = false;
  let _pendingEvents = []; // queued while disconnected

  // ── Debug ───────────────────────────────────────────────────────────────────

  function log(tag, msg, data) {
    if (!_debug && tag !== 'INFO') return;
    const prefix = '[WS][Client]';
    if (data !== undefined) {
      console.log(`${prefix} [${tag}] ${msg}`, data);
    } else {
      console.log(`${prefix} [${tag}] ${msg}`);
    }
  }

  // ── BroadcastChannel (multi-tab) ────────────────────────────────────────────

  function initBroadcast() {
    try {
      if (!('BroadcastChannel' in window)) return;
      _bc = new BroadcastChannel(BCAST_CHANNEL);
      _bcastSupported = true;

      _bc.onmessage = function (evt) {
        const msg = evt.data;
        if (!msg || typeof msg !== 'object') return;

        log('BROADCAST', 'Received cross-tab message', msg);

        if (msg.type === 'sync') {
          // Another tab changed data — refetch everything
          triggerRefetch(['all']);
        } else if (msg.type === 'force-refetch') {
          triggerRefetch(msg.entities || ['all']);
        } else if (msg.type === 'ping') {
          // Another tab pinged — respond if we're the leader tab
          // Simple strategy: just refetch (lightweight, safe)
          triggerRefetch(['all']);
        }
      };

      log('INFO', 'BroadcastChannel initialized');
    } catch (e) {
      log('WARN', 'BroadcastChannel not available', e.message);
      _bcastSupported = false;
    }
  }

  /**
   * Broadcast a sync message to other tabs
   * @param {string} type - 'sync' | 'force-refetch'
   * @param {object} data
   */
  function bcastSend(type, data) {
    if (!_bcastSupported || !_bc) return;
    try {
      _bc.postMessage(Object.assign({ type }, data));
    } catch (e) {
      // Silently ignore — BroadcastChannel can throw on closed channel
    }
  }

  // ── Socket.IO Connection ─────────────────────────────────────────────────────

  /**
   * Connect to Socket.IO server.
   * Safe to call multiple times — only connects once.
   */
  function connect() {
    if (_initCalled) return;
    _initCalled = true;

    // Detect mode
    const mode = (window.APP_MODE === 'public') ? 'public' : 'admin';
    const base = window.BASE_PATH || '/';

    // Socket.IO client from the socket.io-client package
    const io = window.io;

    if (typeof io !== 'function') {
      // Socket.IO client not loaded yet — retry after short delay
      log('WARN', 'socket.io-client not loaded yet, retrying...');
      setTimeout(connect, 500);
      return;
    }

    log('INFO', `Connecting to Socket.IO, mode=${mode}`);

    _socket = io('/', {
      path: base + 'socket.io',
      auth: { token: getAuthToken() },
      query: { mode: mode },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      reconnectionAttempts: Infinity,
      timeout: 10000,
    });

    // ── Connection lifecycle ────────────────────────────────────────────────

    _socket.on('connect', function () {
      _connected = true;
      log('CONNECT', 'Socket connected: ' + _socket.id);

      // Replay pending events
      if (_pendingEvents.length > 0) {
        log('INFO', `Replaying ${_pendingEvents.length} pending events`);
        _pendingEvents.forEach(function (ev) {
          _socket.emit(ev.name, ev.data);
        });
        _pendingEvents = [];
      }

      // Broadcast to other tabs
      bcastSend('force-refetch', { entities: ['all'] });
    });

    _socket.on('disconnect', function (reason) {
      _connected = false;
      log('DISCONNECT', `Socket disconnected: ${reason}`);
    });

    _socket.on('connect_error', function (err) {
      log('ERROR', 'Connection error: ' + (err.message || err));
    });

    _socket.on('reconnect_attempt', function (attempt) {
      log('INFO', `Reconnecting... attempt ${attempt}`);
    });

    _socket.on('reconnect', function () {
      log('INFO', 'Reconnected!');
      bcastSend('force-refetch', { entities: ['all'] });
    });

    _socket.on('error', function (err) {
      log('ERROR', 'Socket error', err);
    });

    // ── Server → Client events ───────────────────────────────────────────────

    // Connected confirmation
    _socket.on('connected', function (data) {
      log('CONNECT', 'Server confirmed connection', data);
    });

    // ── DATA CHANGE EVENTS ──────────────────────────────────────────────────
    // Each event triggers a targeted refetch via window.loadData / dispatchEvent

    _socket.on('order:created', function (data) {
      log('EVENT', 'order:created received', data);
      triggerRefetch(['orders', 'reports', 'dashboard']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('order:updated', function (data) {
      log('EVENT', 'order:updated received', data);
      triggerRefetch(['orders', 'reports', 'dashboard']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('order:deleted', function (data) {
      log('EVENT', 'order:deleted received', data);
      triggerRefetch(['orders', 'reports', 'dashboard']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('inventory:updated', function (data) {
      log('EVENT', 'inventory:updated received', data);
      triggerRefetch(['inventory', 'products', 'stock', 'reports']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('keg:updated', function (data) {
      log('EVENT', 'keg:updated received', data);
      triggerRefetch(['kegs', 'inventory', 'products']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('customer:updated', function (data) {
      log('EVENT', 'customer:updated received', data);
      triggerRefetch(['customers', 'orders']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('expense:created', function (data) {
      log('EVENT', 'expense:created received', data);
      triggerRefetch(['expenses', 'reports', 'dashboard']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('expense:updated', function (data) {
      log('EVENT', 'expense:updated received', data);
      triggerRefetch(['expenses', 'reports', 'dashboard']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('expense:deleted', function (data) {
      log('EVENT', 'expense:deleted received', data);
      triggerRefetch(['expenses', 'reports', 'dashboard']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('report:updated', function (data) {
      log('EVENT', 'report:updated received', data);
      triggerRefetch(['reports', 'dashboard']);
      bcastSend('sync', { source: 'socket' });
    });

    // Force immediate refetch (from another client requesting it)
    _socket.on('refetch:now', function (data) {
      log('EVENT', 'refetch:now received', data);
      triggerRefetch(data.entities || ['all']);
      bcastSend('sync', { source: 'socket' });
    });

    // ── Ping ───────────────────────────────────────────────────────────────
    _socket.on('ping', function (data) {
      // Passive ping from server — respond if needed
      log('PING', 'Server ping received', data);
    });
  }

  // ── Refetch logic ───────────────────────────────────────────────────────────

  /**
   * Trigger refetch for specified entities.
   * Uses debounce to batch multiple rapid-fire events.
   * Always refetches from API (never trusts event payload).
   *
   * @param {string[]} entities - e.g. ['orders', 'inventory', 'reports']
   */
  function triggerRefetch(entities) {
    // Always include 'all' if present
    if (entities.includes('all')) {
      entities = ['orders', 'inventory', 'reports', 'dashboard', 'products', 'customers', 'expenses', 'kegs'];
    }

    entities.forEach(function (e) { _pendingRefetch.add(e); });

    clearTimeout(_refetchTimer);
    _refetchTimer = setTimeout(function () {
      const toRefetch = Array.from(_pendingRefetch);
      _pendingRefetch.clear();

      log('REFETCH', 'Triggering refetch for: ' + toRefetch.join(', '));

      // Strategy 1: Use page's window.loadData if available
      if (typeof window.loadData === 'function') {
        log('REFETCH', 'Calling window.loadData()');
        window.loadData().catch(function (err) {
          log('ERROR', 'loadData() failed', err);
        });
      }

      // Strategy 2: Dispatch custom event for page-specific handlers
      var detail = { entities: toRefetch, ts: Date.now() };
      var evt = new CustomEvent('realtime:refetch', { detail: detail });
      window.dispatchEvent(evt);
      log('REFETCH', 'Dispatched realtime:refetch event');

      // Strategy 3: BroadcastChannel — notifies other tabs to also refetch
      bcastSend('force-refetch', { entities: toRefetch });

      // Strategy 4: Notify Service Worker to clear relevant caches
      notifyServiceWorker(toRefetch);

    }, REFETCH_DEBOUNCE);
  }

  // ── Service Worker notification ───────────────────────────────────────────

  function notifyServiceWorker(entities) {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;

    var paths = [];
    entities.forEach(function (entity) {
      var map = {
        orders:     ['/api/sales', '/dashboard/data'],
        inventory:  ['/api/stock', '/api/products'],
        products:   ['/api/products', '/api/stock'],
        customers:  ['/api/customers'],
        expenses:   ['/api/expenses'],
        reports:    ['/report/data'],
        dashboard:  ['/dashboard/data'],
        kegs:       ['/api/kegs', '/api/stock'],
      };
      var p = map[entity];
      if (p) paths.push.apply(paths, p);
    });

    if (paths.length === 0) return;

    navigator.serviceWorker.controller.postMessage({
      type: 'REALTIME_INVALIDATE',
      paths: paths,
      ts: Date.now(),
    });
  }

  // ── Auth token helper ───────────────────────────────────────────────────────

  function getAuthToken() {
    // Try to get token from localStorage (same as auth.js)
    try {
      var stored = localStorage.getItem('auth_token');
      if (stored) {
        var parsed = JSON.parse(stored);
        return parsed.token || stored;
      }
    } catch (e) { /* ignore */ }
    // Fallback: check cookies
    if (document.cookie) {
      var match = document.cookie.match(/session_token=([^;]+)/);
      if (match) return match[1];
    }
    return null;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Force immediate refetch for specific entities.
   * Call this after local mutations to sync all clients.
   * @param {string[]} entities
   */
  function forceRefetch(entities) {
    triggerRefetch(entities);
  }

  /**
   * Emit a custom event to server (for multi-tab leader election, etc.)
   * @param {string} event
   * @param {object} data
   */
  function emit(event, data) {
    if (!_socket || !_connected) {
      _pendingEvents.push({ name: event, data: data });
      log('WARN', `Socket not connected — queued event: ${event}`);
      return;
    }
    _socket.emit(event, data);
  }

  /**
   * Get current connection status.
   * @returns {{ connected: boolean, id: string|null, debug: boolean }}
   */
  function getStatus() {
    return {
      connected: _connected,
      id: _socket ? _socket.id : null,
      debug: _debug,
      broadcastSupported: _bcastSupported,
      pendingEvents: _pendingEvents.length,
    };
  }

  /**
   * Enable/disable debug logging.
   * @param {boolean} enabled
   */
  function setDebug(enabled) {
    _debug = !!enabled;
    log('INFO', 'Debug ' + (_debug ? 'enabled' : 'disabled'));
  }

  /**
   * Manually disconnect socket (rarely needed).
   */
  function disconnect() {
    if (_socket) {
      _socket.disconnect();
      _connected = false;
    }
  }

  /**
   * Reconnect socket after manual disconnect.
   */
  function reconnect() {
    if (_socket) {
      _socket.connect();
    }
  }

  /**
   * Broadcast to other tabs directly (bypass socket).
   * @param {string} type
   * @param {object} data
   */
  function broadcast(type, data) {
    bcastSend(type, data);
  }

  // ── Expose global API ───────────────────────────────────────────────────────

  window.Realtime = {
    connect:       connect,
    forceRefetch:   forceRefetch,
    emit:           emit,
    getStatus:      getStatus,
    setDebug:       setDebug,
    disconnect:     disconnect,
    reconnect:      reconnect,
    broadcast:      broadcast,
    // Expose constants for advanced usage
    EVENTS: {
      ORDER_CREATED:     'order:created',
      ORDER_UPDATED:     'order:updated',
      ORDER_DELETED:     'order:deleted',
      INVENTORY_UPDATED: 'inventory:updated',
      KEG_UPDATED:       'keg:updated',
      CUSTOMER_UPDATED:  'customer:updated',
      EXPENSE_CREATED:   'expense:created',
      EXPENSE_UPDATED:   'expense:updated',
      EXPENSE_DELETED:   'expense:deleted',
      REPORT_UPDATED:    'report:updated',
      REFETCH_NOW:       'refetch:now',
    },
  };

  // ── Auto-initialize ────────────────────────────────────────────────────────

  /**
   * Wait for DOM + socket.io client to be ready, then connect.
   */
  function autoInit() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', doInit);
    } else {
      doInit();
    }
  }

  function doInit() {
    // Wait for socket.io-client to be available
    if (typeof window.io === 'undefined') {
      // Load socket.io-client from CDN if not bundled
      var script = document.createElement('script');
      script.src = (window.BASE_PATH || '/') + 'socket.io/socket.io.js';
      script.onload = function () {
        log('INFO', 'Socket.IO client loaded from CDN');
        connect();
      };
      script.onerror = function () {
        log('ERROR', 'Failed to load socket.io-client from CDN');
      };
      document.head.appendChild(script);
    } else {
      connect();
    }

    // Also initialize BroadcastChannel immediately (no async needed)
    initBroadcast();

    // Listen for page-specific realtime:refetch events
    window.addEventListener('realtime:refetch', function (evt) {
      log('EVENT', 'realtime:refetch event caught', evt.detail);
      // Pages can listen to this event to implement custom refetch logic
    });

    log('INFO', 'BeerPOS Real-time client initialized');
  }

  autoInit();

})();
