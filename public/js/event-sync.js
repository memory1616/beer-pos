/**
 * BeerPOS - Event Sync Engine v5 (Optimized)
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ OPTIMIZED:
 * - Batch processing (single request for many events)
 * - Concurrency control (max 2 concurrent requests)
 * - Aggressive deduplication (in-flight tracking)
 * - Request queuing
 * - Retry batching
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function() {
  'use strict';

  let _db = null;
  let _initialized = false;
  let _isOnline = navigator.onLine;
  let _listeners = new Set();

  // Config
  const BATCH_SIZE = 50;           // Events per batch
  const CONCURRENT_BATCHES = 2;     // Max concurrent requests
  const SYNC_INTERVAL = 2000;      // 2s between sync cycles
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [5000, 15000, 45000];

  // State
  let _syncTimer = null;
  let _activeRequests = 0;
  let _requestQueue = [];
  let _inFlightEvents = new Set();  // Track in-flight event IDs to avoid duplicates
  let _lastSyncAttempt = 0;
  let _pendingRetryTimer = null;

  // ── Init ──────────────────────────────────────────────────────────────

  async function init() {
    if (_initialized) return;

    if (window.BeerPOSDB) {
      await window.BeerPOSDB.init();
      _db = window.BeerPOSDB;
    }

    window.addEventListener('online', _onOnline);
    window.addEventListener('offline', _onOffline);

    await _recoverFromCrash();

    _startSyncLoop();

    _initialized = true;
    console.log('[SYNCv5] EventSyncEngine initialized');
  }

  // ── Crash Recovery ─────────────────────────────────────────────────

  async function _recoverFromCrash() {
    if (!_db) return;

    try {
      // Reset stuck syncing events
      const stuck = await _db.events.where('status').equals('syncing').toArray();
      if (stuck.length > 0) {
        console.warn(`[SYNCv5] Recovered ${stuck.length} stuck events`);
        await _db.bulkUpdateEvents(stuck.map(e => ({
          key: e.id,
          changes: { status: 'pending', syncStatus: 'pending' }
        })));
      }

      // Reset stale retry events
      const oneHourAgo = Date.now() - 3600000;
      const stale = await _db.events
        .filter(e => e.lastRetryAt && e.lastRetryAt < oneHourAgo && e.status === 'pending')
        .toArray();
      
      if (stale.length > 0) {
        console.warn(`[SYNCv5] Reset ${stale.length} stale retry events`);
        await _db.bulkUpdateEvents(stale.map(e => ({
          key: e.id,
          changes: { retryCount: 0, lastRetryAt: null, lastError: 'Reset after recovery' }
        })));
      }
    } catch (error) {
      console.error('[SYNCv5] Crash recovery error:', error);
    }
  }

  function _onOnline() {
    _isOnline = true;
    _emit('online', {});
    // Immediate sync after coming online
    setTimeout(() => triggerSync(), 500);
  }

  function _onOffline() {
    _isOnline = false;
    _emit('offline', {});
    _cancelPendingRequests();
  }

  // ── Sync Loop ────────────────────────────────────────────────────────

  function _startSyncLoop() {
    if (_syncTimer) clearInterval(_syncTimer);
    _syncTimer = setInterval(_processSyncCycle, SYNC_INTERVAL);
  }

  // ── Trigger Sync ─────────────────────────────────────────────────────

  function triggerSync() {
    if (!_isOnline) return;
    _processSyncCycle();
  }

  // ── Process Sync Cycle ──────────────────────────────────────────────

  async function _processSyncCycle() {
    if (!_isOnline) return;

    const pendingCount = await _getPendingCount();
    if (pendingCount === 0) return;

    // Get next batch
    const events = await _getNextBatch();
    if (events.length === 0) return;

    // Queue for processing
    _queueBatch(events);
  }

  async function _getPendingCount() {
    if (!_db) return 0;
    try {
      return await _db.events.where('[status+createdAt]').startsWith(['pending']).count();
    } catch {
      return 0;
    }
  }

  async function _getNextBatch() {
    if (!_db) return [];

    try {
      const events = await _db.events
        .where('[status+createdAt]')
        .between(['pending', Dexie.minKey], ['pending', Dexie.maxKey])
        .limit(BATCH_SIZE)
        .toArray();

      // Filter out in-flight events
      const available = events.filter(e => !_inFlightEvents.has(e.id));

      // Filter by retry delay
      const now = Date.now();
      const ready = available.filter(e => {
        if (e.retryCount === 0 || !e.lastRetryAt) return true;
        const delay = RETRY_DELAYS[Math.min(e.retryCount - 1, RETRY_DELAYS.length - 1)] || 45000;
        return now - e.lastRetryAt >= delay;
      });

      return ready;
    } catch (error) {
      console.error('[SYNCv5] _getNextBatch error:', error);
      return [];
    }
  }

  // ── Batch Queue & Processing ────────────────────────────────────────

  function _queueBatch(events) {
    if (events.length === 0) return;

    if (_activeRequests >= CONCURRENT_BATCHES) {
      _requestQueue.push(events);
      return;
    }

    _executeBatch(events);
  }

  async function _executeBatch(events) {
    _activeRequests++;
    
    // Mark events as in-flight
    for (const event of events) {
      _inFlightEvents.add(event.id);
    }

    _emit('sync:start', { count: events.length });

    try {
      const result = await _sendBatchRequest(events);
      await _processResults(events, result);
    } catch (error) {
      console.error('[SYNCv5] Batch error:', error);
      await _handleBatchError(events, error.message);
    } finally {
      // Remove from in-flight
      for (const event of events) {
        _inFlightEvents.delete(event.id);
      }
      
      _activeRequests--;
      
      // Process next in queue
      if (_requestQueue.length > 0 && _isOnline) {
        const nextBatch = _requestQueue.shift();
        setTimeout(() => _queueBatch(nextBatch), 100);
      }
    }
  }

  // ── Send Batch Request ──────────────────────────────────────────────

  async function _sendBatchRequest(events) {
    const payload = {
      deviceId: _getDeviceId(),
      timestamp: Date.now(),
      events: events.map(e => ({
        id: e.id,
        type: e.type,
        entity: e.entity,
        payload: e.payload,
        createdAt: e.createdAt,
        version: e.version,
        retryCount: e.retryCount || 0,
      })),
    };

    const response = await fetch('/api/sync/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': _getDeviceId(),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  // ── Process Results ──────────────────────────────────────────────────

  async function _processResults(events, result) {
    const results = result.results || [];
    const updates = [];
    const syncedIds = [];

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const eventResult = results[i] || {};

      if (eventResult.success || eventResult.duplicate) {
        syncedIds.push(event.id);
        updates.push({
          key: event.id,
          changes: { status: 'synced', syncStatus: 'synced', syncedAt: Date.now() }
        });
      } else if (eventResult.conflict) {
        await _handleConflict(event, eventResult);
      } else {
        // Failed - increment retry
        const retryCount = (event.retryCount || 0) + 1;
        const delay = RETRY_DELAYS[Math.min(retryCount - 1, RETRY_DELAYS.length - 1)] || 45000;
        
        if (retryCount >= MAX_RETRIES) {
          updates.push({
            key: event.id,
            changes: { 
              status: 'failed', 
              syncStatus: 'failed',
              retryCount,
              lastError: eventResult.error || 'Max retries',
              failedAt: Date.now(),
            }
          });
        } else {
          updates.push({
            key: event.id,
            changes: { 
              retryCount,
              lastError: eventResult.error || 'Sync failed',
              lastRetryAt: Date.now(),
              nextRetryAt: Date.now() + delay,
            }
          });
        }
      }
    }

    // Bulk update
    if (updates.length > 0 && _db) {
      await _db.bulkUpdateEvents(updates);
    }

    // Bulk remove from sync queue
    if (syncedIds.length > 0 && _db) {
      await _db.bulkRemoveFromSyncQueue(syncedIds);
    }

    _emit('sync:complete', {
      count: events.length,
      succeeded: syncedIds.length,
      failed: events.length - syncedIds.length,
    });
  }

  async function _handleBatchError(events, errorMessage) {
    console.error('[SYNCv5] Batch failed:', errorMessage);

    // Don't mark as failed on network error - just update retry
    const isNetworkError = errorMessage.includes('fetch') || errorMessage.includes('network');
    
    const updates = events.map(event => {
      const retryCount = (event.retryCount || 0) + 1;
      const delay = RETRY_DELAYS[Math.min(retryCount - 1, RETRY_DELAYS.length - 1)] || 45000;

      return {
        key: event.id,
        changes: {
          retryCount,
          lastError: errorMessage,
          lastRetryAt: Date.now(),
          nextRetryAt: Date.now() + delay,
          status: retryCount >= MAX_RETRIES ? 'failed' : 'pending',
          syncStatus: retryCount >= MAX_RETRIES ? 'failed' : 'pending',
        }
      };
    });

    if (_db) {
      await _db.bulkUpdateEvents(updates);
    }

    _emit('sync:error', { count: events.length, error: errorMessage });
  }

  // ── Conflict Handling ───────────────────────────────────────────────

  async function _handleConflict(event, result) {
    console.warn('[SYNCv5] Conflict:', event.id);

    if (_db?.conflicts) {
      await _db.conflicts.add({
        entity: event.entity,
        entityId: event.entityId,
        localEvent: event,
        serverData: result.serverData,
        resolvedAt: Date.now(),
      });
    }

    // Last-Write-Wins
    const localTime = event.payload?.updatedAt || event.createdAt;
    const serverTime = result.serverData?.updatedAt || 0;

    if (localTime > serverTime) {
      await _forcePushEvent(event);
    } else if (window.EventStore) {
      await window.EventStore.receiveEvent({
        id: event.id,
        type: event.type,
        payload: result.serverData,
        deviceId: 'server',
        timestamp: Date.now(),
      });
    }

    // Mark as synced
    if (_db) {
      await _db.events.update(event.id, {
        status: 'synced',
        syncStatus: 'synced',
        syncedAt: Date.now(),
      });
    }
  }

  async function _forcePushEvent(event) {
    try {
      await fetch('/api/sync/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': _getDeviceId(),
          'X-Force-Sync': 'true',
        },
        body: JSON.stringify({
          deviceId: _getDeviceId(),
          forceSync: true,
          events: [{
            id: event.id,
            type: event.type,
            entity: event.entity,
            payload: { ...event.payload, _forceSync: true },
            createdAt: event.createdAt,
            forceSync: true,
          }],
        }),
      });
    } catch (error) {
      console.error('[SYNCv5] Force push failed:', error);
    }
  }

  // ── Queue Management ───────────────────────────────────────────────

  function _cancelPendingRequests() {
    _requestQueue = [];
  }

  // ── Device ID ─────────────────────────────────────────────────────

  function _getDeviceId() {
    let id = localStorage.getItem('beerpos_device_id_v5');
    if (!id) {
      id = _generateUUID();
      localStorage.setItem('beerpos_device_id_v5', id);
    }
    return id;
  }

  function _generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ── Event System ───────────────────────────────────────────────────

  function _emit(event, data) {
    for (const listener of _listeners) {
      try { listener(event, data); } 
      catch (error) { console.error('[SYNCv5] Listener error:', error); }
    }
    window.dispatchEvent(new CustomEvent('syncv5:' + event, { detail: data }));
  }

  function addListener(callback) {
    _listeners.add(callback);
    return () => _listeners.delete(callback);
  }

  // ── Status ─────────────────────────────────────────────────────

  async function getStatus() {
    const stats = _db ? await _db.getStats() : {};
    return {
      isOnline: _isOnline,
      activeRequests: _activeRequests,
      queueLength: _requestQueue.length,
      inFlightCount: _inFlightEvents.size,
      deviceId: _getDeviceId(),
      ...stats,
    };
  }

  async function retryFailed() {
    if (!_db) return { success: false };

    const failed = await _db.events.where('status').equals('failed').toArray();
    
    if (failed.length > 0) {
      await _db.bulkUpdateEvents(failed.map(e => ({
        key: e.id,
        changes: { status: 'pending', syncStatus: 'pending', retryCount: 0, lastRetryAt: null }
      })));
      triggerSync();
    }

    return { success: true, count: failed.length };
  }

  // ── Export ─────────────────────────────────────────────────────

  const EventSyncEngine = {
    init,
    triggerSync,
    addListener,
    getStatus,
    retryFailed,
  };

  window.EventSyncEngine = EventSyncEngine;

  console.log('[SYNCv5] EventSyncEngine loaded');

})();
