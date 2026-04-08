/**
 * BeerPOS Real-time Client Manager
 * ─────────────────────────────────────────────────────────────────────────────
 * - Connects to Socket.IO server on app start (singleton — one connection only)
 * - Uses socketSingleton.js internally for the actual connection
 * - Listens for all data-change events and triggers refetch
 * - BroadcastChannel for multi-tab sync (tabs update together)
 * - Offline queue: queues events when disconnected, replays on reconnect
 * - Debounce: prevents rapid-fire refetch on burst events (100ms window)
 * - Anti-duplicate emit: same action within 1s only emits once
 * - Debug logging with `[WS][Client]` prefix
 * - Exposes global `window.Realtime` API for manual use
 *
 * Usage:
 *   Realtime.forceRefetch(['orders', 'inventory']);
 *   Realtime.getStatus();
 *   Realtime.setDebug(true);
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // ── DOUBLE INIT GUARD ────────────────────────────────────────────────────────
  // CRITICAL: This is the FIRST line of code executed.
  // Prevents realtime.js from loading or initializing more than once.

  if (typeof window !== 'undefined' && (window.__BEERPOS_REALTIME__ || window.__beerRealtimeRunning)) {
    console.warn('[WS][Client] realtime.js already loaded — skipping duplicate init');
    return;
  }

  if (typeof window !== 'undefined') {
    window.__BEERPOS_REALTIME__ = true;
    window.__beerRealtimeRunning = true;
  }

  // ── Constants ────────────────────────────────────────────────────────────────

  const BCAST_CHANNEL = 'beerpos-realtime';
  const BCAST_EVENT   = 'beerpos-sync';

  // Debounce delay for refetch (ms) — prevents rapid-fire on burst events
  const REFETCH_DEBOUNCE = 100;

  // Anti-duplicate emit interval (ms) — same action within this window = ignored
  const EMIT_DEBOUNCE = 1000;

  // ── State ────────────────────────────────────────────────────────────────────

  let _socket          = null;
  let _connected       = false;
  let _debug           = false;
  let _refetchTimer    = null;
  let _pendingRefetch  = new Set();
  let _bc              = null;
  let _bcastSupported  = false;
  let _initCalled      = false; // connect() chỉ chạy 1 lần
  let _connectStarted  = false; // ngăn race condition trong connect()
  let _pendingEvents   = []; // queued while disconnected
  let _online             = navigator.onLine;
  let _transportMode      = null; // 'websocket' | 'polling' | null

  // Anti-duplicate emit map: key → timestamp of last emit
  let _lastEmit = {};

  // ── WS URL Config (single source of truth) ──────────────────────────────────
  // IMPORTANT: This is the ONLY place the WS server URL is defined.
  // DO NOT hardcode the URL anywhere else in the codebase.

  const WS_URL = (function () {
    var host = (window.location && window.location.hostname) || '';
    if (host === 'admin.biatuoitayninh.store') {
      return 'https://admin.biatuoitayninh.store';
    }
    if (host === 'biatuoitayninh.store') {
      return 'https://biatuoitayninh.store';
    }
    // Development / localhost — connect to same origin
    return window.location.origin;
  })();

  // ── Debug ───────────────────────────────────────────────────────────────────

  function log(tag, msg, data) {
    if (!_debug && tag !== 'INFO' && tag !== 'CONNECT' && tag !== 'DISCONNECT' &&
        tag !== 'ERROR' && tag !== 'REFETCH') return;
    var prefix = '[WS][Client]';
    if (data !== undefined) {
      console.log(prefix + ' [' + tag + '] ' + msg, data);
    } else {
      console.log(prefix + ' [' + tag + '] ' + msg);
    }
  }

  // ── BroadcastChannel (multi-tab) ────────────────────────────────────────────

  function initBroadcast() {
    try {
      if (!('BroadcastChannel' in window)) return;
      _bc = new BroadcastChannel(BCAST_CHANNEL);
      _bcastSupported = true;

      _bc.onmessage = function (evt) {
        var msg = evt.data;
        if (!msg || typeof msg !== 'object') return;

        log('BROADCAST', 'Received cross-tab message', msg);

        if (msg.type === 'sync') {
          triggerRefetch(['all']);
        } else if (msg.type === 'force-refetch') {
          triggerRefetch(msg.entities || ['all']);
        } else if (msg.type === 'ping') {
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
      _bc.postMessage(Object.assign({ type: type }, data));
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
    // NGĂN DOUBLE CALL — nếu connect() được gọi lần 2 (do script load 2 lần
    // hoặc autoInit chạy 2 lần), bỏ qua ngay.
    if (_initCalled) {
      log('INFO', 'connect() already called, skipping');
      return;
    }
    // NGĂN RACE CONDITION — nếu connect() đang chạy (chờ io load), bỏ qua
    if (_connectStarted) {
      log('INFO', 'connect() already in progress, skipping');
      return;
    }
    _connectStarted = true;

    // Detect mode
    var mode = (window.APP_MODE === 'public') ? 'public' : 'admin';

    // Socket.IO client from the socket.io-client package (served at /socket.io/socket.io.js)
    var io = window.io;

    if (typeof io !== 'function') {
      log('WARN', 'socket.io-client not loaded yet, retrying in 500ms...');
      _connectStarted = false; // cho phép thử lại
      setTimeout(connect, 500);
      return;
    }

    // Mark as initialized ONLY after io is confirmed available
    _initCalled = true;

    log('INFO', '=== connect() STARTING === mode=' + mode + ', url=' + WS_URL);

    // ── CLEAN OLD CONNECTIONS FIRST ──────────────────────────────────────────
    // If any existing socket from hot-reload or previous page, disconnect it.
    // The global guard above prevents double-init, but this catches edge cases.

    if (typeof window.__BEERPOS_SOCKET_INST__ !== 'undefined') {
      try {
        log('INFO', 'Disconnecting existing socket instance');
        window.__BEERPOS_SOCKET_INST__.disconnect();
      } catch (e) { /* ignore */ }
    }

    // ── SOCKET CONFIG ───────────────────────────────────────────────────────
    // NOTE: polling first, websocket second.
    // This order is important when running behind nginx — polling works reliably
    // and the server can upgrade to websocket via the same connection (CORS workaround).

    _socket = io(WS_URL, {
      // Transport order: websocket first, polling fallback if WS upgrade fails
      transports: ['websocket', 'polling'],
      // Auth token — try cookie first (server sets session_token cookie),
      // then localStorage fallback
      auth: { token: getAuthToken() },
      query: { mode: mode },
      // Reconnection — unlimited attempts
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      reconnectionAttempts: Infinity,
      // Connection timeout
      timeout: 20000,
      // Allow upgrades
      upgrade: true,
    });

    log('INFO', 'Socket instance created, id=' + _socket.id);

    // Expose socket instance for cleanup on hot-reload
    window.__BEERPOS_SOCKET_INST__ = _socket;

    // ── Connection lifecycle ────────────────────────────────────────────────

    _socket.on('connect', function () {
      _connected = true;
      console.log('[WS] Connected:', _socket.id);

      // Replay pending events
      if (_pendingEvents.length > 0) {
        log('INFO', 'Replaying ' + _pendingEvents.length + ' pending events');
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
      console.warn('[WS] Disconnected:', reason);
    });

    _socket.on('connect_error', function (err) {
      console.error('[WS] Connect error:', err ? err.message : 'unknown');
      log('ERROR', 'Connection error: ' + (err ? err.message : err));
    });

    _socket.on('upgrade', function (nextTransport) {
      _transportMode = nextTransport;
      log('UPGRADE', 'Transport upgraded to: ' + nextTransport);
    });

    _socket.on('upgradeError', function (err) {
      log('UPGRADE', 'Transport upgrade failed, falling back to polling. Error: ' + (err ? err.message : err));
      // Switch to polling-only if WebSocket upgrade fails
      if (_socket && !_transportMode) {
        log('INFO', 'Switching to polling transport...');
        _socket.io.opts.transports = ['polling'];
        _transportMode = 'polling-fallback';
      }
    });

    _socket.on('reconnect_attempt', function (attempt) {
      log('RECONNECT', 'Reconnecting... attempt #' + attempt);
    });

    _socket.on('reconnect_failed', function () {
      log('ERROR', 'Reconnect failed after unlimited attempts — socket will keep retrying with backoff');
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
    // Anti-duplicate: same event+key within EMIT_DEBOUNCE ms is debounced

    _socket.on('order:created', function (data) {
      var key = 'order:created:' + (data && data.id ? data.id : '');
      if (_shouldDebounce(key)) return;
      log('EVENT', 'order:created received', data);
      triggerRefetch(['orders', 'reports', 'dashboard']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('order:updated', function (data) {
      var key = 'order:updated:' + (data && data.id ? data.id : '');
      if (_shouldDebounce(key)) return;
      log('EVENT', 'order:updated received', data);
      triggerRefetch(['orders', 'reports', 'dashboard']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('order:deleted', function (data) {
      var key = 'order:deleted:' + (data && data.id ? data.id : '');
      if (_shouldDebounce(key)) return;
      log('EVENT', 'order:deleted received', data);
      triggerRefetch(['orders', 'reports', 'dashboard']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('inventory:updated', function (data) {
      var key = 'inventory:updated:' + (data && data.productId ? data.productId : '');
      if (_shouldDebounce(key)) return;
      log('EVENT', 'inventory:updated received', data);
      triggerRefetch(['inventory', 'products', 'stock', 'reports']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('keg:updated', function (data) {
      var key = 'keg:updated:' + (data && data.id ? data.id : '');
      if (_shouldDebounce(key)) return;
      log('EVENT', 'keg:updated received', data);
      triggerRefetch(['kegs', 'inventory', 'products']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('customer:updated', function (data) {
      var key = 'customer:updated:' + (data && data.id ? data.id : '');
      if (_shouldDebounce(key)) return;
      log('EVENT', 'customer:updated received', data);
      triggerRefetch(['customers', 'orders']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('expense:created', function (data) {
      var key = 'expense:created:' + (data && data.id ? data.id : '');
      if (_shouldDebounce(key)) return;
      log('EVENT', 'expense:created received', data);
      triggerRefetch(['expenses', 'reports', 'dashboard']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('expense:updated', function (data) {
      var key = 'expense:updated:' + (data && data.id ? data.id : '');
      if (_shouldDebounce(key)) return;
      log('EVENT', 'expense:updated received', data);
      triggerRefetch(['expenses', 'reports', 'dashboard']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('expense:deleted', function (data) {
      var key = 'expense:deleted:' + (data && data.id ? data.id : '');
      if (_shouldDebounce(key)) return;
      log('EVENT', 'expense:deleted received', data);
      triggerRefetch(['expenses', 'reports', 'dashboard']);
      bcastSend('sync', { source: 'socket' });
    });

    _socket.on('report:updated', function (data) {
      var key = 'report:updated';
      if (_shouldDebounce(key)) return;
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
      log('PING', 'Server ping received', data);
    });
  }

  // ── Anti-duplicate debounce helper ─────────────────────────────────────────

  /**
   * Returns true if this event+key was received within EMIT_DEBOUNCE ms.
   * Used to prevent rapid-fire refetch from burst events on multiple tabs.
   * @param {string} key
   * @returns {boolean}
   */
  function _shouldDebounce(key) {
    var now = Date.now();
    if (_lastEmit[key] && (now - _lastEmit[key]) < EMIT_DEBOUNCE) {
      log('DEBOUNCE', 'Suppressing duplicate event: ' + key);
      return true;
    }
    _lastEmit[key] = now;
    return false;
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
      var toRefetch = Array.from(_pendingRefetch);
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
    try {
      var stored = localStorage.getItem('auth_token');
      if (stored) {
        var parsed = JSON.parse(stored);
        return parsed.token || stored;
      }
    } catch (e) { /* ignore */ }
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
   * Includes anti-duplicate debounce — same (event + key) within 1s is skipped.
   * @param {string} event
   * @param {object} data
   * @param {string} key - Optional dedup key
   */
  function emit(event, data, key) {
    if (!_socket || !_connected) {
      _pendingEvents.push({ name: event, data: data });
      log('WARN', 'Socket not connected — queued event: ' + event);
      return false;
    }
    if (key && _lastEmit[key] && (Date.now() - _lastEmit[key]) < EMIT_DEBOUNCE) {
      log('DEBOUNCE', 'Skipping duplicate emit: ' + event + ' (key=' + key + ')');
      return false;
    }
    if (key) _lastEmit[key] = Date.now();
    _socket.emit(event, data);
    return true;
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
      wsUrl: WS_URL,
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

  // ── Button Loading State Helpers (defined in layout.js, overridden here) ────────
  // `setButtonLoading` and `restoreButtonLoading` are defined EARLY in layout.js
  // and assigned to window before this script runs (realtime.js is deferred).
  // We re-assign them here so the IIFE-local references are consistent.
  // NOTE: `optimisticMutate` is the only function that lives inside the IIFE.

  /**
   * Optimistic mutate helper — executes request with optimistic UI,
   * emits realtime event on success, triggers refetch, handles rollback on error.
   * @param {object} opts
   * @param {function} opts.request - returns a Promise (the API call)
   * @param {function} [opts.applyOptimistic] - runs BEFORE server response
   * @param {function} [opts.rollback] - runs on error to undo optimistic change
   * @param {function} [opts.onSuccess] - runs after server responds successfully
   * @param {function} [opts.onError] - runs on error (after rollback)
   * @param {string} [opts.entity] - entity name for refetch routing (e.g. 'purchase', 'sale')
   * @param {*} [opts.data] - data to pass along with the emit event
   */
  function optimisticMutate(opts) {
    var entity = opts.entity || null;
    var data   = opts.data   || null;

    // Always run optimistic UI immediately
    if (typeof opts.applyOptimistic === 'function') {
      try { opts.applyOptimistic(); } catch (e) { console.error('[optimisticMutate] applyOptimistic error:', e); }
    }

    // Emit realtime event (only if entity is set)
    if (entity) {
      emit(entity, data);
    }

    // Fire the actual request
    opts.request()
      .then(function (result) {
        var parsed = result;
        if (result && typeof result.json === 'function') {
          parsed = result.clone ? result.clone() : result;
          return result.json().then(function (j) { return j; }).catch(function () { return parsed; });
        }
        return parsed;
      })
      .then(function (result) {
        if (typeof opts.onSuccess === 'function') {
          try { opts.onSuccess(result); } catch (e) { console.error('[optimisticMutate] onSuccess error:', e); }
        }
        // Trigger page-level refetch
        triggerRefetch(entity ? [entity] : ['all']);
        window.dispatchEvent(new CustomEvent('data:mutated', { detail: { entity: entity, source: 'optimisticMutate' } }));
      })
      .catch(function (err) {
        console.error('[optimisticMutate] request failed:', err);
        if (typeof opts.rollback === 'function') {
          try { opts.rollback(); } catch (e) { console.error('[optimisticMutate] rollback error:', e); }
        }
        if (typeof opts.onError === 'function') {
          try { opts.onError(err); } catch (e) { console.error('[optimisticMutate] onError error:', e); }
        }
      });
  }

  // ── Expose global API ───────────────────────────────────────────────────────

  window.Realtime = {
    connect:       connect,
    forceRefetch:  forceRefetch,
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
    // Expose WS_URL for external use
    WS_URL: WS_URL,
  };

  // ── Auto-initialize ────────────────────────────────────────────────────────

  /**
   * Wait for DOM + socket.io client to be ready, then connect.
   */
  function autoInit() {
    // ── OFFLINE / ONLINE HANDLERS ─────────────────────────────────────────
    // Detect when the device goes offline/online so we can log and react.

    window.addEventListener('offline', function () {
      _online = false;
      console.warn('[WS] Offline mode — socket will auto-reconnect when back online');
      log('OFFLINE', 'Network offline');
    });

    window.addEventListener('online', function () {
      _online = true;
      console.log('[WS] Back online, reconnecting...');
      log('ONLINE', 'Network back online');
      if (_socket && !_connected) {
        _socket.connect();
      }
    });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', doInit);
    } else {
      doInit();
    }
  }

  function checkSalesEmpty() {
    var container = document.getElementById('salesHistoryList');
    if (!container) return;
    var nav = container.querySelector('nav[role="navigation"]');
    var totalRow = container.querySelector('.history-total-row');
    var hasCards = container.querySelector('[data-sale-id]');
    if (!hasCards && !nav && !totalRow) {
      container.innerHTML = '<p class="text-muted text-center py-4">Chưa có hóa đơn nào</p>';
    }
  }

  function doInit() {
    // Wait for socket.io-client to be available
    if (typeof window.io === 'undefined') {
      // Load socket.io-client from the Socket.IO server endpoint
      var script = document.createElement('script');
      script.src = (window.BASE_PATH || '/') + 'socket.io/socket.io.js';
      script.onload = function () {
        log('INFO', 'Socket.IO client loaded from /socket.io/');
        connect();
      };
      script.onerror = function () {
        log('ERROR', 'Failed to load socket.io-client from /socket.io/');
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
    });

    log('INFO', 'BeerPOS Real-time client initialized (WS_URL=' + WS_URL + ')');
  }

  autoInit();

// These functions are defined EARLY in layout.js as direct `function` declarations
// (no IIFE wrapper) so they are available to all page scripts immediately after
// layout.js loads — before realtime.js even executes (realtime.js is deferred).
// Here in realtime.js we simply override them so they live in the same module scope.
// ──────────────────────────────────────────────────────────────────────────────

window.setButtonLoading = function setButtonLoading(button, loadingText) {
  if (!button) return null;
  var originalText = button.innerHTML;
  button.disabled = true;
  button.dataset.originalText = originalText;
  if (loadingText) {
    button.innerHTML = loadingText + '…';
  } else {
    button.innerHTML = '⏳…';
  }
  return { button: button };
};

window.restoreButtonLoading = function restoreButtonLoading(btnState) {
  if (!btnState || !btnState.button) return;
  var button = btnState.button;
  button.disabled = false;
  button.innerHTML = button.dataset.originalText || button.innerHTML;
};
  window.mutate = function mutate(requestFn, onSuccess, onError) {
    return optimisticMutate({
      request: requestFn,
      onSuccess: onSuccess,
      onError: onError
    });
  };
  window.optimisticMutate = optimisticMutate;
})();

// ── Global helpers (outside IIFE so they're accessible to other scripts) ──────
//
// NOTE: The three helpers above are defined INSIDE the IIFE above (not here)
// and are explicitly exported to window for cross-script access.
// Keeping this comment block here explains the structure and prevents
// accidental removal of the window assignments above.
