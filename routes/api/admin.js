/**
 * Admin API — Quản lý tài khoản tài xế (Driver Portal)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount tại /api/admin/drivers — CHỈ ADMIN được truy cập.
 *
 * Bảo mật:
 *  - requireAuth + role = ADMIN (driver bị chặn 403 từ apiGuard trước khi
 *    tới route này, vì /api/admin* không nằm trong whitelist DRIVER).
 *  - Response KHÔNG bao giờ chứa password_hash.
 *  - Driver KHÔNG thể tự tạo/tự nâng quyền — mọi thao tác đi qua đây.
 */

const express = require('express');
const router = express.Router();
const db = require('../../database');
const fs = require('fs');
const path = require('path');
const logger = require('../../src/utils/logger');
const UserService = require('../../src/services/UserService');
const { ROLE_ADMIN, ROLE_DRIVER } = require('../../middleware/permissions');

// ── Chỉ ADMIN ──────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }
  if (req.user.role !== ROLE_ADMIN) {
    return res.status(403).json({
      error: 'Chỉ quản trị viên mới được quản lý tài khoản tài xế',
      code: 'ADMIN_ONLY',
    });
  }
  next();
}

// GET /api/admin/drivers — danh sách tài khoản
router.get('/drivers', requireAdmin, (req, res) => {
  try {
    const role = req.query.role ? String(req.query.role).toUpperCase() : undefined;
    const drivers = UserService.list(role ? { role } : {});
    res.json({ drivers, total: drivers.length });
  } catch (err) {
    logger.error('[admin/drivers] list error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải danh sách tài xế' });
  }
});

// GET /api/admin/drivers/:id
router.get('/drivers/:id', requireAdmin, (req, res) => {
  const driver = UserService.getById(parseInt(req.params.id));
  if (!driver) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  res.json({ driver });
});

// POST /api/admin/drivers — tạo tài khoản tài xế
router.post('/drivers', requireAdmin, (req, res) => {
  try {
    const { username, password, fullName, phone, role } = req.body || {};

    const result = UserService.create({
      username,
      password,
      fullName,
      phone,
      // Admin có thể tạo tài khoản ADMIN (quản trị) hoặc DRIVER (tài xế)
      role: role ? String(role).toUpperCase() : ROLE_DRIVER,
      mustChangePassword: req.body?.mustChangePassword !== false,
    });

    if (!result.success) return res.status(400).json({ error: result.error });

    logger.info('[admin/drivers] created', { username: result.username, role: result.role });
    res.status(201).json({
      success: true,
      id: result.id,
      username: result.username,
      role: result.role,
    });
  } catch (err) {
    logger.error('[admin/drivers] create error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tạo tài khoản tài xế' });
  }
});

// PUT /api/admin/drivers/:id — sửa / khoá / đổi role / đổi mật khẩu
router.put('/drivers/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = UserService.update(id, req.body || {}, ROLE_ADMIN);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true, id });
  } catch (err) {
    logger.error('[admin/drivers] update error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật tài khoản' });
  }
});

// POST /api/admin/drivers/:id/reset-password
router.post('/drivers/:id/reset-password', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { password } = req.body || {};
    const result = UserService.changePassword(id, password, ROLE_ADMIN);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  } catch (err) {
    logger.error('[admin/drivers] reset-password error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi đổi mật khẩu' });
  }
});

// DELETE /api/admin/drivers/:id — khoá tài khoản (soft delete)
router.delete('/drivers/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = UserService.remove(id);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  } catch (err) {
    logger.error('[admin/drivers] delete error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi khoá tài khoản' });
  }
});

// GET /api/admin/drivers/:id/sessions — phiên đăng nhập đang hoạt động
router.get('/drivers/:id/sessions', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const sessions = db
      .prepare(
        `SELECT token, username, role, created_at, expires_at, last_active
         FROM auth_sessions WHERE app_user_id = ? ORDER BY last_active DESC`
      )
      .all(id);
    // Không trả về token (chỉ cần số lượng + thời điểm)
    res.json({
      sessions: sessions.map((s) => ({
        username: s.username,
        role: s.role,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
        lastActive: s.last_active,
      })),
      total: sessions.length,
    });
  } catch (err) {
    logger.error('[admin/drivers] sessions error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải phiên đăng nhập' });
  }
});

// GET /api/admin/logs/error — đọc N dòng cuối của logs/error.log (chẩn đoán)
// Chỉ ADMIN. Không chứa dữ liệu kinh doanh, chỉ log kỹ thuật.
router.get('/logs/error', requireAdmin, (req, res) => {
  try {
    const lines = Math.min(parseInt(req.query.lines || '60', 10), 500);
    // Logger ghi vào <root>/src/logs (src/utils/logger.js → path.join(__dirname,'..','logs'))
    // nhưng server.js deploy log dùng <root>/logs — thử cả hai.
    const candidates = [
      path.join(__dirname, '../../src/logs/error.log'),
      path.join(__dirname, '../../logs/error.log'),
    ];
    const found = candidates.find((f) => fs.existsSync(f));
    if (!found) {
      const dirs = candidates.map((f) => path.dirname(f));
      const listing = dirs.map((d) => {
        try {
          return d + ' => [' + fs.readdirSync(d).join(', ') + ']';
        } catch (e) {
          return d + ' => (unreadable: ' + e.message + ')';
        }
      });
      return res.type('text/plain').send('NOT FOUND\n' + listing.join('\n'));
    }
    const content = fs.readFileSync(found, 'utf8');
    const tail = content.split('\n').filter(Boolean).slice(-lines).join('\n');
    res.type('text/plain').send(found + '\n' + (tail || '(empty)'));
  } catch (err) {
    res.status(500).json({ error: 'Không đọc được log: ' + err.message });
  }
});

module.exports = router;
module.exports.requireAdmin = requireAdmin;
