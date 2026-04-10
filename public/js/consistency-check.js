/**
 * BeerPOS - Consistency Check System
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ HEALTH MONITORING - Đảm bảo consistency giữa local và server
 * 
 * Checks:
 * - Order count
 * - Customer count
 * - Product count
 * - Pending sync count
 * 
 * If mismatch detected → trigger fullResync()
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function() {
  'use strict';

  let _db = null;
  let _checkTimer = null;
  let _listeners = new Set();
  let _initialized = false;

  // Config
  const CHECK_INTERVAL = 30000; // 30 seconds
  const MAX_MISMATCH_TOLERANCE = 5; // Allow 5 items difference

  // ── Init ──────────────────────────────────────────────────────────────

  async function init() {
    if (_initialized) return;

    if (window.BeerPOSDB) {
      await window.BeerPOSDB.init();
      _db = window.BeerPOSDB;
    }

    // Start check loop
    _startCheckLoop();

    _initialized = true;
    console.log('[CONSISTENCY] ConsistencyCheck initialized');
  }

  function _startCheckLoop() {
    if (_checkTimer) clearInterval(_checkTimer);
    _checkTimer = setInterval(_performCheck, CHECK_INTERVAL);
  }

  function _stopCheckLoop() {
    if (_checkTimer) {
      clearInterval(_checkTimer);
      _checkTimer = null;
    }
  }

  // ── Perform Check ───────────────────────────────────────────────────

  async function _performCheck() {
    if (!navigator.onLine) return;

    try {
      const result = await checkConsistency();
      
      if (result.mismatch) {
        console.warn('[CONSISTENCY] Mismatch detected:', result);
        _emit('mismatch', result);
        
        // Trigger full resync if significant mismatch
        if (result.severity === 'high') {
          await fullResync();
        }
      } else {
        _emit('ok', result);
      }
    } catch (error) {
      console.error('[CONSISTENCY] Check failed:', error);
      _emit('error', { error: error.message });
    }
  }

  // ── Check Consistency ───────────────────────────────────────────────

  async function checkConsistency() {
    const result = {
      timestamp: Date.now(),
      mismatch: false,
      severity: 'none',
      checks: [],
    };

    try {
      // 1. Check sync status
      const syncStatus = await _getSyncStatus();
      
      if (syncStatus.pending > 50) {
        result.mismatch = true;
        result.severity = 'medium';
        result.checks.push({
          type: 'sync_pending',
          status: 'warning',
          message: `${syncStatus.pending} pending events`,
          severity: 'low',
        });
      }

      // 2. Check server consistency
      const serverCounts = await _getServerCounts();
      const localCounts = await _getLocalCounts();

      // Check orders
      const orderDiff = Math.abs((serverCounts.orders || 0) - (localCounts.orders || 0));
      if (orderDiff > MAX_MISMATCH_TOLERANCE) {
        result.mismatch = true;
        result.severity = orderDiff > 20 ? 'high' : 'medium';
        result.checks.push({
          type: 'orders',
          status: 'mismatch',
          server: serverCounts.orders,
          local: localCounts.orders,
          diff: orderDiff,
          severity: result.severity,
        });
      }

      // Check customers
      const customerDiff = Math.abs((serverCounts.customers || 0) - (localCounts.customers || 0));
      if (customerDiff > MAX_MISMATCH_TOLERANCE) {
        result.mismatch = true;
        result.severity = customerDiff > 10 ? 'high' : 'medium';
        result.checks.push({
          type: 'customers',
          status: 'mismatch',
          server: serverCounts.customers,
          local: localCounts.customers,
          diff: customerDiff,
          severity: result.severity,
        });
      }

      // 3. Check for data integrity issues
      const integrity = await _checkIntegrity();
      if (!integrity.ok) {
        result.mismatch = true;
        result.severity = 'high';
        result.checks.push({
          type: 'integrity',
          status: 'failed',
          issues: integrity.issues,
          severity: 'high',
        });
      }

      // 4. Check event store health
      const eventHealth = await _checkEventHealth();
      if (!eventHealth.ok) {
        result.mismatch = true;
        result.severity = 'medium';
        result.checks.push({
          type: 'event_health',
          status: 'warning',
          issues: eventHealth.issues,
          severity: 'medium',
        });
      }

    } catch (error) {
      console.error('[CONSISTENCY] Check error:', error);
      result.error = error.message;
    }

    return result;
  }

  async function _getSyncStatus() {
    if (!_db) return { pending: 0, synced: 0 };

    const stats = await _db.getStats();
    return {
      pending: stats.pendingEvents || 0,
      synced: stats.syncedEvents || 0,
    };
  }

  async function _getServerCounts() {
    try {
      const response = await fetch('/api/sync/counts', {
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      return data.counts || {};
    } catch (error) {
      console.error('[CONSISTENCY] Server counts failed:', error);
      return {};
    }
  }

  async function _getLocalCounts() {
    if (!_db) return {};

    try {
      const orders = await _db.getAllEntities('orders');
      const customers = await _db.getAllEntities('customers');
      const products = await _db.getAllEntities('products');

      return {
        orders: orders.filter(o => !o.deleted).length,
        customers: customers.filter(c => !c.deleted).length,
        products: products.length,
      };
    } catch (error) {
      console.error('[CONSISTENCY] Local counts failed:', error);
      return {};
    }
  }

  async function _checkIntegrity() {
    if (!_db) return { ok: true, issues: [] };

    const issues = [];

    try {
      // Check for duplicate events
      const events = await _db.events.toArray();
      const eventIds = new Set();
      
      for (const event of events) {
        if (eventIds.has(event.id)) {
          issues.push({
            type: 'duplicate_event',
            eventId: event.id,
          });
        }
        eventIds.add(event.id);
      }

      // Check for orphaned sync queue items
      const queueItems = await _db.syncQueue.toArray();
      const eventSet = new Set(events.map(e => e.id));
      
      for (const item of queueItems) {
        if (!eventSet.has(item.eventId)) {
          issues.push({
            type: 'orphaned_queue_item',
            itemId: item.id,
          });
        }
      }

    } catch (error) {
      console.error('[CONSISTENCY] Integrity check error:', error);
      issues.push({
        type: 'check_error',
        error: error.message,
      });
    }

    return {
      ok: issues.length === 0,
      issues,
    };
  }

  async function _checkEventHealth() {
    if (!_db) return { ok: true, issues: [] };

    const issues = [];

    try {
      // Check for stuck pending events (> 1 hour old)
      const oneHourAgo = Date.now() - 3600000;
      const pendingEvents = await _db.events
        .where('status')
        .equals('pending')
        .toArray();

      for (const event of pendingEvents) {
        if (event.createdAt < oneHourAgo) {
          issues.push({
            type: 'stuck_event',
            eventId: event.id,
            type: event.type,
            age: Date.now() - event.createdAt,
          });
        }
      }

      // Check for many failed events
      const failedEvents = await _db.events
        .where('status')
        .equals('failed')
        .count();

      if (failedEvents > 10) {
        issues.push({
          type: 'many_failed',
          count: failedEvents,
        });
      }

    } catch (error) {
      issues.push({
        type: 'check_error',
        error: error.message,
      });
    }

    return {
      ok: issues.length === 0,
      issues,
    };
  }

  // ── Full Resync ───────────────────────────────────────────────────

  async function fullResync() {
    console.log('[CONSISTENCY] Starting full resync...');
    _emit('resync:start', {});

    try {
      // 1. Clear local data
      if (_db) {
        await _db.clearAll();
      }

      // 2. Fetch full state from server
      const response = await fetch('/api/state/full', {
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      // 3. Apply full state
      if (data.success && window.ApplyEvent) {
        // Apply orders
        if (data.orders?.length) {
          for (const order of data.orders) {
            await window.EventStore?.receiveEvent({
              id: order.id,
              type: 'ORDER_CREATED',
              payload: order,
              deviceId: 'server',
              timestamp: order.created_at || Date.now(),
            });
          }
        }

        // Apply customers
        if (data.customers?.length) {
          for (const customer of data.customers) {
            await window.EventStore?.receiveEvent({
              id: customer.id,
              type: 'CUSTOMER_CREATED',
              payload: customer,
              deviceId: 'server',
              timestamp: customer.created_at || Date.now(),
            });
          }
        }

        // Apply products
        if (data.products?.length) {
          for (const product of data.products) {
            await window.EventStore?.receiveEvent({
              id: product.id,
              type: 'PRODUCT_UPDATED',
              payload: product,
              deviceId: 'server',
              timestamp: product.updated_at || Date.now(),
            });
          }
        }
      }

      // 4. Update last sync time
      if (_db) {
        await _db.setMeta('lastFullSync', Date.now());
      }

      console.log('[CONSISTENCY] Full resync complete');
      _emit('resync:complete', {
        orders: data.orders?.length || 0,
        customers: data.customers?.length || 0,
        products: data.products?.length || 0,
      });

      return { success: true };

    } catch (error) {
      console.error('[CONSISTENCY] Full resync failed:', error);
      _emit('resync:error', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  // ── Event System ───────────────────────────────────────────────────

  function _emit(event, data) {
    for (const listener of _listeners) {
      try {
        listener(event, data);
      } catch (error) {
        console.error('[CONSISTENCY] Listener error:', error);
      }
    }

    window.dispatchEvent(new CustomEvent('consistency:' + event, { detail: data }));
  }

  function addListener(callback) {
    _listeners.add(callback);
    return () => _listeners.delete(callback);
  }

  // ── Manual Trigger ─────────────────────────────────────────────────

  async function triggerCheck() {
    return checkConsistency();
  }

  async function triggerResync() {
    return fullResync();
  }

  // ── Export ────────────────────────────────────────────────────────

  const ConsistencyCheck = {
    init,
    checkConsistency,
    triggerCheck,
    triggerResync,
    addListener,
  };

  window.ConsistencyCheck = ConsistencyCheck;

  console.log('[CONSISTENCY] ConsistencyCheck loaded');

})();
