/**
 * BeerPOS - Action Logger (Hệ thống ghi log hành động)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lưu tất cả actions vào bảng action_logs với khả năng replay.
 * 
 * Tính năng:
 * - Ghi log tất cả CRUD operations
 * - Lưu trạng thái trước và sau khi thay đổi
 * - Hỗ trợ replay để khôi phục trạng thái
 * - Phân quyền actor (ai thực hiện)
 * - Sync tracking
 * ─────────────────────────────────────────────────────────────────────────────
 */

const db = require('../database');
const { generateUUID } = require('../database/migration');
const logger = require('../utils/logger');

// ── Constants ──────────────────────────────────────────────────────────────────

const ACTIONS = {
  // Sale actions
  SALE_CREATE: 'sale:create',
  SALE_UPDATE: 'sale:update',
  SALE_DELETE: 'sale:delete',
  SALE_RETURN: 'sale:return',
  
  // Customer actions
  CUSTOMER_CREATE: 'customer:create',
  CUSTOMER_UPDATE: 'customer:update',
  CUSTOMER_DELETE: 'customer:delete',
  CUSTOMER_ARCHIVE: 'customer:archive',
  
  // Product actions
  PRODUCT_CREATE: 'product:create',
  PRODUCT_UPDATE: 'product:update',
  PRODUCT_DELETE: 'product:delete',
  PRODUCT_STOCK_UPDATE: 'product:stock_update',
  
  // Expense actions
  EXPENSE_CREATE: 'expense:create',
  EXPENSE_UPDATE: 'expense:update',
  EXPENSE_DELETE: 'expense:delete',
  
  // Purchase actions
  PURCHASE_CREATE: 'purchase:create',
  PURCHASE_UPDATE: 'purchase:update',
  PURCHASE_DELETE: 'purchase:delete',
  
  // Payment actions
  PAYMENT_CREATE: 'payment:create',
  PAYMENT_UPDATE: 'payment:update',
  PAYMENT_DELETE: 'payment:delete',
  
  // Keg actions
  KEG_DELIVER: 'keg:deliver',
  KEG_COLLECT: 'keg:collect',
  KEG_IMPORT: 'keg:import',
  KEG_ADJUST: 'keg:adjust',
  
  // Sync actions
  SYNC_PUSH: 'sync:push',
  SYNC_PULL: 'sync:pull',
  SYNC_CONFLICT: 'sync:conflict',
  SYNC_RESOLVE: 'sync:resolve',
};

const ENTITIES = {
  SALE: 'sales',
  CUSTOMER: 'customers',
  PRODUCT: 'products',
  EXPENSE: 'expenses',
  PURCHASE: 'purchases',
  PAYMENT: 'payments',
  KEG: 'keg_transactions_log',
  DEVICE: 'devices',
  PRICE: 'prices',
};

// ── Action Logger Class ────────────────────────────────────────────────────────

class ActionLogger {
  constructor(options = {}) {
    this.options = {
      maxRetentionDays: options.maxRetentionDays || 90, // Giữ log 90 ngày
      batchSize: options.batchSize || 100,
      asyncMode: options.asyncMode !== false, // Mặc định là async
      ...options,
    };
    
    this._queue = [];
    this._flushTimer = null;
    this._isProcessing = false;
  }

  // ── Core Logging ────────────────────────────────────────────────────────────

  /**
   * Ghi một action vào log
   */
  log(action, entity, entityId, options = {}) {
    const {
      payload = null,
      previousState = null,
      actorId = null,
      actorName = null,
      ipAddress = null,
      userAgent = null,
      metadata = null,
    } = options;

    const logEntry = {
      uuid: generateUUID(),
      action,
      entity,
      entity_id: entityId,
      payload: payload ? JSON.stringify(payload) : null,
      previous_state: previousState ? JSON.stringify(previousState) : null,
      actor_id: actorId,
      actor_name: actorName,
      ip_address: ipAddress,
      user_agent: userAgent,
      metadata: metadata ? JSON.stringify(metadata) : null,
      created_at: new Date().toISOString(),
      synced: 0,
    };

    if (this.options.asyncMode) {
      this._queueLog(logEntry);
    } else {
      this._writeLog(logEntry);
    }

    logger.debug(`[ACTION_LOG] ${action} on ${entity}:${entityId}`);

    return logEntry.uuid;
  }

  /**
   * Ghi log với transaction context
   */
  logWithTransaction(action, entity, entityId, txContext = {}) {
    return this.log(action, entity, entityId, {
      ...txContext,
      metadata: JSON.stringify({
        transactionId: txContext.transactionId,
        elapsed: txContext.elapsed,
        affectedRows: txContext.affectedRows,
      }),
    });
  }

  // ── Queue Management ────────────────────────────────────────────────────────

  _queueLog(entry) {
    this._queue.push(entry);

    if (this._queue.length >= this.options.batchSize) {
      this._flush();
    } else if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this._flush(), 1000);
    }
  }

  _flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }

    if (this._queue.length === 0 || this._isProcessing) {
      return;
    }

    this._isProcessing = true;
    const entries = this._queue.splice(0, this._queue.length);

    try {
      this._writeBatch(entries);
    } catch (error) {
      logger.error('[ACTION_LOG] Batch write failed', { error: error.message });
      // Thử ghi lại từng entry
      for (const entry of entries) {
        try {
          this._writeLog(entry);
        } catch (e) {
          logger.error('[ACTION_LOG] Single write failed', { uuid: entry.uuid, error: e.message });
        }
      }
    } finally {
      this._isProcessing = false;
    }
  }

  _writeLog(entry) {
    db.prepare(`
      INSERT INTO action_logs (
        uuid, action, entity, entity_id, payload, previous_state,
        actor_id, actor_name, ip_address, user_agent, metadata, created_at, synced
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.uuid,
      entry.action,
      entry.entity,
      entry.entity_id,
      entry.payload,
      entry.previous_state,
      entry.actor_id,
      entry.actor_name,
      entry.ip_address,
      entry.user_agent,
      entry.metadata,
      entry.created_at,
      0
    );
  }

  _writeBatch(entries) {
    const stmt = db.prepare(`
      INSERT INTO action_logs (
        uuid, action, entity, entity_id, payload, previous_state,
        actor_id, actor_name, ip_address, user_agent, metadata, created_at, synced
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((items) => {
      for (const entry of items) {
        stmt.run(
          entry.uuid,
          entry.action,
          entry.entity,
          entry.entity_id,
          entry.payload,
          entry.previous_state,
          entry.actor_id,
          entry.actor_name,
          entry.ip_address,
          entry.user_agent,
          entry.metadata,
          entry.created_at,
          0
        );
      }
    });

    insertMany(entries);
  }

  // ── Query Methods ──────────────────────────────────────────────────────────

  /**
   * Lấy log của một entity
   */
  getEntityLogs(entity, entityId, options = {}) {
    const { limit = 50, offset = 0 } = options;

    return db.prepare(`
      SELECT * FROM action_logs
      WHERE entity = ? AND entity_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(entity, String(entityId), limit, offset);
  }

  /**
   * Lấy tất cả log theo action type
   */
  getLogsByAction(action, options = {}) {
    const { limit = 100, startDate, endDate } = options;

    let sql = `SELECT * FROM action_logs WHERE action = ?`;
    const params = [action];

    if (startDate) {
      sql += ` AND created_at >= ?`;
      params.push(startDate);
    }
    if (endDate) {
      sql += ` AND created_at <= ?`;
      params.push(endDate);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    return db.prepare(sql).all(...params);
  }

  /**
   * Lấy log theo khoảng thời gian
   */
  getLogsByDateRange(startDate, endDate, options = {}) {
    const { entity, action, limit = 500 } = options;

    let sql = `SELECT * FROM action_logs WHERE created_at BETWEEN ? AND ?`;
    const params = [startDate, endDate];

    if (entity) {
      sql += ` AND entity = ?`;
      params.push(entity);
    }
    if (action) {
      sql += ` AND action = ?`;
      params.push(action);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    return db.prepare(sql).all(...params);
  }

  /**
   * Tìm kiếm log theo từ khóa
   */
  search(query, options = {}) {
    const { entity, action, limit = 50 } = options;

    let sql = `
      SELECT * FROM action_logs
      WHERE (payload LIKE ? OR metadata LIKE ? OR actor_name LIKE ?)
    `;
    const searchTerm = `%${query}%`;
    const params = [searchTerm, searchTerm, searchTerm];

    if (entity) {
      sql += ` AND entity = ?`;
      params.push(entity);
    }
    if (action) {
      sql += ` AND action = ?`;
      params.push(action);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    return db.prepare(sql).all(...params);
  }

  // ── Replay Functions ────────────────────────────────────────────────────────

  /**
   * Lấy trạng thái trước của một entity tại thời điểm cụ thể
   */
  getStateAtTime(entity, entityId, timestamp) {
    const logs = db.prepare(`
      SELECT * FROM action_logs
      WHERE entity = ? AND entity_id = ? AND created_at < ?
      ORDER BY created_at DESC
      LIMIT 1
    `).all(entity, String(entityId), timestamp);

    if (logs.length === 0) {
      return null;
    }

    return JSON.parse(logs[0].previous_state || '{}');
  }

  /**
   * Replay tất cả actions để khôi phục trạng thái
   */
  replay(entity, entityId, options = {}) {
    const { upToTimestamp = null, limit = 1000 } = options;

    let sql = `
      SELECT * FROM action_logs
      WHERE entity = ? AND entity_id = ?
    `;
    const params = [entity, String(entityId)];

    if (upToTimestamp) {
      sql += ` AND created_at <= ?`;
      params.push(upToTimestamp);
    }

    sql += ` ORDER BY created_at ASC LIMIT ?`;
    params.push(limit);

    const logs = db.prepare(sql).all(...params);

    const replayResult = {
      entity,
      entityId,
      totalActions: logs.length,
      actions: [],
      finalState: null,
    };

    for (const log of logs) {
      replayResult.actions.push({
        action: log.action,
        timestamp: log.created_at,
        payload: JSON.parse(log.payload || '{}'),
        previousState: JSON.parse(log.previous_state || 'null'),
      });
    }

    return replayResult;
  }

  /**
   * Get changes between two timestamps
   */
  getChangesBetween(startTime, endTime, entity = null) {
    let sql = `
      SELECT action, entity, entity_id, payload, created_at
      FROM action_logs
      WHERE created_at BETWEEN ? AND ?
    `;
    const params = [startTime, endTime];

    if (entity) {
      sql += ` AND entity = ?`;
      params.push(entity);
    }

    sql += ` ORDER BY created_at ASC`;

    return db.prepare(sql).all(...params);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  /**
   * Xóa log cũ hơn retention period
   */
  cleanup() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.options.maxRetentionDays);
    const cutoffStr = cutoffDate.toISOString();

    try {
      const result = db.prepare(`
        DELETE FROM action_logs WHERE created_at < ?
      `).run(cutoffStr);

      logger.info(`[ACTION_LOG] Cleaned up ${result.changes} old log entries`);
      return result.changes;
    } catch (error) {
      logger.error('[ACTION_LOG] Cleanup failed', { error: error.message });
      return 0;
    }
  }

  /**
   * Đánh dấu log đã sync
   */
  markSynced(uuid) {
    return db.prepare(`
      UPDATE action_logs SET synced = 1, synced_at = CURRENT_TIMESTAMP WHERE uuid = ?
    `).run(uuid);
  }

  /**
   * Đánh dấu nhiều logs đã sync
   */
  markBatchSynced(uuids) {
    if (!uuids || uuids.length === 0) return 0;

    const placeholders = uuids.map(() => '?').join(',');
    return db.prepare(`
      UPDATE action_logs SET synced = 1, synced_at = CURRENT_TIMESTAMP WHERE uuid IN (${placeholders})
    `).run(...uuids);
  }

  // ── Statistics ─────────────────────────────────────────────────────────────

  /**
   * Lấy thống kê log
   */
  getStats(options = {}) {
    const { days = 7 } = options;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffStr = cutoffDate.toISOString();

    const byAction = db.prepare(`
      SELECT action, COUNT(*) as count
      FROM action_logs
      WHERE created_at >= ?
      GROUP BY action
      ORDER BY count DESC
    `).all(cutoffStr);

    const byEntity = db.prepare(`
      SELECT entity, COUNT(*) as count
      FROM action_logs
      WHERE created_at >= ?
      GROUP BY entity
      ORDER BY count DESC
    `).all(cutoffStr);

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM action_logs WHERE created_at >= ?
    `).get(cutoffStr);

    const unsynced = db.prepare(`
      SELECT COUNT(*) as count FROM action_logs WHERE synced = 0
    `).get();

    return {
      total: total.count,
      unsynced: unsynced.count,
      byAction,
      byEntity,
      period: `${days} days`,
      cutoffDate: cutoffStr,
    };
  }
}

// ── Singleton Instance ─────────────────────────────────────────────────────────

const actionLogger = new ActionLogger({
  asyncMode: true,
  maxRetentionDays: 90,
  batchSize: 50,
});

// ── Helper Functions ───────────────────────────────────────────────────────────

/**
 * Ghi log nhanh cho một action
 */
function logAction(action, entity, entityId, options = {}) {
  return actionLogger.log(action, entity, entityId, options);
}

/**
 * Ghi log với request context (từ HTTP request)
 */
function logActionFromRequest(req, action, entity, entityId, options = {}) {
  return actionLogger.log(action, entity, entityId, {
    ...options,
    actorId: req.user?.id || null,
    actorName: req.user?.name || null,
    ipAddress: req.ip || req.connection?.remoteAddress || null,
    userAgent: req.get('user-agent') || null,
  });
}

/**
 * Lấy trạng thái trước của một entity trước khi update
 */
function getPreviousState(entity, entityId) {
  try {
    const tableMap = {
      [ENTITIES.SALE]: 'sales',
      [ENTITIES.CUSTOMER]: 'customers',
      [ENTITIES.PRODUCT]: 'products',
      [ENTITIES.EXPENSE]: 'expenses',
      [ENTITIES.PURCHASE]: 'purchases',
      [ENTITIES.PAYMENT]: 'payments',
    };

    const table = tableMap[entity] || entity;
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(entityId);

    return row || null;
  } catch (error) {
    logger.warn('[ACTION_LOG] Could not get previous state', { entity, entityId, error: error.message });
    return null;
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

module.exports = {
  ActionLogger,
  actionLogger,
  ACTIONS,
  ENTITIES,
  logAction,
  logActionFromRequest,
  getPreviousState,
};
