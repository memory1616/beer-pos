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
  }

  async init() {
    if (this._initialized) return this._db;

    if (typeof Dexie === 'undefined') {
      console.warn('[DBv5] Dexie not loaded, using localStorage fallback');
      return this._initFallback();
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
    this._initialized = true;
    
    console.log('[DBv5] IndexedDB initialized (Optimized)');
    return this._db;
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

    try {
      await this._db.events.bulkAdd(events);
      console.log(`[DBv5] Bulk added ${events.length} events`);
      return events.length;
    } catch (error) {
      console.error('[DBv5] bulkAddEvents error:', error);
      // Fallback: add one by one
      let added = 0;
      for (const event of events) {
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

    try {
      await this._db.events.bulkUpdate(updates);
      console.log(`[DBv5] Bulk updated ${updates.length} events`);
      return updates.length;
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

    try {
      return await this._db.events
        .where('[status+createdAt]')
        .between(['pending', Dexie.minKey], ['pending', Dexie.maxKey])
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

    try {
      if (syncStatus) {
        return await this._db.events
          .where('[entity+syncStatus+createdAt]')
          .between([entity, syncStatus, Dexie.minKey], [entity, syncStatus, Dexie.maxKey])
          .limit(limit)
          .toArray();
      }
      
      return await this._db.events
        .where('entity')
        .equals(entity)
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
    
    try {
      await this._db.events.update(eventId, {
        ...updates,
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
      
      await this._db.events.update(eventId, {
        retryCount,
        lastError: error,
        lastRetryAt: Date.now(),
        status: retryCount >= MAX_RETRIES ? 'failed' : 'pending',
        syncStatus: retryCount >= MAX_RETRIES ? 'failed' : 'pending',
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

    try {
      const now = Date.now();
      const entities = items.map(item => ({
        ...item,
        entity,
        updatedAt: now,
      }));
      
      await this._db.entities.bulkPut(entities);
      console.log(`[DBv5] Bulk upserted ${items.length} ${entity}`);
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

  // ── Helpers ────────────────────────────────────────────────

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
    if (!this._db) return {};

    const [pendingEvents, syncedEvents, failedEvents, queueItems] = await Promise.all([
      this._db.events.where('status').equals('pending').count(),
      this._db.events.where('status').equals('synced').count(),
      this._db.events.where('status').equals('failed').count(),
      this._db.syncQueue.where('status').equals('pending').count(),
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

console.log('[DBv5] BeerPOSDB v5 loaded (Optimized)');
