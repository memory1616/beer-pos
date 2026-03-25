/**
 * Audit API - Feature #12
 * API endpoint để xem và query audit log
 */
const express = require('express');
const router = express.Router();
const { logAudit, getAuditLog, getAuditLogByUser, getAllAuditLogs, getAuditStats } = require('../../src/services/audit');

/**
 * GET /api/audit
 * Lấy danh sách audit log với filter
 */
router.get('/', (req, res) => {
  try {
    const {
      entity_type,
      entity_id,
      action,
      user_id,
      from_date,
      to_date,
      limit = 100,
      offset = 0
    } = req.query;

    let logs;
    const options = {
      limit: parseInt(limit),
      offset: parseInt(offset)
    };

    if (entity_type && entity_id) {
      // Lấy audit log của một entity cụ thể
      options.actions = action ? action.split(',') : null;
      logs = getAuditLog(entity_type, parseInt(entity_id), options);
    } else if (user_id) {
      // Lấy audit log của một user cụ thể
      options.entityTypes = entity_type ? entity_type.split(',') : null;
      logs = getAuditLogByUser(user_id, options);
    } else {
      // Lấy tất cả audit log với filter
      if (entity_type) options.entityType = entity_type;
      if (action) options.action = action;
      if (user_id) options.userId = user_id;
      if (from_date) options.fromDate = from_date;
      if (to_date) options.toDate = to_date;
      logs = getAllAuditLogs(options);
    }

    // Parse JSON fields for display
    const parsedLogs = logs.map(log => ({
      ...log,
      old_value: log.old_value ? JSON.parse(log.old_value) : null,
      new_value: log.new_value ? JSON.parse(log.new_value) : null,
      changed_fields: log.changed_fields ? JSON.parse(log.changed_fields) : null
    }));

    res.json({
      success: true,
      data: parsedLogs,
      count: parsedLogs.length,
      limit: options.limit,
      offset: options.offset
    });
  } catch (e) {
    console.error('Audit API error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/audit/stats
 * Lấy thống kê audit log
 */
router.get('/stats', (req, res) => {
  try {
    const { days = 7 } = req.query;
    const stats = getAuditStats({ days: parseInt(days) });
    res.json({ success: true, data: stats });
  } catch (e) {
    console.error('Audit stats error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/audit/entity/:type/:id
 * Lấy audit log của một entity cụ thể (route params)
 */
router.get('/entity/:type/:id', (req, res) => {
  try {
    const { type, id } = req.params;
    const { actions, limit = 50, offset = 0 } = req.query;

    const options = {
      limit: parseInt(limit),
      offset: parseInt(offset),
      actions: actions ? actions.split(',') : null
    };

    const logs = getAuditLog(type, parseInt(id), options);

    // Parse JSON fields
    const parsedLogs = logs.map(log => ({
      ...log,
      old_value: log.old_value ? JSON.parse(log.old_value) : null,
      new_value: log.new_value ? JSON.parse(log.new_value) : null,
      changed_fields: log.changed_fields ? JSON.parse(log.changed_fields) : null
    }));

    res.json({
      success: true,
      entity_type: type,
      entity_id: parseInt(id),
      data: parsedLogs,
      count: parsedLogs.length
    });
  } catch (e) {
    console.error('Audit entity error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/audit/user/:userId
 * Lấy audit log của một user cụ thể
 */
router.get('/user/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const { entity_types, limit = 50, offset = 0 } = req.query;

    const options = {
      limit: parseInt(limit),
      offset: parseInt(offset),
      entityTypes: entity_types ? entity_types.split(',') : null
    };

    const logs = getAuditLogByUser(userId, options);

    // Parse JSON fields
    const parsedLogs = logs.map(log => ({
      ...log,
      old_value: log.old_value ? JSON.parse(log.old_value) : null,
      new_value: log.new_value ? JSON.parse(log.new_value) : null,
      changed_fields: log.changed_fields ? JSON.parse(log.changed_fields) : null
    }));

    res.json({
      success: true,
      user_id: userId,
      data: parsedLogs,
      count: parsedLogs.length
    });
  } catch (e) {
    console.error('Audit user error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
