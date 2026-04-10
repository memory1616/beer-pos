/**
 * BeerPOS - IndexedDB v5 (Optimized)
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ OPTIMIZED FOR PERFORMANCE:
 * - Compound indexes for fast queries
 * - Bulk operations (bulkAdd, bulkPut, bulkUpdate)
 * - Batch processing support
 * - Efficient storage
 * ─────────────────────────────────────────────────────────────────────────────
 */

class BeerPOSDB {
  constructor() {
    this._db = null;
    this._initialized = false;
    // ⭐ Promise 暴露给外部，其他模块可以 await this.ready
    this._readyPromise = null;
    this._readyResolve = null;
    this._readyReject = null;
  }

  /**
   * ⭐ 暴露初始化 Promise，其他模块 (apply-event, consistency-check)
   * 必须 await this.ready 再访问 _db
   */
  get ready() {
    return this._readyPromise;
  }

  async init() {
    if (this._initialized) return this._db;

    // ⭐ 初始化 Promise，确保只 resolve 一次
    if (!this._readyPromise) {
      this._readyPromise = new Promise((resolve, reject) => {
        this._readyResolve = resolve;
        this._readyReject = reject;
      });
    }

    if (typeof Dexie === 'undefined') {
      console.warn('[DBv5] Dexie not loaded, using localStorage fallback');
      this._initFallback();
      this._readyResolve?.();
      return this._db;
    }

    this._db = new Dexie('BeerPOS_v5');

    // ── SCHEMA v5 - Optimized Indexes ────────────────────────────────
    this._db.version(1).stores({
      // EVENT STORE - Optimized compound indexes
      events: 'id, [status+createdAt], [entity+syncStatus+createdAt], [entity+entityId+createdAt]',

      // ENTITY CACHE
      entities: 'id, entity, [entity+updatedAt], version',

      // SYNC QUEUE - Simple index for fast FIFO
      syncQueue: '++id, eventId, [status+createdAt]',

      // CONFLICTS
      conflicts: '++id, entity, [resolvedAt]',

      // META
      meta: 'key',

      // SEEN EVENTS
      seenEvents: 'eventId, [eventId+createdAt]',
    });

    await this._db.open();

    // Auto-fix corrupted data on startup (production safety net)
    // Must await — we cannot serve requests until data is fixed
    await this.fixCorruptedData();

    this._initialized = true;

    console.log('[DBv5] IndexedDB initialized (Optimized)');
    this._readyResolve?.();
    return this._db;
  }

  // ── Auto-fix corrupted data (production safety net) ─────────────────────
  async fixCorruptedData() {
    if (!this._db) return;

    try {
      const allEvents = await this._db.events.toArray();
      const updates = [];

      for (const e of allEvents) {
        let needsFix = false;
        const changes = {};

        if (typeof e.status !== 'string') {
          changes.status = 'pending';
          needsFix = true;
        }
        if (typeof e.syncStatus !== 'string') {
          changes.syncStatus = 'pending';
          needsFix = true;
        }
        if (!e.entity || typeof e.entity !== 'string') {
          changes.entity = 'unknown';
          needsFix = true;
        }

        if (needsFix) {
          updates.push({ key: e.id, changes });
        }
      }

      if (updates.length > 0) {
        console.warn(`[DBv5] Auto-fixing ${updates.length} corrupted events`);
        await this._db.events.bulkUpdate(updates);
      }
    } catch (err) {
      console.warn('[DBv5] fixCorruptedData error:', err);
    }
  }

  // ── Getters ────────────────────────────────────────────────────────

  get events() { return this._db?.events; }
  get entities() { return this._db?.entities; }
  get syncQueue() { return this._db?.syncQueue; }
  get conflicts() { return this._db?.conflicts; }
  get meta() { return this._db?.meta; }
  get seenEvents() { return this._db?.seenEvents; }

  // ── Bulk Event Operations ────────────────────────────────────────

  /**
   * ⭐ BULK ADD EVENTS - Much faster than individual adds
   */
  async bulkAddEvents(events) {
    if (!this._db || !events.length) return 0;

    // Normalize all events before any DB write
    const safeEvents = [];
    for (const e of events) {
      const valid = this._assertValidEvent(e);
      if (valid) safeEvents.push(valid);
    }
    if (safeEvents.length === 0) {
      console.warn('[DBv5] bulkAddEvents: all events invalid, skipping');
      return 0;
    }

    try {
      await this._db.events.bulkAdd(safeEvents);
      console.log(`[DBv5] Bulk added ${safeEvents.length} events`);
      return safeEvents.length;
    } catch (error) {
      console.error('[DBv5] bulkAddEvents error:', error);
      // Fallback: add one by one
      let added = 0;
      for (const event of safeEvents) {
        try {
          await this._db.events.add(event);
          added++;
        } catch (e) {
          // Skip duplicates
        }
      }
      return added;
    }
  }

  /**
   * ⭐ BULK UPDATE EVENTS - Update multiple events at once
   */
  async bulkUpdateEvents(updates) {
    if (!this._db || !updates.length) return 0;

    // Validate and normalize all update payloads
    const safeUpdates = [];
    for (const u of updates) {
      if (!u?.key) continue;
      const changes = { ...u.changes };
      changes.status = this._normalizeStatus(changes.status);
      changes.syncStatus = this._normalizeStatus(changes.syncStatus);
      safeUpdates.push({ key: u.key, changes });
    }
    if (safeUpdates.length === 0) return 0;

    try {
      await this._db.events.bulkUpdate(safeUpdates);
      console.log(`[DBv5] Bulk updated ${safeUpdates.length} events`);
      return safeUpdates.length;
    } catch (error) {
      console.error('[DBv5] bulkUpdateEvents error:', error);
      return 0;
    }
  }

  /**
   * ⭐ Get pending events - Uses compound index [status+createdAt]
   */
  async getPendingEvents(limit = 50) {
    if (!this._db) return [];

    const safeStatus = 'pending';
    try {
      return await this._db.events
        .where('[status+createdAt]')
        .between([safeStatus, Dexie.minKey], [safeStatus, Dexie.maxKey])
        .limit(limit)
        .toArray();
    } catch (error) {
      console.error('[DBv5] getPendingEvents error:', error);
      return [];
    }
  }

  /**
   * ⭐ Get events by entity - Uses compound index [entity+syncStatus+createdAt]
   */
  async getEventsByEntity(entity, options = {}) {
    const { syncStatus, limit = 100 } = options;

    if (!this._db) return [];

    // Validate entity to prevent Dexie errors
    const safeEntity = this._safeIndex(entity);
    if (!safeEntity) return [];

    try {
      if (syncStatus) {
        const safeStatus = this._safeString(syncStatus);
        return await this._db.events
          .where('[entity+syncStatus+createdAt]')
          .between([safeEntity, safeStatus, Dexie.minKey], [safeEntity, safeStatus, Dexie.maxKey])
          .limit(limit)
          .toArray();
      }

      return await this._db.events
        .where('entity')
        .equals(safeEntity)
        .limit(limit)
        .reverse()
        .toArray();
    } catch (error) {
      console.error('[DBv5] getEventsByEntity error:', error);
      return [];
    }
  }

  // ── Event Status Operations ────────────────────────────────────

  async updateEventStatus(eventId, updates) {
    if (!this._db) return;

    const safeUpdates = { ...updates };
    safeUpdates.status = this._normalizeStatus(safeUpdates.status);
    safeUpdates.syncStatus = this._normalizeStatus(safeUpdates.syncStatus);

    try {
      await this._db.events.update(eventId, {
        ...safeUpdates,
        updatedAt: Date.now(),
      });
    } catch (error) {
      console.error('[DBv5] updateEventStatus error:', error);
    }
  }

  /**
   * ⭐ BATCH MARK EVENTS SYNCED - Single bulkUpdate call
   */
  async batchMarkEventsSynced(eventIds) {
    if (!this._db || !eventIds.length) return;

    const now = Date.now();
    
    try {
      // Build update array
      const updates = eventIds.map(id => ({
        key: id,
        changes: {
          status: 'synced',
          syncStatus: 'synced',
          syncedAt: now,
        },
      }));
      
      await this._db.events.bulkUpdate(updates);
    } catch (error) {
      console.error('[DBv5] batchMarkEventsSynced error:', error);
    }
  }

  /**
   * ⭐ BATCH MARK EVENTS FAILED - Single bulkUpdate call
   */
  async batchMarkEventsFailed(eventIds, error) {
    if (!this._db || !eventIds.length) return;

    const now = Date.now();
    
    try {
      const updates = eventIds.map(id => ({
        key: id,
        changes: {
          status: 'failed',
          syncStatus: 'failed',
          lastError: error,
          failedAt: now,
        },
      }));
      
      await this._db.events.bulkUpdate(updates);
    } catch (error) {
      console.error('[DBv5] batchMarkEventsFailed error:', error);
    }
  }

  /**
   * ⭐ INCREMENT RETRY COUNT - Returns new count
   */
  async incrementRetryCount(eventId, error) {
    if (!this._db) return 0;

    try {
      const event = await this._db.events.get(eventId);
      if (!event) return 0;

      const retryCount = (event.retryCount || 0) + 1;
      const MAX_RETRIES = 3;

      const newStatus = retryCount >= MAX_RETRIES ? 'failed' : 'pending';

      await this._db.events.update(eventId, {
        retryCount,
        lastError: error,
        lastRetryAt: Date.now(),
        status: newStatus,
        syncStatus: newStatus,
        nextRetryAt: retryCount < MAX_RETRIES ? Date.now() + getRetryDelay(retryCount) : null,
      });

      return retryCount;
    } catch (error) {
      console.error('[DBv5] incrementRetryCount error:', error);
      return 0;
    }
  }

  // ── Bulk Entity Operations ────────────────────────────────────

  /**
   * ⭐ BULK UPSERT ENTITIES - Much faster than individual puts
   */
  async bulkUpsertEntities(entity, items) {
    if (!this._db || !items.length) return 0;

    const safeEntity = this._safeIndex(entity);
    if (!safeEntity) {
      console.warn('[DBv5] bulkUpsertEntities: invalid entity', entity);
      return 0;
    }

    try {
      const now = Date.now();
      const entities = items.map(item => ({
        ...item,
        entity: safeEntity,
        updatedAt: now,
      }));

      await this._db.entities.bulkPut(entities);
      console.log(`[DBv5] Bulk upserted ${items.length} ${safeEntity}`);
      return items.length;
    } catch (error) {
      console.error('[DBv5] bulkUpsertEntities error:', error);
      return 0;
    }
  }

  async getAllEntities(entity) {
    if (!this._db) return [];
    try {
      return await this._db.entities.where('entity').equals(entity).toArray();
    } catch {
      return [];
    }
  }

  // ── Single Entity Operations ──────────────────────────────────

  /**
   * 获取单个实体（通过 id 字段查询）
   * @param {string} entity - 实体类型名（如 'customers', 'products'）
   * @param {number|string} id - 实体 id
   * @returns {Promise<Object|null>}
   */
  async getEntity(entity, id) {
    if (!this._db) return null;
    try {
      const safeEntity = this._safeIndex(entity);
      if (!safeEntity) return null;
      return await this._db.entities
        .where('id')
        .equals(id)
        .and(item => item.entity === safeEntity)
        .first();
    } catch {
      return null;
    }
  }

  /**
   * 插入或更新单个实体（upsert = update or insert）
   * @param {string} entity - 实体类型名
   * @param {Object} item - 实体数据（必须包含 id 字段）
   * @returns {Promise<Object>}
   */
  async upsertEntity(entity, item) {
    if (!this._db || !item?.id) {
      console.warn('[DBv5] upsertEntity: invalid db or missing id');
      return item;
    }
    const safeEntity = this._safeIndex(entity);
    if (!safeEntity) {
      console.warn('[DBv5] upsertEntity: invalid entity', entity);
      return item;
    }
    try {
      const now = Date.now();
      const data = {
        ...item,
        entity: safeEntity,
        updatedAt: item.updatedAt || now,
      };
      await this._db.entities.put(data);
      return data;
    } catch (error) {
      console.error('[DBv5] upsertEntity error:', error);
      return item;
    }
  }

  // ── Bulk Sync Queue Operations ─────────────────────────────────

  /**
   * ⭐ BULK ADD TO SYNC QUEUE
   */
  async bulkAddToSyncQueue(eventIds) {
    if (!this._db || !eventIds.length) return 0;

    const now = Date.now();
    
    try {
      const items = eventIds.map(eventId => ({
        eventId,
        status: 'pending',
        createdAt: now,
      }));
      
      await this._db.syncQueue.bulkAdd(items);
      return eventIds.length;
    } catch (error) {
      console.error('[DBv5] bulkAddToSyncQueue error:', error);
      return 0;
    }
  }

  /**
   * ⭐ BULK REMOVE FROM SYNC QUEUE
   */
  async bulkRemoveFromSyncQueue(eventIds) {
    if (!this._db || !eventIds.length) return 0;

    try {
      await this._db.syncQueue.where('eventId').anyOf(eventIds).delete();
      return eventIds.length;
    } catch (error) {
      console.error('[DBv5] bulkRemoveFromSyncQueue error:', error);
      return 0;
    }
  }

  async getSyncQueueItems(limit = 50) {
    if (!this._db) return [];

    try {
      return await this._db.syncQueue
        .where('[status+createdAt]')
        .between(['pending', Dexie.minKey], ['pending', Dexie.maxKey])
        .limit(limit)
        .toArray();
    } catch (error) {
      console.warn('[DBv5] getSyncQueueItems error:', error);
      return [];
    }
  }

  // ── Bulk Seen Events ─────────────────────────────────────────

  async bulkMarkEventsSeen(eventIds) {
    if (!this._db || !eventIds.length) return;

    const now = Date.now();
    
    try {
      const items = eventIds.map(eventId => ({
        eventId,
        createdAt: now,
      }));
      
      await this._db.seenEvents.bulkPut(items);
    } catch (error) {
      console.error('[DBv5] bulkMarkEventsSeen error:', error);
    }
  }

  // ── Missing Event Store Methods (critical) ───────────────────────────

  async addEvent(event) {
    if (!this._db) return;

    const valid = this._assertValidEvent(event);
    if (!valid) return;

    try {
      await this._db.events.put(valid);
    } catch (error) {
      console.error('[DBv5] addEvent error:', error);
    }
  }

  async addToSyncQueue(eventId) {
    if (!this._db || !eventId) return;
    try {
      const now = Date.now();
      await this._db.syncQueue.put({
        eventId: String(eventId),
        status: 'pending',
        createdAt: now,
      });
    } catch (error) {
      console.error('[DBv5] addToSyncQueue error:', error);
    }
  }

  async isEventSeen(eventId) {
    if (!this._db || !eventId) return false;
    try {
      const seen = await this._db.seenEvents.get(String(eventId));
      return !!seen;
    } catch (error) {
      console.warn('[DBv5] isEventSeen error:', error);
      return false;
    }
  }

  async markEventSeen(eventId) {
    if (!this._db || !eventId) return;
    try {
      await this._db.seenEvents.put({
        eventId: String(eventId),
        createdAt: Date.now(),
      });
    } catch (error) {
      console.warn('[DBv5] markEventSeen error:', error);
    }
  }

  // ── Meta Operations ────────────────────────────────────────

  async getMeta(key, defaultValue = null) {
    if (!this._db) return defaultValue;
    const record = await this._db.meta.get(key);
    return record ? record.value : defaultValue;
  }

  async setMeta(key, value) {
    if (!this._db) return;
    await this._db.meta.put({ key, value, updatedAt: Date.now() });
  }

  // ── Validation helpers ──────────────────────────────────────────

  _safeString(val) {
    if (val == null) return '';
    return typeof val === 'string' ? val : String(val);
  }

  _safeIndex(entity) {
    if (!entity || typeof entity !== 'string') {
      console.warn('[DB] Invalid entity in compound index query:', entity);
      return null;
    }
    return entity;
  }

  /**
   * Normalize a status value to a valid string
   */
  _normalizeStatus(val) {
    if (typeof val !== 'string') return 'pending';
    if (val !== 'pending' && val !== 'synced' && val !== 'failed') return 'pending';
    return val;
  }

  /**
   * Assert and normalize an event before DB write — production safety
   */
  _assertValidEvent(e) {
    if (!e || typeof e !== 'object') {
      console.warn('[DB] _assertValidEvent: invalid event object:', e);
      return null;
    }
    const valid = {
      id: e.id,
      type: e.type,
      entity: this._safeIndex(e.entity),
      entityId: e.entityId,
      payload: e.payload,
      status: this._normalizeStatus(e.status),
      syncStatus: this._normalizeStatus(e.syncStatus),
      createdAt: typeof e.createdAt === 'number' ? e.createdAt : Date.now(),
      updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : Date.now(),
      deviceId: e.deviceId,
      version: typeof e.version === 'number' ? e.version : 1,
      retryCount: typeof e.retryCount === 'number' ? e.retryCount : 0,
      lastError: e.lastError || null,
    };
    if (!valid.entity) {
      console.warn('[DB] _assertValidEvent: invalid entity, skipping event');
      return null;
    }
    return valid;
  }

  /**
   * Safe count — never throws, always returns 0 on error
   */
  async _safeCount(query) {
    try {
      return await query.count();
    } catch (err) {
      console.warn('[DB][safeCount] error:', err);
      return 0;
    }
  }

  // ── Debug helper ──────────────────────────────────────────────
  _debugLog(label, data) {
    if (typeof data === 'string') {
      console.log(`[DB][${label}]`, data);
    } else {
      console.log(`[DB][${label}]`, JSON.stringify(data));
    }
  }

  generateId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  now() {
    return Date.now();
  }

  async clearAll() {
    if (!this._db) return;
    
    await Promise.all([
      this._db.events.clear(),
      this._db.entities.clear(),
      this._db.syncQueue.clear(),
      this._db.conflicts.clear(),
      this._db.seenEvents.clear(),
    ]);
    
    console.log('[DBv5] All data cleared');
  }

  async getStats() {
    if (!this._db) return { pendingEvents: 0, syncedEvents: 0, failedEvents: 0, queueItems: 0, totalEvents: 0 };

    const safeStatus = 'pending';
    const safeSynced = 'synced';
    const safeFailed = 'failed';

    console.log('[DB][getStats] querying:', { safeStatus, safeSynced, safeFailed });

    const [pendingEvents, syncedEvents, failedEvents, queueItems] = await Promise.all([
      this._safeCount(this._db.events.where('status').equals(safeStatus)),
      this._safeCount(this._db.events.where('status').equals(safeSynced)),
      this._safeCount(this._db.events.where('status').equals(safeFailed)),
      this._safeCount(this._db.syncQueue.where('status').equals(safeStatus)),
    ]);

    return {
      pendingEvents,
      syncedEvents,
      failedEvents,
      queueItems,
      totalEvents: pendingEvents + syncedEvents + failedEvents,
    };
  }
}

// Retry delay helper
function getRetryDelay(retryCount) {
  const delays = [5000, 15000, 45000]; // 5s, 15s, 45s
  return delays[Math.min(retryCount - 1, delays.length - 1)] || 45000;
}

// ── Singleton ────────────────────────────────────────────────────────────────

const beerPOSDB = new BeerPOSDB();

window.BeerPOSDB = beerPOSDB;
window.BeerDB = beerPOSDB;

// ⭐ BACKWARD COMPATIBILITY: Expose upsertEntity directly on BeerPOSDB instance
// Đảm bảo _db.upsertEntity luôn available cho tất cả các module cũ
// (áp dụng cả cho Dexie và localStorage fallback)
BeerPOSDB.upsertEntity = async function(entity, item) {
  if (!this._db || !item?.id) {
    console.warn('[DBv5] upsertEntity: invalid db or missing id');
    return item;
  }
  const safeEntity = this._safeIndex(entity);
  if (!safeEntity) {
    console.warn('[DBv5] upsertEntity: invalid entity', entity);
    return item;
  }
  try {
    const now = Date.now();
    const data = {
      ...item,
      entity: safeEntity,
      updatedAt: item.updatedAt || now,
    };
    await this._db.entities.put(data);
    return data;
  } catch (error) {
    console.error('[DBv5] upsertEntity error:', error);
    return item;
  }
};

console.log('[DBv5] BeerPOSDB v5 loaded (Optimized)');
