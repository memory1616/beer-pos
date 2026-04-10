/**
 * BeerPOS - Sync Engine (Động cơ đồng bộ)
 * ─────────────────────────────────────────────────────────────────────────────
 * Quản lý đồng bộ dữ liệu với:
 * - Queue local actions khi offline
 * - Retry mechanism khi offline
 * - Background sync
 * - Conflict resolution (Last-Write-Wins)
 * - Full state hoặc delta sync
 * ─────────────────────────────────────────────────────────────────────────────
 */

const db = require('../database');
const { generateUUID } = require('../database/migration');
const logger = require('../utils/logger');

// ── Constants ──────────────────────────────────────────────────────────────────

const SYNC_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  SYNCED: 'synced',
  FAILED: 'failed',
  CONFLICT: 'conflict',
};

const SYNC_PRIORITY = {
  HIGH: 10,    // Sale, Payment
  MEDIUM: 5,   // Customer, Expense
  LOW: 1,      // Log, Analytics
};

const MAX_RETRIES = 5;
const RETRY_DELAYS = [1000, 5000, 15000, 30000, 60000]; // Exponential backoff

// ── Sync Engine Class ──────────────────────────────────────────────────────────

class SyncEngine {
  constructor(options = {}) {
    this.options = {
      baseUrl: options.baseUrl || '',
      deviceId: options.deviceId || this._generateDeviceId(),
      syncInterval: options.syncInterval || 30000, // 30 seconds
      batchSize: options.batchSize || 50,
      maxRetries: options.maxRetries || MAX_RETRIES,
      enableOfflineQueue: options.enableOfflineQueue !== false,
      conflictStrategy: options.conflictStrategy || 'last_write_wins', // 'last_write_wins' | 'server_wins' | 'client_wins'
      ...options,
    };

    this._isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    this._isSyncing = false;
    this._syncTimer = null;
    this._listeners = new Set();
    this._queue = [];
    this._pendingConflicts = [];

    // Bind methods
    this._onOnline = this._onOnline.bind(this);
    this._onOffline = this._onOffline.bind(this);
    this._startSyncLoop = this._startSyncLoop.bind(this);

    // Setup event listeners for browser
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this._onOnline);
      window.addEventListener('offline', this._onOffline);
    }

    // Load pending items from DB
    this._loadPendingFromDB();
  }

  // ── Initialization ──────────────────────────────────────────────────────────

  _generateDeviceId() {
    if (typeof localStorage !== 'undefined') {
      let deviceId = localStorage.getItem('beerpos_device_id');
      if (!deviceId) {
        deviceId = generateUUID();
        localStorage.setItem('beerpos_device_id', deviceId);
      }
      return deviceId;
    }
    return generateUUID();
  }

  _loadPendingFromDB() {
    try {
      const items = db.prepare(`
        SELECT * FROM sync_queue
        WHERE status IN ('pending', 'failed')
        ORDER BY priority DESC, created_at ASC
        LIMIT 100
      `).all();

      this._queue = items.map(item => ({
        ...item,
        payload: item.payload ? JSON.parse(item.payload) : null,
        retryCount: item.retry_count || 0,
      }));

      logger.debug(`[SYNC] Loaded ${this._queue.length} pending items from DB`);
    } catch (error) {
      logger.error('[SYNC] Failed to load pending from DB', { error: error.message });
    }
  }

  // ── Event Handlers ─────────────────────────────────────────────────────────

  _onOnline() {
    this._isOnline = true;
    logger.info('[SYNC] Back online, triggering sync');
    this._notifyListeners('online', {});
    this.sync();
  }

  _onOffline() {
    this._isOnline = false;
    logger.warn('[SYNC] Gone offline, pausing sync');
    this._notifyListeners('offline', {});
  }

  // ── Queue Management ──────────────────────────────────────────────────────

  /**
   * Thêm action vào sync queue
   */
  enqueue(entity, entityId, action, payload = {}, options = {}) {
    const {
      priority = SYNC_PRIORITY.MEDIUM,
      immediate = false,
    } = options;

    const item = {
      uuid: generateUUID(),
      entity,
      entity_id: entityId,
      action,
      payload,
      priority,
      status: SYNC_STATUS.PENDING,
      retry_count: 0,
      max_retries: this.options.maxRetries,
      created_at: new Date().toISOString(),
      device_id: this.options.deviceId,
      version: 1,
    };

    // Save to DB
    try {
      db.prepare(`
        INSERT INTO sync_queue (
          uuid, entity, entity_id, action, payload, priority,
          status, retry_count, max_retries, created_at, device_id, version
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.uuid,
        item.entity,
        item.entity_id,
        item.action,
        JSON.stringify(item.payload),
        item.priority,
        item.status,
        item.retry_count,
        item.max_retries,
        item.created_at,
        item.device_id,
        item.version
      );

      this._queue.push(item);
      this._notifyListeners('enqueued', item);

      logger.debug(`[SYNC] Enqueued ${action} on ${entity}:${entityId}`);

      // Immediate sync if online
      if (immediate && this._isOnline) {
        this.sync();
      }

      return { success: true, uuid: item.uuid };
    } catch (error) {
      logger.error('[SYNC] Failed to enqueue', { entity, action, error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Lấy các items đang chờ sync
   */
  getPending() {
    return this._queue.filter(item => item.status === SYNC_STATUS.PENDING);
  }

  /**
   * Lấy số lượng items đang chờ
   */
  getPendingCount() {
    return this._queue.filter(item => item.status === SYNC_STATUS.PENDING).length;
  }

  /**
   * Xóa item khỏi queue
   */
  remove(uuid) {
    try {
      db.prepare('DELETE FROM sync_queue WHERE uuid = ?').run(uuid);
      this._queue = this._queue.filter(item => item.uuid !== uuid);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ── Sync Operations ────────────────────────────────────────────────────────

  /**
   * Bắt đầu sync
   */
  async sync(options = {}) {
    if (this._isSyncing) {
      logger.debug('[SYNC] Already syncing, skipping');
      return { success: false, reason: 'already_syncing' };
    }

    if (!this._isOnline) {
      logger.debug('[SYNC] Offline, skipping sync');
      return { success: false, reason: 'offline' };
    }

    const { force = false } = options;
    this._isSyncing = true;

    try {
      this._notifyListeners('sync:start', {});

      // Get pending items
      const pending = this.getPending();
      
      if (pending.length === 0 && !force) {
        logger.debug('[SYNC] Nothing to sync');
        return { success: true, synced: 0 };
      }

      logger.info(`[SYNC] Starting sync with ${pending.length} items`);

      const results = {
        synced: 0,
        failed: 0,
        conflicts: 0,
        skipped: 0,
        items: [],
      };

      // Process in batches
      for (let i = 0; i < pending.length; i += this.options.batchSize) {
        const batch = pending.slice(i, i + this.options.batchSize);
        const batchResults = await this._processBatch(batch);
        
        results.synced += batchResults.synced;
        results.failed += batchResults.failed;
        results.conflicts += batchResults.conflicts;
        results.skipped += batchResults.skipped;
        results.items.push(...batchResults.items);
      }

      logger.info(`[SYNC] Complete: ${results.synced} synced, ${results.failed} failed, ${results.conflicts} conflicts`);

      this._notifyListeners('sync:complete', results);

      return { success: true, ...results };

    } catch (error) {
      logger.error('[SYNC] Sync failed', { error: error.message });
      this._notifyListeners('sync:error', { error: error.message });
      return { success: false, error: error.message };

    } finally {
      this._isSyncing = false;
    }
  }

  /**
   * Xử lý một batch items
   */
  async _processBatch(items) {
    const results = {
      synced: 0,
      failed: 0,
      conflicts: 0,
      skipped: 0,
      items: [],
    };

    for (const item of items) {
      try {
        const result = await this._syncItem(item);

        if (result.success) {
          results.synced++;
          results.items.push({ uuid: item.uuid, status: 'synced' });
        } else if (result.conflict) {
          results.conflicts++;
          results.items.push({ uuid: item.uuid, status: 'conflict', conflict: result.conflict });
          this._pendingConflicts.push(result.conflict);
        } else if (result.retry) {
          results.skipped++;
          results.items.push({ uuid: item.uuid, status: 'retry', delay: result.delay });
        } else {
          results.failed++;
          results.items.push({ uuid: item.uuid, status: 'failed', error: result.error });
        }
      } catch (error) {
        results.failed++;
        results.items.push({ uuid: item.uuid, status: 'failed', error: error.message });
      }
    }

    return results;
  }

  /**
   * Sync một item
   */
  async _syncItem(item) {
    const { entity, entity_id, action, payload, uuid } = item;

    // Check retry delay
    if (item.retry_count > 0) {
      const delay = RETRY_DELAYS[Math.min(item.retry_count - 1, RETRY_DELAYS.length - 1)];
      const lastAttempt = item.last_attempt ? new Date(item.last_attempt).getTime() : 0;
      const now = Date.now();

      if (now - lastAttempt < delay) {
        return { success: false, retry: true, delay };
      }
    }

    try {
      // Update status to in_progress
      this._updateItemStatus(uuid, SYNC_STATUS.IN_PROGRESS);

      // Make API request
      const endpoint = this._getEndpoint(entity, action);
      const method = this._getMethod(action);

      const response = await fetch(endpoint, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': this.options.deviceId,
          'X-Sync-Id': uuid,
        },
        body: action !== 'delete' ? JSON.stringify({
          ...payload,
          _syncId: uuid,
          _syncVersion: item.version,
        }) : undefined,
      });

      if (response.ok) {
        // Success
        this._markSynced(uuid);
        return { success: true };

      } else if (response.status === 409) {
        // Conflict
        const conflictData = await response.json();
        const resolved = await this._resolveConflict(item, conflictData);
        return resolved;

      } else if (response.status >= 500) {
        // Server error - retry
        return this._scheduleRetry(item);

      } else {
        // Client error - don't retry
        this._markFailed(uuid, `HTTP ${response.status}`);
        return { success: false, error: `HTTP ${response.status}` };
      }

    } catch (error) {
      if (!this._isOnline) {
        return { success: false, retry: true, delay: RETRY_DELAYS[0] };
      }

      return this._scheduleRetry(item, error.message);
    }
  }

  /**
   * Lên lịch retry
   */
  _scheduleRetry(item, errorMessage = null) {
    const newRetryCount = (item.retry_count || 0) + 1;

    if (newRetryCount > item.max_retries) {
      this._markFailed(item.uuid, errorMessage || 'Max retries exceeded');
      return { success: false, error: errorMessage || 'Max retries exceeded' };
    }

    const nextRetry = new Date(Date.now() + RETRY_DELAYS[Math.min(newRetryCount - 1, RETRY_DELAYS.length - 1)]);

    db.prepare(`
      UPDATE sync_queue
      SET status = ?,
          retry_count = ?,
          last_attempt = CURRENT_TIMESTAMP,
          next_retry = ?,
          error_message = ?
      WHERE uuid = ?
    `).run(SYNC_STATUS.PENDING, newRetryCount, nextRetry.toISOString(), errorMessage, item.uuid);

    return {
      success: false,
      retry: true,
      delay: RETRY_DELAYS[Math.min(newRetryCount - 1, RETRY_DELAYS.length - 1)],
    };
  }

  /**
   * Xử lý conflict
   */
  async _resolveConflict(localItem, serverData) {
    logger.warn('[SYNC] Conflict detected', { local: localItem, server: serverData });

    const strategy = this.options.conflictStrategy;
    let resolution = null;

    if (strategy === 'last_write_wins') {
      // So sánh updated_at
      const localTime = localItem.updated_at ? new Date(localItem.updated_at).getTime() : 0;
      const serverTime = serverData.updated_at ? new Date(serverData.updated_at).getTime() : 0;

      resolution = localTime > serverTime ? 'local' : 'server';
    } else if (strategy === 'server_wins') {
      resolution = 'server';
    } else if (strategy === 'client_wins') {
      resolution = 'local';
    }

    if (resolution === 'server') {
      // Cập nhật local với dữ liệu server
      await this._applyServerData(localItem.entity, localItem.entity_id, serverData);
      this._markSynced(localItem.uuid);
      return { success: true, conflict: { resolved: 'server_wins', serverData } };
    } else {
      // Gửi lại dữ liệu local với force flag
      return this._forcePush(localItem);
    }
  }

  /**
   * Force push local data
   */
  async _forcePush(item) {
    try {
      const endpoint = this._getEndpoint(item.entity, item.action);
      
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': this.options.deviceId,
          'X-Sync-Id': item.uuid,
          'X-Force-Sync': 'true',
        },
        body: JSON.stringify({
          ...item.payload,
          _syncId: item.uuid,
          _syncVersion: item.version,
          _forceSync: true,
        }),
      });

      if (response.ok) {
        this._markSynced(item.uuid);
        return { success: true };
      }

      return { success: false, conflict: true };
    } catch (error) {
      return { success: false, error: error.message, conflict: true };
    }
  }

  /**
   * Áp dụng dữ liệu từ server
   */
  async _applyServerData(entity, entityId, serverData) {
    try {
      const tableMap = {
        sales: 'sales',
        customers: 'customers',
        products: 'products',
        expenses: 'expenses',
        purchases: 'purchases',
        payments: 'payments',
      };

      const table = tableMap[entity];
      if (!table) return;

      // Update local record
      const fields = Object.keys(serverData)
        .filter(k => !['id', 'uuid', 'created_at'].includes(k))
        .map(k => `${k} = ?`)
        .join(', ');

      const values = Object.keys(serverData)
        .filter(k => !['id', 'uuid', 'created_at'].includes(k))
        .map(k => serverData[k]);

      if (fields) {
        db.prepare(`UPDATE ${table} SET ${fields} WHERE id = ?`).run(...values, entityId);
      }

      logger.debug(`[SYNC] Applied server data to ${entity}:${entityId}`);
    } catch (error) {
      logger.error('[SYNC] Failed to apply server data', { entity, entityId, error: error.message });
    }
  }

  // ── Status Updates ─────────────────────────────────────────────────────────

  _updateItemStatus(uuid, status) {
    db.prepare('UPDATE sync_queue SET status = ? WHERE uuid = ?').run(status, uuid);
    
    const item = this._queue.find(i => i.uuid === uuid);
    if (item) {
      item.status = status;
    }
  }

  _markSynced(uuid) {
    db.prepare(`
      UPDATE sync_queue
      SET status = 'synced', synced_at = CURRENT_TIMESTAMP
      WHERE uuid = ?
    `).run(uuid);

    this._queue = this._queue.filter(item => item.uuid !== uuid);
    this._notifyListeners('synced', { uuid });
  }

  _markFailed(uuid, errorMessage) {
    db.prepare(`
      UPDATE sync_queue
      SET status = 'failed', error_message = ?
      WHERE uuid = ?
    `).run(errorMessage, uuid);

    const item = this._queue.find(i => i.uuid === uuid);
    if (item) {
      item.status = SYNC_STATUS.FAILED;
      item.error_message = errorMessage;
    }

    this._notifyListeners('failed', { uuid, error: errorMessage });
  }

  // ── Endpoint Helpers ───────────────────────────────────────────────────────

  _getEndpoint(entity, action) {
    const base = this.options.baseUrl || '';
    const endpoints = {
      sales: '/api/sales',
      customers: '/api/customers',
      products: '/api/products',
      expenses: '/api/expenses',
      purchases: '/api/stock/multiple',
      payments: '/api/payments',
    };

    const basePath = endpoints[entity] || `/api/${entity}`;

    if (action === 'create') {
      return `${base}${basePath}`;
    } else if (action === 'update' || action === 'delete') {
      return `${base}${basePath}/${entity_id}`;
    }

    return `${base}${basePath}`;
  }

  _getMethod(action) {
    const methods = {
      create: 'POST',
      update: 'PUT',
      delete: 'DELETE',
    };
    return methods[action] || 'POST';
  }

  // ── Sync Loop ─────────────────────────────────────────────────────────────

  _startSyncLoop() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
    }

    this._syncTimer = setInterval(() => {
      if (this._isOnline && !this._isSyncing) {
        this.sync();
      }
    }, this.options.syncInterval);

    logger.info(`[SYNC] Started sync loop (interval: ${this.options.syncInterval}ms)`);
  }

  stopSyncLoop() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
    logger.info('[SYNC] Stopped sync loop');
  }

  // ── Full State Sync ────────────────────────────────────────────────────────

  /**
   * Pull full state từ server
   */
  async pullFullState() {
    if (!this._isOnline) {
      return { success: false, reason: 'offline' };
    }

    try {
      const response = await fetch('/api/sync/pull', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': this.options.deviceId,
        },
        body: JSON.stringify({
          deviceId: this.options.deviceId,
          lastSync: this._getLastSyncTime(),
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      // Apply state to local DB
      await this._applyFullState(data);

      // Update last sync time
      this._setLastSyncTime(new Date().toISOString());

      this._notifyListeners('pull:complete', data);

      return { success: true, data };

    } catch (error) {
      logger.error('[SYNC] Pull failed', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Áp dụng full state từ server
   */
  async _applyFullState(data) {
    const { customers, products, sales, expenses } = data;

    const applyEntity = (table, records) => {
      if (!records || records.length === 0) return;

      const upsert = db.prepare(`
        INSERT OR REPLACE INTO ${table} (
          id, uuid, created_at, updated_at, version, deleted, ...
        )
        VALUES (...)
      `);

      // Simplified - in real implementation would map all fields
      logger.debug(`[SYNC] Applying ${records.length} records to ${table}`);
    };

    if (customers) applyEntity('customers', customers);
    if (products) applyEntity('products', products);
    if (sales) applyEntity('sales', sales);
    if (expenses) applyEntity('expenses', expenses);
  }

  // ── Last Sync Time ────────────────────────────────────────────────────────

  _getLastSyncTime() {
    try {
      const row = db.prepare("SELECT value FROM sync_meta WHERE key = 'last_sync_time'").get();
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  _setLastSyncTime(time) {
    db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_sync_time', ?)").run(time);
  }

  // ── Event Listeners ────────────────────────────────────────────────────────

  addListener(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  _notifyListeners(event, data) {
    for (const callback of this._listeners) {
      try {
        callback(event, data);
      } catch (error) {
        logger.error('[SYNC] Listener error', { event, error: error.message });
      }
    }
  }

  // ── Status & Stats ────────────────────────────────────────────────────────

  getStatus() {
    return {
      isOnline: this._isOnline,
      isSyncing: this._isSyncing,
      pendingCount: this.getPendingCount(),
      queueLength: this._queue.length,
      conflicts: this._pendingConflicts.length,
      deviceId: this.options.deviceId,
      lastSync: this._getLastSyncTime(),
    };
  }

  getConflicts() {
    return this._pendingConflicts;
  }

  resolveConflict(conflictId, resolution) {
    this._pendingConflicts = this._pendingConflicts.filter(c => c.id !== conflictId);
    this._notifyListeners('conflict:resolved', { conflictId, resolution });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  destroy() {
    this.stopSyncLoop();

    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this._onOnline);
      window.removeEventListener('offline', this._onOffline);
    }

    // Cleanup old synced items
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      
      db.prepare(`
        DELETE FROM sync_queue
        WHERE status = 'synced' AND synced_at < ?
      `).run(cutoff.toISOString());

      logger.info('[SYNC] Cleanup completed');
    } catch (error) {
      logger.error('[SYNC] Cleanup failed', { error: error.message });
    }
  }
}

// ── Singleton Instance ─────────────────────────────────────────────────────────

let syncEngineInstance = null;

function getSyncEngine(options = {}) {
  if (!syncEngineInstance) {
    syncEngineInstance = new SyncEngine(options);
  }
  return syncEngineInstance;
}

// ── Export ────────────────────────────────────────────────────────────────────

module.exports = {
  SyncEngine,
  getSyncEngine,
  SYNC_STATUS,
  SYNC_PRIORITY,
  MAX_RETRIES,
};
