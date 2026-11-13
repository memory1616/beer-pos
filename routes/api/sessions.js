/**
 * Session API — Quản lý phiên đăng nhập (A4)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount tại /api/sessions — CHỈ ADMIN.
 *
 * Mục tiêu:
 *  1. Xem các phiên đăng nhập đang hoạt động (thiết bị nào đang mở app).
 *  2. Huỷ phiên từ xa → thiết bị đó bị đăng xuất ngay lập tức (kể cả WebSocket).
 *  3. Đổi mật khẩu tài xế → huỷ toàn bộ phiên của tài xế đó.
 *
 * Endpoint:
 *  GET  /api/sessions              — danh sách phiên đang hoạt động
 *  POST /api/sessions/:token/revoke — huỷ 1 phiên (ngắt socket tương ứng)
 *  POST /api/sessions/revoke-all   — huỷ mọi phiên trừ phiên của admin hiện tại
 */

const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');
const socketServer = require('../../src/socket/socketServer');
const AuditLogService = require('../../src/services/AuditLogService');
const { ROLE_ADMIN } = require('../../middleware/permissions');

// ── Chỉ ADMIN ───────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }
  if (req.user.role !== ROLE_ADMIN) {
    return res.status(403).json({
      error: 'Chỉ quản trị viên mới được quản lý phiên đăng nhập',
      code: 'ADMIN_ONLY',
    });
  }
  next();
}

/**
 * Lấy token hiện tại của request (header > cookie).
 */
function currentToken(req) {
  return (
    req.headers.authorization?.replace('Bearer ', '') ||
    req.cookies?.session_token ||
    req.cookies?.driver_session_token ||
    null
  );
}

// ── GET /api/sessions ───────────────────────────────────────────────────────
router.get('/', requireAdmin, (req, res) => {
  try {
    const now = Date.now();
    const rows = db
      .prepare(
        `SELECT token, username, role, created_at, expires_at, last_active
         FROM auth_sessions WHERE expires_at > ?
         ORDER BY last_active DESC`
      )
      .all(now);

    const self = currentToken(req);

    res.json({
      success: true,
      total: rows.length,
      sessions: rows.map((s) => ({
        // Token ĐƯỢC trả về: admin cần dùng nó để huỷ phiên.
        // Đây là hành vi chủ ý — admin đã có toàn quyền hệ thống.
        token: s.token,
        username: s.username,
        role: s.role,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
        lastActive: s.last_active,
        isCurrent: s.token === self,
      })),
    });
  } catch (err) {
    logger.error('[sessions] list error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải danh sách phiên' });
  }
});

// ── POST /api/sessions/:token/revoke ────────────────────────────────────────
router.post('/:token/revoke', requireAdmin, (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Thiếu token phiên' });

    const self = currentToken(req);
    if (token === self) {
      return res.status(400).json({
        error: 'Không thể huỷ phiên của chính mình — hãy đăng xuất bằng nút Đăng xuất',
      });
    }

    const session = db.prepare('SELECT * FROM auth_sessions WHERE token = ?').get(token);
    if (!session) {
      return res.status(404).json({ error: 'Không tìm thấy phiên' });
    }

    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);

    // A4: ngắt WebSocket của phiên bị huỷ → thiết bị đó mất kết nối ngay.
    let sockets = 0;
    try {
      sockets = socketServer.disconnectToken(token, 'session_revoked');
    } catch (_) { /* ignore */ }

    logger.info('[sessions] revoked', {
      username: session.username,
      role: session.role,
      sockets,
      by: req.user.username,
    });

    // A3: ghi nhật ký huỷ phiên
    AuditLogService.recordFromRequest(req, AuditLogService.ACTIONS.SESSION_REVOKED, {
      entity: 'session',
      entityId: session.username,
      description: `Admin huỷ phiên của ${session.username} (${session.role})`,
      changes: { revokedUser: { from: session.username, to: null } },
    });

    res.json({ success: true, username: session.username, socketsDisconnected: sockets });
  } catch (err) {
    logger.error('[sessions] revoke error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi huỷ phiên' });
  }
});

// ── POST /api/sessions/revoke-all ───────────────────────────────────────────
router.post('/revoke-all', requireAdmin, (req, res) => {
  try {
    const self = currentToken(req);
    const scope = req.body?.scope === 'drivers' ? 'drivers' : 'all';

    let rows;
    if (scope === 'drivers') {
      rows = db
        .prepare(`SELECT token, username FROM auth_sessions WHERE role = 'DRIVER' AND token != ?`)
        .all(self || '');
    } else {
      rows = db
        .prepare(`SELECT token, username FROM auth_sessions WHERE token != ?`)
        .all(self || '');
    }

    let sockets = 0;
    for (const row of rows) {
      db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(row.token);
      try {
        sockets += socketServer.disconnectToken(row.token, 'session_revoked');
      } catch (_) { /* ignore */ }
    }

    logger.info('[sessions] revoke-all', { scope, count: rows.length, sockets, by: req.user.username });

    // A3: ghi nhật ký huỷ hàng loạt
    AuditLogService.recordFromRequest(req, AuditLogService.ACTIONS.SESSION_REVOKED, {
      entity: 'session',
      description: `Admin huỷ ${rows.length} phiên (phạm vi: ${scope})`,
      changes: { scope: { from: null, to: scope }, count: { from: null, to: rows.length } },
    });

    res.json({ success: true, scope, revoked: rows.length, socketsDisconnected: sockets });
  } catch (err) {
    logger.error('[sessions] revoke-all error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi huỷ các phiên' });
  }
});

module.exports = router;
module.exports.requireAdmin = requireAdmin;
