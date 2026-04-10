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
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function() {
  'use strict';

  let _socket = null;
  let _reconnectTimer = null;
  let _isConnected = false;
  let _listeners = new Set();
  let _eventHistory = new Map(); // eventId → timestamp
  const EVENT_HISTORY_TTL = 60000; // 1 minute

  // Config
  const RECONNECT_DELAY = 3000;
  const MAX_RECONNECT_ATTEMPTS = 10;

  let _reconnectAttempts = 0;

  // ── Connect ─────────────────────────────────────────────────────────

  function connect() {
    if (_socket) {
      _socket.close();
    }

    const wsUrl = _getWebSocketUrl();
    console.log('[WS] Connecting to:', wsUrl);

    try {
      _socket = new WebSocket(wsUrl);

      _socket.onopen = _onOpen;
      _socket.onmessage = _onMessage;
      _socket.onclose = _onClose;
      _socket.onerror = _onError;

    } catch (error) {
      console.error('[WS] Connection error:', error);
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
    _reconnectAttempts = 0;

    // Send join message
    send({
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
    _emit('disconnected', { code: event.code, reason: event.reason });
    _scheduleReconnect();
  }

  function _onError(error) {
    console.error('[WS] Error:', error);
    _emit('error', { error });
  }

  // ── Reconnect ───────────────────────────────────────────────────────

  function _scheduleReconnect() {
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
    }

    if (_reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('[WS] Max reconnect attempts reached');
      _emit('max_attempts', {});
      return;
    }

    const delay = RECONNECT_DELAY * Math.pow(1.5, _reconnectAttempts);
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${_reconnectAttempts + 1})`);

    _reconnectTimer = setTimeout(() => {
      _reconnectAttempts++;
      connect();
    }, delay);
  }

  // ── Handle Messages ─────────────────────────────────────────────────

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
    }
  }

  function _handleEventAck(payload) {
    const { eventId, success, error } = payload;
    console.log(`[WS] Event ack: ${eventId}`, { success, error });
    _emit('event_ack', { eventId, success, error });
  }

  async function _handleFullState(payload) {
    console.log('[WS] Received full state');
    
    // Apply full state to local DB
    if (window.ApplyEvent) {
      // Full state handling
      const { orders, customers, products, expenses } = payload;

      // Apply entities
      if (orders?.length) {
        for (const order of orders) {
          await window.EventStore?.receiveEvent({
            id: order.id,
            type: 'ORDER_CREATED',
            payload: order,
            deviceId: 'server',
            timestamp: order.createdAt,
          });
        }
      }

      // ... similar for other entities
    }

    _emit('full_state_received', payload);
  }

  // ── Send Messages ───────────────────────────────────────────────────

  function send(data) {
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

  // ── Emit Events ────────────────────────────────────────────────────

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

  // ── Deduplication ──────────────────────────────────────────────────

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

  // ── Device ID ──────────────────────────────────────────────────────

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

  // ── Status ───────────────────────────────────────────────────────

  function getStatus() {
    return {
      isConnected: _isConnected,
      readyState: _socket?.readyState,
      reconnectAttempts: _reconnectAttempts,
    };
  }

  function disconnect() {
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
    }
    if (_socket) {
      _socket.close();
      _socket = null;
    }
  }

  // ── Export ───────────────────────────────────────────────────────

  const WebSocketClient = {
    connect,
    disconnect,
    send,
    addListener,
    getStatus,
  };

  window.WebSocketClient = WebSocketClient;

  console.log('[WS] WebSocketClient loaded');

})();
