/**
 * BeerPOS - WebSocket Event Handler
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ REALTIME EVENTS - Nhận và xử lý events từ server
 *
 * Flow:
 * 1. Connect to WebSocket
 * 2. Receive EVENT_BROADCAST
 * 3. Check deduplication
 * 4. Save to event store
 * 5. Apply event locally
 * 6. Dispatch UI update
 *
 * ⭐ HARDENED:
 * - Exponential backoff (max 30s)
 * - Connection state guard (prevent duplicate connects)
 * - Fallback HTTP polling after WS failure
 * - Global error boundary
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function() {
  'use strict';

  let _socket = null;
  let _reconnectTimer = null;
  let _isConnected = false;
  let _isConnecting = false;
  let _listeners = new Set();
  let _eventHistory = new Map(); // eventId → timestamp
  const EVENT_HISTORY_TTL = 60000; // 1 minute

  // Config
  const MAX_RECONNECT_ATTEMPTS = 10;
  const BASE_RECONNECT_DELAY = 3000;
  const MAX_RECONNECT_DELAY = 30000;
  const HTTP_POLL_INTERVAL = 15000;  // Fallback HTTP poll when WS fails

  let _reconnectAttempts = 0;
  let _httpPollTimer = null;
  let _fallbackMode = false;

  // ── Connect ────────────────────────────────────────────────────────────────

  function connect() {
    // Guard: prevent duplicate connections
    if (_socket && (_socket.readyState === WebSocket.OPEN || _socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (_isConnecting) {
      console.log('[WS] Already connecting, skipping duplicate connect');
      return;
    }

    // Exit fallback mode if attempting reconnect
    _stopFallbackPoll();

    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }

    const wsUrl = _getWebSocketUrl();
    console.log('[WS] Connecting to:', wsUrl);
    _isConnecting = true;

    try {
      _socket = new WebSocket(wsUrl);

      _socket.onopen = _onOpen;
      _socket.onmessage = _onMessage;
      _socket.onclose = _onClose;
      _socket.onerror = _onError;

    } catch (error) {
      console.error('[WS] Connection error:', error);
      _isConnecting = false;
      _scheduleReconnect();
    }
  }

  function _getWebSocketUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return `${protocol}//${host}`;
  }

  function _onOpen() {
    console.log('[WS] Connected');
    _isConnected = true;
    _isConnecting = false;
    _reconnectAttempts = 0;

    // Send join message
    _send({
      type: 'JOIN',
      deviceId: _getDeviceId(),
    });

    _emit('connected', {});
  }

  function _onMessage(event) {
    try {
      const data = JSON.parse(event.data);
      _handleMessage(data);
    } catch (error) {
      console.error('[WS] Message parse error:', error);
    }
  }

  function _onClose(event) {
    console.log('[WS] Disconnected:', event.code, event.reason);
    _isConnected = false;
    _isConnecting = false;
    _emit('disconnected', { code: event.code, reason: event.reason });
    _scheduleReconnect();
  }

  function _onError(error) {
    console.error('[WS] Error:', error);
    _isConnecting = false;
    _emit('error', { error });
  }

  // ── Reconnect ─────────────────────────────────────────────────────────────

  function _scheduleReconnect() {
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }

    if (_reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('[WS] Max reconnect attempts reached — switching to HTTP fallback');
      _emit('max_attempts', {});
      _startFallbackPoll();
      return;
    }

    // Exponential backoff: 3s, 4.5s, 6.75s, ... capped at 30s
    const delay = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(1.5, _reconnectAttempts),
      MAX_RECONNECT_DELAY
    );
    console.log(`[WS] Reconnecting in ${Math.round(delay)}ms (attempt ${_reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);

    _reconnectTimer = setTimeout(() => {
      _reconnectAttempts++;
      connect();
    }, delay);
  }

  // ── Fallback HTTP Polling ─────────────────────────────────────────────────

  function _startFallbackPoll() {
    if (_httpPollTimer || _fallbackMode) return;
    _fallbackMode = true;
    console.log('[WS] Starting HTTP fallback polling');

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
      const response = await fetch('/api/sync-events/delta', {
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (!response.ok) return;

      const data = await response.json();
      if (data.success && data.events && data.events.length > 0) {
        console.log(`[WS] Fallback poll received ${data.events.length} events`);
        for (const event of data.events) {
          if (window.EventStore) {
            try {
              await window.EventStore.receiveEvent(event);
            } catch (e) {
              console.error('[WS] Fallback apply event error:', e);
            }
          }
        }
        _emit('events_received', { count: data.events.length });
      }
    } catch (err) {
      // Silent — fallback poll should not spam console
    }
  }

  // ── Handle Messages ───────────────────────────────────────────────────────

  function _handleMessage(data) {
    const { type, payload } = data;

    switch (type) {
      case 'EVENT_BROADCAST':
        _handleEventBroadcast(payload);
        break;

      case 'EVENT_ACK':
        _handleEventAck(payload);
        break;

      case 'FULL_STATE':
        _handleFullState(payload);
        break;

      case 'PING':
        _send({ type: 'PONG' });
        break;

      case 'ERROR':
        console.warn('[WS] Server error:', payload);
        _emit('server_error', payload);
        break;

      default:
        console.log('[WS] Unknown message type:', type);
    }
  }

  async function _handleEventBroadcast(payload) {
    const { eventId, type, entity, entityId, payload: eventPayload, deviceId, timestamp } = payload;

    // Skip if from this device
    if (deviceId === _getDeviceId()) {
      return;
    }

    // Check deduplication
    if (_isDuplicate(eventId)) {
      return;
    }

    // Mark as seen
    _markSeen(eventId);

    console.log(`[WS] Received event: ${type}`, { eventId, entityId });

    // Receive event
    if (window.EventStore) {
      try {
        const result = await window.EventStore.receiveEvent({
          id: eventId,
          type,
          payload: eventPayload,
          deviceId,
          timestamp,
        });

        if (result.success) {
          _emit('event_received', { type, entityId });
        }
      } catch (err) {
        console.error('[WS] handleEventBroadcast error:', err);
      }
    }
  }

  function _handleEventAck(payload) {
    const { eventId, success, error } = payload;
    console.log(`[WS] Event ack: ${eventId}`, { success, error });
    _emit('event_ack', { eventId, success, error });
  }

  async function _handleFullState(payload) {
    console.log('[WS] Received full state');

    if (window.ApplyEvent) {
      const { orders, customers, products, expenses } = payload;

      if (orders?.length) {
        for (const order of orders) {
          try {
            await window.EventStore?.receiveEvent({
              id: order.id,
              type: 'ORDER_CREATED',
              payload: order,
              deviceId: 'server',
              timestamp: order.createdAt,
            });
          } catch (e) { /* skip */ }
        }
      }
    }

    _emit('full_state_received', payload);
  }

  // ── Send Messages ─────────────────────────────────────────────────────────

  function _send(data) {
    if (!_socket || _socket.readyState !== WebSocket.OPEN) {
      console.warn('[WS] Not connected, cannot send:', data.type);
      return false;
    }

    try {
      _socket.send(JSON.stringify(data));
      return true;
    } catch (error) {
      console.error('[WS] Send error:', error);
      return false;
    }
  }

  // ── Emit Events ───────────────────────────────────────────────────────────

  function _emit(event, data) {
    for (const listener of _listeners) {
      try {
        listener(event, data);
      } catch (error) {
        console.error('[WS] Listener error:', error);
      }
    }

    window.dispatchEvent(new CustomEvent('ws:' + event, { detail: data }));
  }

  function addListener(callback) {
    _listeners.add(callback);
    return () => _listeners.delete(callback);
  }

  // ── Deduplication ─────────────────────────────────────────────────────────

  function _isDuplicate(eventId) {
    const seen = _eventHistory.get(eventId);
    if (seen && Date.now() - seen < EVENT_HISTORY_TTL) {
      return true;
    }
    return false;
  }

  function _markSeen(eventId) {
    _eventHistory.set(eventId, Date.now());

    // Cleanup old entries
    if (_eventHistory.size > 1000) {
      const now = Date.now();
      for (const [id, timestamp] of _eventHistory) {
        if (now - timestamp > EVENT_HISTORY_TTL) {
          _eventHistory.delete(id);
        }
      }
    }
  }

  // ── Device ID ─────────────────────────────────────────────────────────────

  function _getDeviceId() {
    let id = localStorage.getItem('beerpos_device_id_v3');
    if (!id) {
      id = _generateUUID();
      localStorage.setItem('beerpos_device_id_v3', id);
    }
    return id;
  }

  function _generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ── Status ───────────────────────────────────────────────────────────────

  function getStatus() {
    return {
      isConnected: _isConnected,
      isConnecting: _isConnecting,
      readyState: _socket?.readyState,
      reconnectAttempts: _reconnectAttempts,
      fallbackMode: _fallbackMode,
    };
  }

  function disconnect() {
    _stopFallbackPoll();
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
    if (_socket) {
      _socket.close();
      _socket = null;
    }
    _isConnected = false;
    _isConnecting = false;
  }

  // ── Export ───────────────────────────────────────────────────────────────

  const WebSocketClient = {
    connect,
    disconnect,
    send: _send,
    addListener,
    getStatus,
  };

  window.WebSocketClient = WebSocketClient;

  console.log('[WS] WebSocketClient loaded');

})();
