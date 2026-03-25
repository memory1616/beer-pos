/**
 * Audit Service - Feature #12
 * Ghi log tất cả thay đổi vào bảng audit_log
 * Ai sửa gì, lúc nào, từ đâu, giá trị cũ/mới ra sao
 */
const db = require('../../database');

/**
 * Tạo audit log entry
 * @param {Object} params
 * @param {string} params.entityType - Loại entity: 'sale', 'customer', 'product', 'expense', 'keg', etc.
 * @param {number} params.entityId - ID của bản ghi
 * @param {string} params.action - 'create' | 'update' | 'delete' | 'restore'
 * @param {Object|null} params.oldValue - Object cũ (null khi create)
 * @param {Object|null} params.newValue - Object mới (null khi delete)
 * @param {Object} req - Express request object (để lấy user info, IP)
 */
function logAudit({ entityType, entityId, action, oldValue, newValue, changedFields = null }, req = {}) {
  try {
    // Trích xuất user info từ request
    const userId = req.user?.username || req.session?.username || 'system';
    const ipAddress = req.ip || req.connection?.remoteAddress || req.headers?.['x-forwarded-for'] || '';
    const userAgent = req.headers?.['user-agent'] || '';
    const sessionId = req.cookies?.[AUTH_CONFIG?.cookieName] || req.headers?.['x-session-id'] || '';

    // Determine source
    let source = 'web';
    if (req.baseUrl?.startsWith('/api/sync')) source = 'sync';
    else if (req.baseUrl?.startsWith('/api')) source = 'api';
    else if (entityType === 'migration') source = 'migration';

    // Calculate changed fields if not provided
    let finalChangedFields = changedFields;
    if (!finalChangedFields && oldValue && newValue) {
      finalChangedFields = Object.keys(newValue).filter(key => {
        const oldVal = JSON.stringify(oldValue[key]);
        const newVal = JSON.stringify(newValue[key]);
        return oldVal !== newVal;
      });
    }

    db.prepare(`
      INSERT INTO audit_log (entity_type, entity_id, action, old_value, new_value, changed_fields, user_id, ip_address, user_agent, session_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entityType,
      entityId,
      action,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      finalChangedFields ? JSON.stringify(finalChangedFields) : null,
      userId,
      ipAddress,
      userAgent,
      sessionId,
      source
    );
  } catch (e) {
    console.error('Audit log error:', e.message);
    // Không throw để không ảnh hưởng đến flow chính
  }
}

/**
 * Lấy audit log theo entity
 * @param {string} entityType
 * @param {number} entityId
 * @param {Object} options
 * @returns {Array}
 */
function getAuditLog(entityType, entityId, options = {}) {
  const { limit = 50, offset = 0, actions = null } = options;

  let query = `
    SELECT * FROM audit_log
    WHERE entity_type = ? AND entity_id = ?
  `;
  const params = [entityType, entityId];

  if (actions) {
    const placeholders = actions.map(() => '?').join(',');
    query += ` AND action IN (${placeholders})`;
    params.push(...actions);
  }

  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(query).all(...params);
}

/**
 * Lấy audit log theo user
 * @param {string} userId
 * @param {Object} options
 * @returns {Array}
 */
function getAuditLogByUser(userId, options = {}) {
  const { limit = 50, offset = 0, entityTypes = null } = options;

  let query = `SELECT * FROM audit_log WHERE user_id = ?`;
  const params = [userId];

  if (entityTypes) {
    const placeholders = entityTypes.map(() => '?').join(',');
    query += ` AND entity_type IN (${placeholders})`;
    params.push(...entityTypes);
  }

  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(query).all(...params);
}

/**
 * Lấy tất cả audit log với filter
 * @param {Object} options
 * @returns {Array}
 */
function getAllAuditLogs(options = {}) {
  const { limit = 100, offset = 0, entityType = null, action = null, userId = null, fromDate = null, toDate = null } = options;

  const conditions = [];
  const params = [];

  if (entityType) {
    conditions.push(`entity_type = ?`);
    params.push(entityType);
  }
  if (action) {
    conditions.push(`action = ?`);
    params.push(action);
  }
  if (userId) {
    conditions.push(`user_id = ?`);
    params.push(userId);
  }
  if (fromDate) {
    conditions.push(`created_at >= ?`);
    params.push(fromDate);
  }
  if (toDate) {
    conditions.push(`created_at <= ?`);
    params.push(toDate);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `
    SELECT * FROM audit_log
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  return db.prepare(query).all(...params);
}

/**
 * Lấy thống kê audit (ai nhiều thao tác nhất, loại thao tác nào phổ biến)
 * @param {Object} options
 * @returns {Object}
 */
function getAuditStats(options = {}) {
  const { days = 7 } = options;

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);

  // Top users
  const topUsers = db.prepare(`
    SELECT user_id, COUNT(*) as count
    FROM audit_log
    WHERE created_at >= ?
    GROUP BY user_id
    ORDER BY count DESC
    LIMIT 10
  `).all(fromDate.toISOString());

  // Top entities
  const topEntities = db.prepare(`
    SELECT entity_type, COUNT(*) as count
    FROM audit_log
    WHERE created_at >= ?
    GROUP BY entity_type
    ORDER BY count DESC
  `).all(fromDate.toISOString());

  // Actions breakdown
  const actionsBreakdown = db.prepare(`
    SELECT action, COUNT(*) as count
    FROM audit_log
    WHERE created_at >= ?
    GROUP BY action
  `).all(fromDate.toISOString());

  // Recent creates/updates/deletes
  const summary = db.prepare(`
    SELECT action, COUNT(*) as count
    FROM audit_log
    WHERE created_at >= ?
    GROUP BY action
  `).all(fromDate.toISOString());

  return { topUsers, topEntities, actionsBreakdown, summary, fromDate: fromDate.toISOString() };
}

// ================================================================
// Helper: Auto-generate audit for common CRUD operations
// ================================================================

/**
 * Wrapper để tự động audit một hành động create/update/delete
 * Trả về middleware hoặc wrapper function
 */
function auditWrapper(operation, entityType, getEntityId, req) {
  return async (callback) => {
    // Lấy giá trị cũ nếu là update/delete
    let oldValue = null;
    if (operation !== 'create') {
      try {
        const id = typeof getEntityId === 'function' ? getEntityId(req) : getEntityId;
        const entity = db.prepare(`SELECT * FROM ${entityType}s WHERE id = ?`).get(id);
        oldValue = entity;
      } catch (e) {
        console.warn(`Audit: Could not fetch old value for ${entityType}`);
      }
    }

    // Thực hiện operation
    const result = await callback();

    // Lấy entity ID mới nếu là create
    const entityId = operation === 'create'
      ? (typeof getEntityId === 'function' ? getEntityId(result) : result?.id)
      : (typeof getEntityId === 'function' ? getEntityId(req) : getEntityId);

    // Log audit
    logAudit({
      entityType,
      entityId,
      action: operation,
      oldValue,
      newValue: operation === 'delete' ? oldValue : result
    }, req);

    return result;
  };
}

module.exports = {
  logAudit,
  getAuditLog,
  getAuditLogByUser,
  getAllAuditLogs,
  getAuditStats,
  auditWrapper
};
