/**
 * BeerPOS - Soft Delete Middleware
 * ─────────────────────────────────────────────────────────────────────────────
 * Chuyển đổi DELETE requests thành soft delete
 * Thêm query filtering để luôn exclude deleted records
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Convert DELETE to soft delete
 */
function softDeleteMiddleware(req, res, next) {
  if (req.method === 'DELETE' && !req.path.includes('/archive')) {
    // Store original delete info
    req.softDelete = true;
    req.softDeleteEntity = getEntityFromPath(req.path);
    
    // Override send to convert DELETE to UPDATE
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      // The actual soft delete is handled in the route
      return originalJson(data);
    };
  }
  next();
}

/**
 * Extract entity name from path
 */
function getEntityFromPath(path) {
  const patterns = [
    { regex: /^\/api\/sales/, entity: 'sales' },
    { regex: /^\/api\/customers/, entity: 'customers' },
    { regex: /^\/api\/products/, entity: 'products' },
    { regex: /^\/api\/expenses/, entity: 'expenses' },
    { regex: /^\/api\/payments/, entity: 'payments' },
    { regex: /^\/api\/purchases/, entity: 'purchases' },
    { regex: /^\/api\/devices/, entity: 'devices' },
  ];

  for (const pattern of patterns) {
    if (pattern.regex.test(path)) {
      return pattern.entity;
    }
  }
  return null;
}

/**
 * Apply soft delete to a record
 */
function applySoftDelete(db, entity, id) {
  try {
    const result = db.prepare(`
      UPDATE ${entity}
      SET deleted = 1,
          updated_at = CURRENT_TIMESTAMP,
          version = version + 1
      WHERE id = ?
    `).run(id);
    return result.changes > 0;
  } catch (error) {
    console.error(`Soft delete failed for ${entity}:${id}`, error);
    return false;
  }
}

/**
 * Restore a soft-deleted record
 */
function restoreSoftDelete(db, entity, id) {
  try {
    const result = db.prepare(`
      UPDATE ${entity}
      SET deleted = 0,
          updated_at = CURRENT_TIMESTAMP,
          version = version + 1
      WHERE id = ?
    `).run(id);
    return result.changes > 0;
  } catch (error) {
    console.error(`Restore failed for ${entity}:${id}`, error);
    return false;
  }
}

/**
 * Get soft delete filter clause
 */
function getSoftDeleteFilter(tableAlias = '') {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  return `(${prefix}deleted = 0 OR ${prefix}deleted IS NULL)`;
}

/**
 * Add soft delete filter to WHERE clause
 */
function addSoftDeleteFilter(sql, params, tableAlias = '') {
  const filter = getSoftDeleteFilter(tableAlias);
  if (sql.toUpperCase().includes('WHERE')) {
    return {
      sql: `${sql} AND ${filter}`,
      params,
    };
  } else {
    return {
      sql: `${sql} WHERE ${filter}`,
      params,
    };
  }
}

module.exports = {
  softDeleteMiddleware,
  applySoftDelete,
  restoreSoftDelete,
  getSoftDeleteFilter,
  addSoftDeleteFilter,
  getEntityFromPath,
};
