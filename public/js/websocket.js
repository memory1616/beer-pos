/**
 * BeerPOS - WebSocket Client v4 (Socket.IO + HTTP Fallback)
 * ─────────────────────────────────────────────────────────────────────────────
 * CRITICAL FIX: 后端使用 Socket.IO 服务器，原生 WebSocket 无法连接。
 * 本文件改用 Socket.IO 客户端与后端通信。
 *
 * 功能：
 * 1. Socket.IO 连接（支持 websocket 和 polling 传输）
 * 2. 指数退避重连（3s → 4.5s → 6.75s → ... 最大 30s）
 * 3. 5次重连失败后自动切换到 HTTP fallback polling
 * 4. WebSocket 可选 — 即使连接失败，UI 和 Sync 仍然正常工作
 * 5. 防重复连接保护
 *
 * 与 offline-store.js 的接口（保持向后兼容）：
 * - window.WebSocketClient.connect()
 * - window.WebSocketClient.disconnect()
 * - window.WebSocketClient.send(data)
 * - window.WebSocketClient.addListener(callback)
 * - window.WebSocketClient.getStatus()
 *
 * 向外发送的事件（与原版保持一致）：
 * - window.dispatchEvent(new CustomEvent('ws:connected', ...))
 * - window.dispatchEvent(new CustomEvent('ws:disconnected', ...))
 * - window.dispatchEvent(new CustomEvent('ws:error', ...))
 * - window.dispatchEvent(new CustomEvent('ws:events_received', ...))
 * - window.dispatchEvent(new CustomEvent('ws:event_received', ...))
 * - window.dispatchEvent(new CustomEvent('ws:max_attempts', ...))
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function() {
  'use strict';

  // ── Guards ────────────────────────────────────────────────────────────────

  if (typeof window !== 'undefined' && window.__BEERPOS_WSC__) {
    console.log('[WS] WebSocketClient already initialized, skipping');
    return;
  }
  if (typeof window !== 'undefined') {
    window.__BEERPOS_WSC__ = true;
  }

  // ── Config ────────────────────────────────────────────────────────────────

  const MAX_RECONNECT_ATTEMPTS = 5;
  const BASE_RECONNECT_DELAY   = 3000;
  const MAX_RECONNECT_DELAY   = 30000;
  const HTTP_POLL_INTERVAL    = 15000;  // Fallback HTTP polling interval
  const EVENT_HISTORY_TTL      = 60000; // 1 minute deduplication window

  // Socket.IO reconnect: we manage it manually for full control
  const SOCKET_IO_RECONNECT_MAX = 3;   // Give Socket.IO 3 tries, then we take over
  const SOCKET_IO_TIMEOUT      = 20000;

  // ── WS URL ────────────────────────────────────────────────────────────────

  var _wsUrl = (function () {
    var host = (window.location && window.location.hostname) || '';
    if (host === 'admin.biatuoitayninh.store') return 'https://admin.biatuoitayninh.store';
    if (host === 'biatuoitayninh.store')       return 'https://biatuoitayninh.store';
    return window.location.origin;
  })();

  // ── State ─────────────────────────────────────────────────────────────────

  var _socket             = null;
  var _io                 = null;       // Socket.IO constructor
  var _reconnectAttempts  = 0;
  var _isConnected       = false;
  var _isConnecting      = false;
  var _fallbackMode      = false;
  var _httpPollTimer     = null;
  var _reconnectTimer     = null;
  var _listeners         = [];
  var _eventHistory       = {};         // eventId → timestamp
  var _initCalled        = false;
  var _socketIoLoaded    = false;
  var _socketIoLoading   = false;
  var _deviceId          = null;

  // ── Device ID ─────────────────────────────────────────────────────────────

  function getDeviceId() {
    if (_deviceId) return _deviceId;
    var stored = localStorage.getItem('beerpos_device_id_v3');
    if (stored) {
      _deviceId = stored;
    } else {
      _deviceId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
      localStorage.setItem('beerpos_device_id_v3', _deviceId);
    }
    return _deviceId;
  }

  // ── Emit to internal listeners + window events ─────────────────────────────

  function emit(event, data) {
    _listeners.forEach(function(cb) {
      try { cb(event, data); } catch(e) { console.error('[WS] Listener error:', e); }
    });
    window.dispatchEvent(new CustomEvent('ws:' + event, { detail: data || {} }));
  }

  // ── Load Socket.IO Client ──────────────────────────────────────────────────

  var _socketIoCbs = [];

  function loadSocketIO(cb) {
    if (typeof window.io === 'function') {
      _io = window.io;
      _socketIoLoaded = true;
      cb();
      return;
    }
    // Queue callback if already loading
    _socketIoCbs.push(cb);
    if (_socketIoLoading) return;
    _socketIoLoading = true;

    var script = document.createElement('script');
    script.src = _wsUrl + '/socket.io/socket.io.js';
    script.onload = function() {
      _io = window.io;
      _socketIoLoaded = true;
      console.log('[WS] Socket.IO client loaded from', _wsUrl);
      // Fire all queued callbacks
      while (_socketIoCbs.length) {
        try { _socketIoCbs.shift()(); } catch(e) { console.error(e); }
      }
    };
    script.onerror = function() {
      console.error('[WS] Failed to load Socket.IO client from', _wsUrl);
      console.log('[WS] Switching to HTTP fallback mode');
      _startFallbackPoll();
      // Fire callbacks with error
      while (_socketIoCbs.length) {
        try { _socketIoCbs.shift()(); } catch(e) { /* ignore */ }
      }
    };
    document.head.appendChild(script);
  }

  // ── Connect ────────────────────────────────────────────────────────────────

  function connect() {
    // Guard: prevent duplicate init
    if (_initCalled) {
      console.log('[WS] Already initialized, skipping connect()');
      return;
    }
    _initCalled = true;

    // Exit any running fallback
    _stopFallbackPoll();

    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }

    _isConnecting = true;
    console.log('[WS] Connecting to:', _wsUrl);

    loadSocketIO(function() {
      _doConnect();
    });
  }

  function _doConnect() {
    if (!_io) {
      console.error('[WS] Socket.IO not available, falling back to HTTP polling');
      _startFallbackPoll();
      return;
    }

    // Disconnect existing socket if any (e.g. from hot-reload)
    if (_socket) {
      try { _socket.disconnect(); } catch(e) { /* ignore */ }
      _socket = null;
    }

    var mode = (window.APP_MODE === 'public') ? 'public' : 'admin';

    _socket = _io(_wsUrl, {
      // Prefer WebSocket first, fall back to HTTP polling if proxy blocks upgrade.
      // Nginx now has Upgrade headers on /socket.io/ so WebSocket should work.
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: SOCKET_IO_RECONNECT_MAX,
      reconnectionDelay: BASE_RECONNECT_DELAY,
      reconnectionDelayMax: MAX_RECONNECT_DELAY,
      timeout: SOCKET_IO_TIMEOUT,
      upgrade: true,
      query: { mode: mode },
      auth: { token: _getAuthToken() },
    });

    // ── Lifecycle ──────────────────────────────────────────────────────────

    _socket.on('connect', function() {
      _isConnected = true;
      _isConnecting = false;
      _reconnectAttempts = 0;
      console.log('[WS] Connected:', _socket.id);

      // JOIN message (backward compatible)
      _send({
        type: 'JOIN',
        deviceId: getDeviceId(),
      });

      emit('connected', { socketId: _socket.id });
    });

    _socket.on('disconnect', function(reason) {
      _isConnected = false;
      _isConnecting = false;
      console.warn('[WS] Disconnected:', reason);
      emit('disconnected', { reason: reason });
      _scheduleReconnect();
    });

    _socket.on('connect_error', function(err) {
      _isConnecting = false;
      console.error('[WS] Connect error:', err ? err.message : 'unknown');
      emit('error', { error: err ? err.message : 'connection error' });
    });

    _socket.on('connect_timeout', function() {
      console.warn('[WS] Connect timeout');
      _isConnecting = false;
    });

    // Socket.IO internal reconnect events — we track them for our own counter
    _socket.on('reconnect_attempt', function(attempt) {
      console.log('[WS] Socket.IO reconnect attempt:', attempt);
    });

    _socket.on('reconnect', function(attempt) {
      _isConnected = true;
      _isConnecting = false;
      _reconnectAttempts = 0;
      console.log('[WS] Reconnected after attempt', attempt);
      emit('connected', {});
    });

    _socket.on('reconnect_failed', function() {
      console.warn('[WS] Socket.IO reconnect failed — will use manual reconnect with backoff');
    });

    _socket.on('error', function(err) {
      console.error('[WS] Socket error:', err);
      emit('error', { error: err });
    });

    // ── Server → Client events ──────────────────────────────────────────────

    _socket.on('EVENT_BROADCAST', function(data) {
      _handleEventBroadcast(data);
    });

    _socket.on('EVENT_ACK', function(data) {
      _handleEventAck(data);
    });

    _socket.on('FULL_STATE', function(data) {
      _handleFullState(data);
    });

    _socket.on('PING', function() {
      _send({ type: 'PONG' });
    });

    _socket.on('ERROR', function(payload) {
      console.warn('[WS] Server error:', payload);
      emit('server_error', payload);
    });

    // Socket.IO named events (from socketServer.js)
    _socket.on('order:created', function(data) {
      console.log('[WS] order:created received');
      emit('event_received', { type: 'order:created', data: data });
      _applyRemoteEvent(data, 'ORDER_CREATED');
    });

    _socket.on('order:updated', function(data) {
      console.log('[WS] order:updated received');
      emit('event_received', { type: 'order:updated', data: data });
      _applyRemoteEvent(data, 'ORDER_UPDATED');
    });

    _socket.on('order:deleted', function(data) {
      console.log('[WS] order:deleted received');
      emit('event_received', { type: 'order:deleted', data: data });
    });

    _socket.on('inventory:updated', function(data) {
      console.log('[WS] inventory:updated received');
      emit('event_received', { type: 'inventory:updated', data: data });
    });

    _socket.on('customer:updated', function(data) {
      console.log('[WS] customer:updated received');
      emit('event_received', { type: 'customer:updated', data: data });
    });

    _socket.on('expense:created', function(data) {
      console.log('[WS] expense:created received');
      emit('event_received', { type: 'expense:created', data: data });
      _applyRemoteEvent(data, 'EXPENSE_CREATED');
    });

    _socket.on('expense:updated', function(data) {
      console.log('[WS] expense:updated received');
      emit('event_received', { type: 'expense:updated', data: data });
    });

    _socket.on('expense:deleted', function(data) {
      console.log('[WS] expense:deleted received');
      emit('event_received', { type: 'expense:deleted', data: data });
    });

    _socket.on('report:updated', function(data) {
      console.log('[WS] report:updated received');
      emit('event_received', { type: 'report:updated', data: data });
    });

    _socket.on('refetch:now', function(data) {
      console.log('[WS] refetch:now received');
      emit('refetch', { entities: data && data.entities ? data.entities : ['all'] });
    });

    // Generic connected event (from socketServer.js)
    _socket.on('connected', function(data) {
      console.log('[WS] Server confirmed connection:', data);
    });
  }

  // ── Reconnect ─────────────────────────────────────────────────────────────

  function _scheduleReconnect() {
    if (_fallbackMode) return;  // Already in fallback, don't schedule more WS attempts

    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }

    if (_reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('[WS] Max reconnect attempts reached — switching to HTTP fallback polling');
      emit('max_attempts', {});
      _startFallbackPoll();
      return;
    }

    // Exponential backoff: 3s, 4.5s, 6.75s, ... capped at 30s
    var delay = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(1.5, _reconnectAttempts),
      MAX_RECONNECT_DELAY
    );
    console.log('[WS] Reconnecting in ' + Math.round(delay) + 'ms (attempt ' + (_reconnectAttempts + 1) + '/' + MAX_RECONNECT_ATTEMPTS + ')');

    _reconnectTimer = setTimeout(function() {
      _reconnectAttempts++;
      _isConnecting = true;
      if (_io) {
        _doConnect();
      } else {
        // Socket.IO not loaded, reload it
        loadSocketIO(function() { _doConnect(); });
      }
    }, delay);
  }

  // ── HTTP Fallback Polling ──────────────────────────────────────────────────

  function _startFallbackPoll() {
    if (_httpPollTimer || _fallbackMode) return;
    _fallbackMode = true;
    console.log('[WS] Starting HTTP fallback polling (every ' + HTTP_POLL_INTERVAL + 'ms)');

    _doFallbackPoll();
    _httpPollTimer = setInterval(_doFallbackPoll, HTTP_POLL_INTERVAL);
  }

  function _stopFallbackPoll() {
    if (_httpPollTimer) {
      clearInterval(_httpPollTimer);
      _httpPollTimer = null;
    }
    if (_fallbackMode) {
      _fallbackMode = false;
      console.log('[WS] HTTP fallback polling stopped');
    }
  }

  async function _doFallbackPoll() {
    if (!navigator.onLine) return;
    try {
      var response = await fetch('/api/sync-events/delta', {
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (!response.ok) return;

      var data = await response.json();
      if (data.success && data.events && data.events.length > 0) {
        console.log('[WS] Fallback poll received ' + data.events.length + ' events');
        for (var i = 0; i < data.events.length; i++) {
          var evt = data.events[i];
          if (window.EventStore) {
            try {
              await window.EventStore.receiveEvent(evt);
            } catch(e) {
              console.error('[WS] Fallback apply event error:', e);
            }
          }
        }
        emit('events_received', { count: data.events.length });
      }
    } catch(err) {
      // Silent — fallback poll should not spam console
    }
  }

  // ── Handle Events ──────────────────────────────────────────────────────────

  function _handleEventBroadcast(payload) {
    if (!payload) return;

    var eventId   = payload.eventId;
    var type      = payload.type;
    var deviceId  = payload.deviceId;
    var timestamp = payload.timestamp;
    var eventPayload = payload.payload;

    // Skip own events
    if (deviceId === getDeviceId()) return;

    // Deduplication
    if (_isDuplicate(eventId)) return;
    _markSeen(eventId);

    console.log('[WS] Received event:', type, { eventId: eventId, entityId: payload.entityId });

    if (window.EventStore) {
      try {
        var result = window.EventStore.receiveEvent({
          id: eventId,
          type: type,
          payload: eventPayload,
          deviceId: deviceId,
          timestamp: timestamp,
        });

        // Handle async result
        if (result && typeof result.then === 'function') {
          result.then(function(r) {
            if (r && r.success) {
              emit('event_received', { type: type, entityId: payload.entityId });
            }
          }).catch(function(err) {
            console.error('[WS] handleEventBroadcast error:', err);
          });
        } else if (result && result.success) {
          emit('event_received', { type: type, entityId: payload.entityId });
        }
      } catch(err) {
        console.error('[WS] handleEventBroadcast error:', err);
      }
    }
  }

  function _handleEventAck(payload) {
    if (!payload) return;
    console.log('[WS] Event ack:', payload.eventId, { success: payload.success, error: payload.error });
    emit('event_ack', { eventId: payload.eventId, success: payload.success, error: payload.error });
  }

  async function _handleFullState(payload) {
    console.log('[WS] Received full state');
    if (!payload || !window.ApplyEvent) return;

    var orders = payload.orders;
    if (orders && orders.length) {
      for (var i = 0; i < orders.length; i++) {
        var order = orders[i];
        if (window.EventStore) {
          try {
            await window.EventStore.receiveEvent({
              id: order.id,
              type: 'ORDER_CREATED',
              payload: order,
              deviceId: 'server',
              timestamp: order.createdAt,
            });
          } catch(e) { /* skip */ }
        }
      }
    }
    emit('full_state_received', payload);
  }

  // Apply remote events to local state
  function _applyRemoteEvent(data, eventType) {
    if (!data || !data.sale || !window.EventStore) return;
    var sale = data.sale;
    window.EventStore.receiveEvent({
      id: sale.id || ('remote_' + Date.now()),
      type: eventType,
      payload: sale,
      deviceId: 'remote',
      timestamp: sale.createdAt || Date.now(),
    });
  }

  // ── Send ───────────────────────────────────────────────────────────────────

  function _send(data) {
    if (!_socket || !_socket.connected) {
      console.warn('[WS] Not connected, cannot send:', data.type);
      return false;
    }
    try {
      _socket.emit(data.type, data);
      return true;
    } catch(error) {
      console.error('[WS] Send error:', error);
      return false;
    }
  }

  // ── Auth Token ─────────────────────────────────────────────────────────────

  function _getAuthToken() {
    try {
      var stored = localStorage.getItem('auth_token');
      if (stored) {
        var parsed = JSON.parse(stored);
        return parsed.token || stored;
      }
    } catch(e) { /* ignore */ }
    var match = document.cookie && document.cookie.match && document.cookie.match(/session_token=([^;]+)/);
    if (match) return match[1];
    return null;
  }

  // ── Deduplication ──────────────────────────────────────────────────────────

  function _isDuplicate(eventId) {
    if (!eventId) return false;
    var seen = _eventHistory[eventId];
    if (seen && (Date.now() - seen) < EVENT_HISTORY_TTL) return true;
    return false;
  }

  function _markSeen(eventId) {
    if (!eventId) return;
    _eventHistory[eventId] = Date.now();
    // Cleanup old entries
    var keys = Object.keys(_eventHistory);
    if (keys.length > 1000) {
      var now = Date.now();
      for (var i = 0; i < keys.length; i++) {
        if (now - _eventHistory[keys[i]] > EVENT_HISTORY_TTL) {
          delete _eventHistory[keys[i]];
        }
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function addListener(callback) {
    _listeners.push(callback);
    return function() {
      var idx = _listeners.indexOf(callback);
      if (idx !== -1) _listeners.splice(idx, 1);
    };
  }

  function getStatus() {
    return {
      isConnected: _isConnected,
      isConnecting: _isConnecting,
      fallbackMode: _fallbackMode,
      reconnectAttempts: _reconnectAttempts,
      maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
      wsUrl: _wsUrl,
    };
  }

  function disconnect() {
    _stopFallbackPoll();
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
    if (_socket) {
      _socket.disconnect();
      _socket = null;
    }
    _isConnected = false;
    _isConnecting = false;
    _reconnectAttempts = 0;
    console.log('[WS] Disconnected manually');
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  window.WebSocketClient = {
    connect:     connect,
    disconnect:  disconnect,
    send:        _send,
    addListener: addListener,
    getStatus:   getStatus,
  };

  console.log('[WS] WebSocketClient v4 loaded (Socket.IO + HTTP fallback)');

})();
