/**
 * BeerPOS - Event Store v5 (Optimized)
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ OPTIMIZED:
 * - Bulk event creation
 * - Batch processing
 * - Efficient deduplication
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function() {
  'use strict';

  let _db = null;
  let _applyEvent = null;

  async function init() {
    // ⭐ CRITICAL: Phải đợi BeerPOSDB ready trước khi truy cập _db
    if (window.BeerPOSDB) {
      await window.BeerPOSDB.ready;
      _db = window.BeerPOSDB;
      console.log('[EVENT] _db ready, upsertEntity:', typeof _db.upsertEntity);
    }
  }

  // ── Event Types ───────────────────────────────────────────────────────

  const EVENT_TYPES = {
    ORDER_CREATED: 'ORDER_CREATED',
    ORDER_UPDATED: 'ORDER_UPDATED',
    ORDER_DELETED: 'ORDER_DELETED',
    ORDER_RETURNED: 'ORDER_RETURNED',
    PRODUCT_UPDATED: 'PRODUCT_UPDATED',
    PRODUCT_STOCK_CHANGED: 'PRODUCT_STOCK_CHANGED',
    CUSTOMER_CREATED: 'CUSTOMER_CREATED',
    CUSTOMER_UPDATED: 'CUSTOMER_UPDATED',
    EXPENSE_CREATED: 'EXPENSE_CREATED',
    EXPENSE_UPDATED: 'EXPENSE_UPDATED',
    EXPENSE_DELETED: 'EXPENSE_DELETED',
    KEG_DELIVERED: 'KEG_DELIVERED',
    KEG_COLLECTED: 'KEG_COLLECTED',
    KEG_BALANCE_UPDATED: 'KEG_BALANCE_UPDATED',
    PAYMENT_CREATED: 'PAYMENT_CREATED',
  };

  const PRIORITY = {
    ORDER_CREATED: 50, ORDER_UPDATED: 50, ORDER_DELETED: 50, ORDER_RETURNED: 50,
    PAYMENT_CREATED: 100,
    KEG_DELIVERED: 75, KEG_COLLECTED: 75, KEG_BALANCE_UPDATED: 50,
    CUSTOMER_CREATED: 25, CUSTOMER_UPDATED: 25,
    EXPENSE_CREATED: 25, EXPENSE_UPDATED: 25, EXPENSE_DELETED: 25,
    PRODUCT_UPDATED: 20, PRODUCT_STOCK_CHANGED: 30,
  };

  // ── Create Event ────────────────────────────────────────────────────

  async function createEvent(type, payload, options = {}) {
    const {
      entity = _getEntityFromType(type),
      entityId = payload?.id,
      immediate = true,
    } = options;

    const event = _createEventObject(type, payload, entity, entityId);
    let saved = false;

    try {
      saved = await _saveEventAtomic(event);
      if (!saved) throw new Error('Failed to save event');

      await _addToSyncQueue(event.id);

      if (immediate && _applyEvent) {
        try { await _applyEvent(event); } 
        catch (e) { console.error('[EVENT] Apply error:', e); }
      }

      _triggerSync();
      console.log(`[EVENT] Created: ${type}`, { eventId: event.id });
      return event;

    } catch (error) {
      console.error('[EVENT] createEvent failed:', error);
      if (!saved) _saveEventFallback(event);
      throw error;
    }
  }

  // ── Batch Create Events ───────────────────────────────────────────────

  /**
   * ⭐ OPTIMIZED: Bulk create events in single batch
   */
  async function createEventsBatch(events) {
    const now = Date.now();
    const deviceId = _getDeviceId();
    const created = [];
    const toSave = [];

    // Build all event objects
    for (const { type, payload, options = {} } of events) {
      const entity = options.entity || _getEntityFromType(type);
      const entityId = payload?.id;
      const event = {
        id: _generateUUID(),
        type,
        entity,
        entityId,
        payload,
        status: 'pending',
        syncStatus: 'pending',
        createdAt: now,
        deviceId,
        version: 1,
        retryCount: 0,
        lastError: null,
      };
      toSave.push(event);
    }

    // Bulk save to IndexedDB
    if (_db) {
      await _db.bulkAddEvents(toSave);
    } else {
      // Fallback to localStorage
      for (const event of toSave) {
        _saveEventFallback(event);
      }
    }

    // Bulk add to sync queue
    if (_db) {
      await _db.bulkAddToSyncQueue(toSave.map(e => e.id));
    }

    // Apply events locally
    if (_applyEvent) {
      for (const event of toSave) {
        try { await _applyEvent(event); } 
        catch (e) { console.error('[EVENT] Batch apply error:', e); }
      }
    }

    created.push(...toSave);
    console.log(`[EVENT] Batch created: ${created.length} events`);
    _triggerSync();

    return created;
  }

  // ── Helper Functions ──────────────────────────────────────────────────

  function _createEventObject(type, payload, entity, entityId) {
    return {
      id: _generateUUID(),
      type,
      entity,
      entityId,
      payload,
      status: 'pending',
      syncStatus: 'pending',
      createdAt: Date.now(),
      deviceId: _getDeviceId(),
      version: 1,
      retryCount: 0,
      lastError: null,
    };
  }

  async function _saveEventAtomic(event) {
    if (!_db) {
      _saveEventFallback(event);
      return true;
    }

    try {
      const existing = await _db.events.get(event.id);
      if (existing) return true; // Duplicate
      await _db.addEvent(event);
      return true;
    } catch (error) {
      console.error('[EVENT] _saveEventAtomic error:', error);
      return false;
    }
  }

  function _saveEventFallback(event) {
    try {
      const key = 'beerpos_v5_events';
      const events = JSON.parse(localStorage.getItem(key) || '[]');
      if (!events.some(e => e.id === event.id)) {
        events.push(event);
        localStorage.setItem(key, JSON.stringify(events));
      }
    } catch (error) {
      console.error('[EVENT] localStorage fallback failed:', error);
    }
  }

  async function _addToSyncQueue(eventId) {
    if (!_db) return;
    try { await _db.addToSyncQueue(eventId); } 
    catch (error) { console.error('[EVENT] _addToSyncQueue error:', error); }
  }

  function _triggerSync() {
    if (window.EventSyncEngine) {
      window.EventSyncEngine.triggerSync();
    }
  }

  // ── Receive Event from Server ────────────────────────────────────────

  async function receiveEvent(serverEvent) {
    const { id: eventId, type, payload, deviceId: serverDeviceId, timestamp } = serverEvent;

    if (serverDeviceId === _getDeviceId()) {
      return { skipped: true, reason: 'own_event' };
    }

    // Check deduplication
    if (_db) {
      const alreadySeen = await _db.isEventSeen(eventId);
      if (alreadySeen) return { skipped: true, reason: 'already_seen' };

      const existing = await _db.events.get(eventId);
      if (existing) return { skipped: true, reason: 'event_exists' };

      await _db.markEventSeen(eventId);
    }

    const event = {
      id: eventId,
      type,
      entity: _getEntityFromType(type),
      entityId: payload?.id,
      payload,
      status: 'synced',
      syncStatus: 'synced',
      createdAt: timestamp || Date.now(),
      deviceId: serverDeviceId,
      version: 1,
      fromServer: true,
    };

    await _saveEventAtomic(event);

    if (_applyEvent) {
      try { await _applyEvent(event); } 
      catch (error) { console.error('[EVENT] Apply server event error:', error); }
    }

    _dispatchEvent('event:received', event);
    return { success: true, event };
  }

  // ── Getters ────────────────────────────────────────────────────────

  async function getEvents(entity = null, limit = 100) {
    if (!_db) return [];
    if (entity) {
      return _db.getEventsByEntity(entity, { limit });
    }
    try {
      return await _db.events.limit(limit).toArray();
    } catch {
      return [];
    }
  }

  async function getPendingEvents(limit = 50) {
    if (!_db) return [];
    return _db.getPendingEvents(limit);
  }

  async function getEvent(eventId) {
    if (!_db) return null;
    return _db.events.get(eventId);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  function _getEntityFromType(type) {
    const map = {
      ORDER_CREATED: 'orders', ORDER_UPDATED: 'orders', ORDER_DELETED: 'orders', ORDER_RETURNED: 'orders',
      PRODUCT_UPDATED: 'products', PRODUCT_STOCK_CHANGED: 'products',
      CUSTOMER_CREATED: 'customers', CUSTOMER_UPDATED: 'customers',
      EXPENSE_CREATED: 'expenses', EXPENSE_UPDATED: 'expenses', EXPENSE_DELETED: 'expenses',
      KEG_DELIVERED: 'kegs', KEG_COLLECTED: 'kegs', KEG_BALANCE_UPDATED: 'kegs',
      PAYMENT_CREATED: 'payments',
    };
    return map[type] || 'unknown';
  }

  function _generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function _getDeviceId() {
    let id = localStorage.getItem('beerpos_device_id_v5');
    if (!id) {
      id = _generateUUID();
      localStorage.setItem('beerpos_device_id_v5', id);
    }
    return id;
  }

  function setApplyFunction(fn) {
    _applyEvent = fn;
  }

  function _dispatchEvent(name, data) {
    window.dispatchEvent(new CustomEvent(name, { detail: data }));
  }

  async function getStats() {
    if (!_db) return {};
    return _db.getStats();
  }

  // ── Export ────────────────────────────────────────────────────────

  const EventStore = {
    init,
    createEvent,
    createEventsBatch,
    receiveEvent,
    getEvents,
    getPendingEvents,
    getEvent,
    setApplyFunction,
    TYPES: EVENT_TYPES,
    PRIORITY,
    getStats,
  };

  window.EventStore = EventStore;
  window.createEvent = EventStore.createEvent;
  window.createEvents = EventStore.createEventsBatch;

  console.log('[EVENT] EventStore v5 loaded');

})();
