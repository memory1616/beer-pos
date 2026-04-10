/**
 * BeerPOS - API Response Helpers
 * ─────────────────────────────────────────────────────────────────────────────
 * Helper functions cho việc tạo API responses theo chuẩn production
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { generateUUID } = require('../../database/migration');
const { actionLogger, ACTIONS, ENTITIES } = require('../services/ActionLogger');
const { applySoftDelete, restoreSoftDelete, getSoftDeleteFilter } = require('../middleware/softDelete');

/**
 * Tạo success response
 */
function success(data = {}, message = null) {
  const response = {
    success: true,
    timestamp: new Date().toISOString(),
    ...data,
  };
  if (message) {
    response.message = message;
  }
  return response;
}

/**
 * Tạo error response
 */
function error(message, details = null, statusCode = 400) {
  return {
    success: false,
    error: message,
    details,
    timestamp: new Date().toISOString(),
    statusCode,
  };
}

/**
 * Tạo paginated response
 */
function paginated(items, total, page, limit, extras = {}) {
  return {
    success: true,
    data: items,
    pagination: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / limit),
      hasMore: page * limit < total,
    },
    timestamp: new Date().toISOString(),
    ...extras,
  };
}

/**
 * Tạo full state response
 */
function fullState(data, meta = {}) {
  return {
    success: true,
    timestamp: new Date().toISOString(),
    ...data,
    meta: {
      serverVersion: '2.0',
      date: new Date().toISOString().split('T')[0],
      ...meta,
    },
  };
}

/**
 * Tạo delta response
 */
function delta(changes, lastSync, meta = {}) {
  return {
    success: true,
    timestamp: new Date().toISOString(),
    lastSync,
    changes,
    meta: {
      serverVersion: '2.0',
      changeCount: Object.values(changes).reduce((sum, arr) => sum + arr.length, 0),
      ...meta,
    },
  };
}

/**
 * Standard CRUD handler factory
 */
function createCrudHandlers(entity, tableName, options = {}) {
  const {
    logActions = true,
    useSoftDelete = true,
    emitEvent = null,
  } = options;

  return {
    /**
     * List handler
     */
    list: (req, res) => {
      try {
        const { page = 1, limit = 50, fields, ...filters } = req.query;
        const offset = (page - 1) * limit;

        let sql = `SELECT * FROM ${tableName}`;
        const params = [];

        // Add soft delete filter
        if (useSoftDelete) {
          sql += ` WHERE ${getSoftDeleteFilter()}`;
        }

        // Add filters
        for (const [key, value] of Object.entries(filters)) {
          if (value !== undefined && value !== '') {
            sql += ` AND ${key} = ?`;
            params.push(value);
          }
        }

        // Get total
        const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
        const { total } = db.prepare(countSql).get(...params);

        // Get items
        sql += ` ORDER BY id DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        let items;
        if (fields) {
          const fieldList = fields.split(',').map(f => f.trim()).join(', ');
          items = db.prepare(sql.replace('SELECT *', `SELECT ${fieldList}`)).all(...params);
        } else {
          items = db.prepare(sql).all(...params);
        }

        res.json(paginated(items, total, page, limit));
      } catch (err) {
        console.error(`Error listing ${entity}`, err);
        res.status(500).json(error(`Lỗi khi lấy danh sách ${entity}`));
      }
    },

    /**
     * Get by ID handler
     */
    get: (req, res) => {
      try {
        const { id } = req.params;

        let sql = `SELECT * FROM ${tableName} WHERE id = ?`;
        const params = [id];

        if (useSoftDelete) {
          sql += ` AND ${getSoftDeleteFilter()}`;
        }

        const item = db.prepare(sql).get(...params);

        if (!item) {
          return res.status(404).json(error(`${entity} không tìm thấy`, null, 404));
        }

        res.json(success(item));
      } catch (err) {
        console.error(`Error getting ${entity}`, err);
        res.status(500).json(error(`Lỗi khi lấy ${entity}`));
      }
    },

    /**
     * Create handler
     */
    create: (req, res) => {
      try {
        const data = req.body;
        const uuid = generateUUID();

        // Log action
        if (logActions) {
          actionLogger.log(ACTIONS[`${entity.toUpperCase()}_CREATE`], entity, null, {
            payload: data,
            actorId: req.user?.id,
            actorName: req.user?.name,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
          });
        }

        // Emit event
        if (emitEvent) {
          emitEvent('created', data);
        }

        res.status(201).json(success({ id: data.id || data.lastInsertRowid, uuid }));
      } catch (err) {
        console.error(`Error creating ${entity}`, err);
        res.status(500).json(error(`Lỗi khi tạo ${entity}`));
      }
    },

    /**
     * Update handler
     */
    update: (req, res) => {
      try {
        const { id } = req.params;
        const data = req.body;

        // Log action
        if (logActions) {
          const previous = db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id);
          actionLogger.log(ACTIONS[`${entity.toUpperCase()}_UPDATE`], entity, id, {
            payload: data,
            previousState: previous,
            actorId: req.user?.id,
            actorName: req.user?.name,
          });
        }

        // Emit event
        if (emitEvent) {
          emitEvent('updated', { id, ...data });
        }

        res.json(success({ id, updated: true }));
      } catch (err) {
        console.error(`Error updating ${entity}`, err);
        res.status(500).json(error(`Lỗi khi cập nhật ${entity}`));
      }
    },

    /**
     * Delete handler (soft delete)
     */
    delete: (req, res) => {
      try {
        const { id } = req.params;

        if (useSoftDelete) {
          // Soft delete
          const success = applySoftDelete(db, tableName, id);

          if (!success) {
            return res.status(404).json(error(`${entity} không tìm thấy`, null, 404));
          }

          // Log action
          if (logActions) {
            actionLogger.log(ACTIONS[`${entity.toUpperCase()}_DELETE`], entity, id, {
              actorId: req.user?.id,
              actorName: req.user?.name,
            });
          }

          // Emit event
          if (emitEvent) {
            emitEvent('deleted', { id });
          }

          res.json(success({ id, deleted: true }, `${entity} đã được xóa`));
        } else {
          // Hard delete
          db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(id);
          res.json(success({ id, deleted: true }, `${entity} đã được xóa`));
        }
      } catch (err) {
        console.error(`Error deleting ${entity}`, err);
        res.status(500).json(error(`Lỗi khi xóa ${entity}`));
      }
    },

    /**
     * Restore handler (restore soft-deleted)
     */
    restore: (req, res) => {
      try {
        const { id } = req.params;

        const success = restoreSoftDelete(db, tableName, id);

        if (!success) {
          return res.status(404).json(error(`${entity} không tìm thấy`, null, 404));
        }

        // Log action
        if (logActions) {
          actionLogger.log(ACTIONS[`${entity.toUpperCase()}_RESTORE`], entity, id, {
            actorId: req.user?.id,
            actorName: req.user?.name,
          });
        }

        // Emit event
        if (emitEvent) {
          emitEvent('restored', { id });
        }

        res.json(success({ id, restored: true }, `${entity} đã được khôi phục`));
      } catch (err) {
        console.error(`Error restoring ${entity}`, err);
        res.status(500).json(error(`Lỗi khi khôi phục ${entity}`));
      }
    },
  };
}

// ── Export ────────────────────────────────────────────────────────────────────

module.exports = {
  success,
  error,
  paginated,
  fullState,
  delta,
  createCrudHandlers,
};
