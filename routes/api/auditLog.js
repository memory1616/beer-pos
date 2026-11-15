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
const AuditService = require('../../src/services/AuditService');
const AuditRetentionService = require('../../src/services/AuditRetentionService');
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
// Dọn CẢ 3 bảng nhật ký (audit_logs + product_audit_log + keg_transactions_log)
// theo retention. `days` (tuỳ chọn) ghi đè policy cho TẤT CẢ bảng.
// `dryRun=true` → chỉ đếm, không xoá (xem trước).
router.post('/purge', requireAdmin, (req, res) => {
  try {
    const days = req.body?.days ? Math.min(3650, Math.max(1, parseInt(req.body.days) || 90)) : null;
    const dryRun = req.body?.dryRun === true;

    const result = AuditService.purgeAll({
      ...(days ? { days } : {}),
      dryRun,
    });

    // Ghi lại chính thao tác xoá (sau khi xoá để không bị xoá mất)
    if (!dryRun) {
      AuditLogService.recordFromRequest(req, 'audit_log_purged', {
        description: `Dọn ${result.total} dòng nhật ký cũ (${JSON.stringify(result.policy)} ngày)`,
        changes: {
          days: { from: null, to: days || 'policy' },
          deleted: { from: null, to: result.total },
          deletedByTable: { from: null, to: result.deletedByTable },
        },
      });
    }

    res.json({ success: true, dryRun, ...result });
  } catch (err) {
    logger.error('[AUDIT] purge error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi dọn nhật ký cũ' });
  }
});

// ── GET /retention ───────────────────────────────────────────────────────────
// Thống kê 3 bảng nhật ký + policy retention hiện tại (admin chỉnh trong Settings).
router.get('/retention', requireAdmin, (req, res) => {
  try {
    res.json({ success: true, ...AuditRetentionService.stats() });
  } catch (err) {
    logger.error('[AUDIT] retention stats error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải thống kê bảng nhật ký' });
  }
});

// ── POST /retention-policy ───────────────────────────────────────────────────
// Cập nhật số ngày giữ cho từng bảng.
router.post('/retention-policy', requireAdmin, (req, res) => {
  try {
    const db = require('../../database');
    const map = {
      auditLogs: 'audit_log_retention_days',
      stockLogs: 'stock_log_retention_days',
      kegLogs: 'keg_log_retention_days',
    };
    const applied = {};
    for (const [key, settingKey] of Object.entries(map)) {
      if (req.body?.[key] == null) continue;
      const days = Math.min(3650, Math.max(1, parseInt(req.body[key]) || 1));
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(settingKey, String(days));
      applied[settingKey] = days;
    }
    AuditLogService.recordFromRequest(req, 'audit_log_retention_updated', {
      description: `Cập nhật retention: ${JSON.stringify(applied)}`,
      changes: applied,
    });
    res.json({ success: true, applied, policy: AuditService.retentionPolicy() });
  } catch (err) {
    logger.error('[AUDIT] update retention policy error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật chính sách lưu trữ nhật ký' });
  }
});

module.exports = router;
module.exports.requireAdmin = requireAdmin;
