/**
 * Audit Log API — Nhật ký thao tác (A3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount tại /api/audit-log — CHỈ ADMIN.
 *
 * Endpoint:
 *  GET  /api/audit-log          — danh sách nhật ký (lọc + phân trang)
 *  GET  /api/audit-log/stats    — thống kê nhanh (7 ngày gần nhất)
 *  GET  /api/audit-log/actions  — danh mục action để lọc
 *  POST /api/audit-log/purge    — xoá nhật ký cũ hơn N ngày
 */

const express = require('express');
const router = express.Router();
const logger = require('../../src/utils/logger');
const AuditLogService = require('../../src/services/AuditLogService');
const { ROLE_ADMIN } = require('../../middleware/permissions');

// ── Chỉ ADMIN ───────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }
  if (req.user.role !== ROLE_ADMIN) {
    return res.status(403).json({
      error: 'Chỉ quản trị viên mới được xem nhật ký hệ thống',
      code: 'ADMIN_ONLY',
    });
  }
  next();
}

// ── GET / — danh sách nhật ký ───────────────────────────────────────────────
router.get('/', requireAdmin, (req, res) => {
  try {
    const q = req.query || {};
    const result = AuditLogService.list({
      limit: q.limit,
      offset: q.offset || (q.page ? (Math.max(1, parseInt(q.page) || 1) - 1) * (parseInt(q.limit) || 50) : 0),
      actor: q.actor,
      action: q.action,
      entity: q.entity,
      entityId: q.entityId,
      status: q.status,
      from: q.from,
      to: q.to,
      search: q.search,
    });

    res.json({
      success: true,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      logs: result.logs,
    });
  } catch (err) {
    logger.error('[AUDIT] list error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải nhật ký hệ thống' });
  }
});

// ── GET /stats ───────────────────────────────────────────────────────────────
router.get('/stats', requireAdmin, (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 7));
    res.json({ success: true, stats: AuditLogService.stats(days) });
  } catch (err) {
    logger.error('[AUDIT] stats error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải thống kê nhật ký' });
  }
});

// ── GET /actions ─────────────────────────────────────────────────────────────
router.get('/actions', requireAdmin, (req, res) => {
  res.json({
    success: true,
    actions: Object.values(AuditLogService.ACTIONS),
  });
});

// ── POST /purge ──────────────────────────────────────────────────────────────
router.post('/purge', requireAdmin, (req, res) => {
  try {
    const days = Math.min(3650, Math.max(1, parseInt(req.body?.days) || 90));
    const result = AuditLogService.purge(days);

    // Ghi lại chính thao tác xoá (sau khi xoá để không bị xoá mất)
    AuditLogService.recordFromRequest(req, 'audit_log_purged', {
      description: `Xoá ${result.deleted} dòng nhật ký cũ hơn ${days} ngày`,
      changes: { days: { from: null, to: days }, deleted: { from: null, to: result.deleted } },
    });

    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[AUDIT] purge error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi dọn nhật ký cũ' });
  }
});

module.exports = router;
module.exports.requireAdmin = requireAdmin;
