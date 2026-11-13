/**
 * Push Notification API — Web Push cho tài xế
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount tại /api/push.
 *
 *  PHẦN TÀI XẾ (requireDriver — role DRIVER trong session):
 *   GET  /api/push/vapid-key    — lấy public key (client dùng để subscribe)
 *   POST /api/push/subscribe    — lưu subscription của thiết bị
 *   POST /api/push/unsubscribe  — xoá subscription
 *   GET  /api/push/status       — trạng thái push của chính mình
 *
 *  PHẦN ADMIN (requireAdmin):
 *   GET  /api/push/admin/config     — đọc cấu hình + trạng thái
 *   POST /api/push/admin/config     — lưu cấu hình (bật/tắt, template)
 *   GET  /api/push/admin/stats      — số thiết bị theo tài xế
 *   GET  /api/push/admin/history    — lịch sử gửi push
 *   POST /api/push/admin/test/:username — gửi thử cho 1 tài xế
 */

const express = require('express');
const router = express.Router();
const logger = require('../../src/utils/logger');
const PushService = require('../../src/services/PushService');
const db = require('../../database');
const { ROLE_ADMIN, ROLE_DRIVER } = require('../../middleware/permissions');

// ── Guards ──────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }
  next();
}

function requireDriver(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }
  if (req.user.role !== ROLE_DRIVER) {
    return res.status(403).json({
      error: 'Chỉ tài xế mới dùng được chức năng này',
      code: 'DRIVER_ONLY',
    });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }
  if (req.user.role !== ROLE_ADMIN) {
    return res.status(403).json({
      error: 'Chỉ quản trị viên mới được cấu hình thông báo đẩy',
      code: 'ADMIN_ONLY',
    });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════════════════
// PHẦN TÀI XẾ
// ═══════════════════════════════════════════════════════════════════════════

// GET /vapid-key — public key để client subscribe
router.get('/vapid-key', requireAuth, (req, res) => {
  try {
    const publicKey = PushService.getPublicKey();
    if (!publicKey) {
      return res.status(503).json({
        error: 'Chưa cấu hình khóa VAPID. Vui lòng liên hệ quản trị viên.',
      });
    }
    res.json({ publicKey, enabled: PushService.isEnabled() });
  } catch (err) {
    logger.error('[api/push] vapid-key error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi lấy khóa VAPID' });
  }
});

// POST /subscribe — lưu subscription của thiết bị
router.post('/subscribe', requireDriver, (req, res) => {
  try {
    const { subscription } = req.body || {};
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Subscription không hợp lệ' });
    }

    const result = PushService.saveSubscription(
      req.user.username,
      subscription,
      req.get('user-agent') || null
    );
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'Không lưu được subscription' });
    }

    res.json({ success: true, username: req.user.username });
  } catch (err) {
    logger.error('[api/push] subscribe error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi đăng ký thông báo' });
  }
});

// POST /unsubscribe — xoá subscription
router.post('/unsubscribe', requireDriver, (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) {
      return res.status(400).json({ error: 'Thiếu endpoint' });
    }
    PushService.removeSubscription(req.user.username, endpoint);
    res.json({ success: true });
  } catch (err) {
    logger.error('[api/push] unsubscribe error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi huỷ đăng ký thông báo' });
  }
});

// GET /status — trạng thái push của chính mình
router.get('/status', requireDriver, (req, res) => {
  try {
    const rows = PushService.listSubscriptions(req.user.username);
    res.json({
      enabled: PushService.isEnabled(),
      devices: rows.length,
      lastUsedAt: rows.length ? rows[0].last_used_at : null,
    });
  } catch (err) {
    logger.error('[api/push] status error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi đọc trạng thái thông báo' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHẦN ADMIN
// ═══════════════════════════════════════════════════════════════════════════

// GET /admin/config
router.get('/admin/config', requireAdmin, (req, res) => {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('push_enabled');
    const titleRow = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('push_title_template');
    res.json({
      enabled: String(row?.value ?? '0') === '1',
      titleTemplate: titleRow?.value ?? '🔔 Đơn giao mới',
      publicKey: PushService.getPublicKey(),
      stats: PushService.statsByDriver(),
    });
  } catch (err) {
    logger.error('[api/push] admin/config error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi đọc cấu hình' });
  }
});

// POST /admin/config
router.post('/admin/config', requireAdmin, (req, res) => {
  try {
    const { enabled, titleTemplate } = req.body || {};
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

    if (typeof enabled !== 'undefined') {
      upsert.run('push_enabled', enabled ? '1' : '0');
    }
    if (typeof titleTemplate === 'string' && titleTemplate.trim()) {
      upsert.run('push_title_template', titleTemplate.trim().slice(0, 100));
    }

    logger.info('[api/push] config updated', {
      enabled,
      by: req.user.username,
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('[api/push] admin/config save error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi lưu cấu hình' });
  }
});

// GET /admin/history
router.get('/admin/history', requireAdmin, (req, res) => {
  try {
    res.json({ history: PushService.getHistory(req.query.limit) });
  } catch (err) {
    logger.error('[api/push] admin/history error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải lịch sử' });
  }
});

// POST /admin/test/:username — gửi thử cho 1 tài xế
router.post('/admin/test/:username', requireAdmin, async (req, res) => {
  try {
    const username = String(req.params.username || '').trim();
    const driver = db
      .prepare('SELECT username FROM app_users WHERE username = ? AND role = ?')
      .get(username, ROLE_DRIVER);
    if (!driver) {
      return res.status(404).json({ error: 'Không tìm thấy tài xế' });
    }

    const result = await PushService.notifyDriver(username, {
      title: '🔔 BeerPOS — Thông báo thử',
      body: 'Đây là thông báo thử nghiệm. Tài xế sẽ nhận được đơn giao mới tương tự.',
      tag: 'beerpos-test',
      data: { type: 'test', url: '/driver' },
    });

    res.json({ success: result.sent > 0, ...result });
  } catch (err) {
    logger.error('[api/push] admin/test error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi gửi thử' });
  }
});

module.exports = router;
