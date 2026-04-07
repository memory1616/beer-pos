/**
 * BeerPOS Socket Singleton
 * ─────────────────────────────────────────────────────────────────────────────
 * Ensures only ONE Socket.IO connection exists across the entire app.
 * Call getSocket() from any module — always returns the same instance.
 *
 * Config:
 *   - Transport: polling first (more reliable behind nginx/proxy),
 *     then upgrade to websocket
 *   - Reconnection: up to 10 attempts with exponential backoff
 *   - Auth: token from cookie or localStorage
 *   - Offline: queues events while disconnected, replays on reconnect
 *
 * Usage:
 *   import { getSocket, getSocketStatus } from '/js/socketSingleton.js';
 *
 *   const socket = getSocket();
 *   socket.on('order:created', (data) => { ... });
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // ── Config ─────────────────────────────────────────────────────────────────

  const WS_URL = (function () {
    // Match the admin domain used by nginx proxy
    var host = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
    if (host === 'admin.biatuoitayninh.store') {
      return 'https://admin.biatuoitayninh.store';
    }
    if (host === 'biatuoitayninh.store') {
      return 'https://biatuoitayninh.store';
    }
    // Development / localhost — connect to same origin
    return window.location.origin;
  })();

  const RECONNECT_OPTS = {
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    timeout: 20000,
  };

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

  // ── Singleton ───────────────────────────────────────────────────────────────

  var _socket     = null;
  var _connected  = false;
  var _connecting  = false;
  var _pendingEvents = [];
  var _debug       = false;
  var _initGuard   = false;

  // Anti-duplicate emit map: key → timestamp of last emit
  var _lastEmit   = {};

  function log(tag, msg, data) {
    if (!_debug && tag !== 'INFO' && tag !== 'CONNECT' && tag !== 'DISCONNECT' &&
        tag !== 'ERROR' && tag !== 'OFFLINE') return;
    var prefix = '[WS][Singleton]';
    if (data !== undefined) {
      console.log(prefix + ' [' + tag + '] ' + msg, data);
    } else {
      console.log(prefix + ' [' + tag + '] ' + msg);
    }
  }

  function getSocket(opts) {
    if (_socket) return _socket;

    var io = window.io;
    if (typeof io !== 'function') {
      log('WARN', 'socket.io-client not available — will retry when loaded');
      // Retry once socket.io is ready
      setTimeout(function() { getSocket(opts); }, 500);
      return null;
    }

    // Global guard — prevent double initialization
    if (typeof window !== 'undefined' && window.__BEERPOS_SOCKET__) {
      log('WARN', '__BEERPOS_SOCKET__ guard already set — skipping');
      return null;
    }
    if (typeof window !== 'undefined') {
      window.__BEERPOS_SOCKET__ = true;
    }

    _connecting = true;

    var mode = (window.APP_MODE === 'public') ? 'public' : 'admin';

    log('INFO', 'Creating singleton socket to: ' + WS_URL + ' (mode=' + mode + ')');

    _socket = io(WS_URL, Object.assign({}, RECONNECT_OPTS, {
      transports: ['polling', 'websocket'],
      auth: { token: getAuthToken() },
      query: { mode: mode },
    }));

    _connecting = false;

    // ── Connection lifecycle ──────────────────────────────────────────────

    _socket.on('connect', function () {
      _connected = true;
      log('CONNECT', 'Connected: ' + _socket.id);

      // Replay queued events
      if (_pendingEvents.length > 0) {
        log('INFO', 'Replaying ' + _pendingEvents.length + ' queued events');
        _pendingEvents.forEach(function (ev) {
          _socket.emit(ev.name, ev.data);
        });
        _pendingEvents = [];
      }
    });

    _socket.on('disconnect', function (reason) {
      _connected = false;
      log('DISCONNECT', 'Disconnected: ' + reason);
    });

    _socket.on('connect_error', function (err) {
      log('ERROR', 'Connect error: ' + (err ? err.message : 'unknown'));
    });

    _socket.on('connect_timeout', function () {
      log('ERROR', 'Connect timeout after 20s');
    });

    _socket.on('reconnect_attempt', function (attempt) {
      log('INFO', 'Reconnect attempt ' + attempt + '/' + RECONNECT_OPTS.reconnectionAttempts);
    });

    _socket.on('reconnect_failed', function () {
      log('ERROR', 'Reconnect failed after ' + RECONNECT_OPTS.reconnectionAttempts + ' attempts — will keep trying');
    });

    _socket.on('reconnect', function (attempt) {
      log('CONNECT', 'Reconnected after attempt ' + attempt);
      _connected = true;
    });

    _socket.on('error', function (err) {
      log('ERROR', 'Socket error', err);
    });

    return _socket;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Get the singleton socket instance. Creates it on first call.
   * @param {object} opts - Optional extra options (merged with defaults)
   * @returns {Socket|null}
   */
  window.getSocket = getSocket;

  /**
   * Check if socket is currently connected.
   * @returns {boolean}
   */
  window.isSocketConnected = function () {
    return _connected && _socket && _socket.connected;
  };

  /**
   * Get full socket status.
   * @returns {{ connected: boolean, id: string|null, pending: number }}
   */
  window.getSocketStatus = function () {
    return {
      connected: _connected && _socket && _socket.connected,
      id: _socket ? _socket.id : null,
      pending: _pendingEvents.length,
      url: WS_URL,
    };
  };

  /**
   * Emit an event with anti-duplicate debounce.
   * Skips emit if the same (event + key) was emitted within `minInterval` ms.
   *
   * @param {string} event - Event name
   * @param {object} data  - Payload
   * @param {string} key   - Dedup key (e.g. 'sale_123')
   * @param {number} minInterval - Minimum ms between emits (default 1000)
   */
  window.socketEmit = function (event, data, key, minInterval) {
    if (!_socket || !_connected) {
      log('WARN', 'Socket not connected — queueing: ' + event);
      _pendingEvents.push({ name: event, data: data });
      return false;
    }

    var interval = minInterval || 1000;
    var now = Date.now();
    if (key && _lastEmit[key] && (now - _lastEmit[key]) < interval) {
      log('SKIP', 'Debouncing emit: ' + event + ' (key=' + key + ')');
      return false;
    }

    if (key) _lastEmit[key] = now;
    _socket.emit(event, data);
    log('EMIT', 'Emitted: ' + event, data);
    return true;
  };

  /**
   * Enable/disable debug logging.
   * @param {boolean} enabled
   */
  window.socketSetDebug = function (enabled) {
    _debug = !!enabled;
  };

  /**
   * Manually disconnect (rarely needed).
   */
  window.socketDisconnect = function () {
    if (_socket) {
      _socket.disconnect();
      _connected = false;
    }
  };

  /**
   * Reconnect after manual disconnect.
   */
  window.socketReconnect = function () {
    if (_socket && !_connected) {
      _socket.connect();
    }
  };

  // ── Offline / Online handlers ────────────────────────────────────────────────

  if (typeof window !== 'undefined') {
    window.addEventListener('offline', function () {
      _connected = false;
      log('OFFLINE', 'Network offline — socket will auto-reconnect when back online');
    });

    window.addEventListener('online', function () {
      log('ONLINE', 'Network back online');
      if (_socket && !_connected) {
        _socket.connect();
      }
    });
  }

  // ── Cleanup old connections before creating new ─────────────────────────────
  // (Redundant guard — kept for safety in case of hot-reload or in-page navigation)

  if (typeof window !== 'undefined') {
    var _prev = window.__BEERPOS_SOCKET__;
    if (_prev && _socket) {
      log('WARN', 'Page reloaded while socket existed — disconnecting old instance');
      _socket.disconnect();
      _socket = null;
      _connected = false;
    }
  }

})();
