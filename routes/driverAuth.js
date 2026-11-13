/**
 * Driver Login Routes — /auth/driver
 * ─────────────────────────────────────────────────────────────────────────────
 * Đăng nhập RIÊNG cho tài xế trên domain giaohang.biatuoitayninh.store.
 *
 * Bảo mật session:
 *  - Cookie `driver_session_token` là HOST-ONLY (không có `domain=`) →
 *    trình duyệt KHÔNG gửi cookie này sang admin.biatuoitayninh.store,
 *    và ngược lại cookie `session_token` của admin cũng không sang domain driver.
 *  - sameSite=strict + httpOnly + secure (production).
 *  - Token lưu trong bảng `auth_sessions` với role='DRIVER'.
 *  - Admin KHÔNG đăng nhập được qua endpoint này (driverOnly=true).
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const {
  login,
  logout,
  getSession,
  DRIVER_COOKIE_NAME,
  driverCookieOptions,
} = require('../middleware/auth');
const { ROLE_DRIVER } = require('../middleware/permissions');
const logger = require('../src/utils/logger');
const socketServer = require('../src/socket/socketServer');
const AuditLogService = require('../src/services/AuditLogService');

// GET /auth/driver — hiển thị form login tài xế
router.get('/', (req, res) => {
  const token = req.cookies?.[DRIVER_COOKIE_NAME] ||
                req.headers.authorization?.replace('Bearer ', '');

  if (token) {
    const session = getSession(token);
    if (session && session.role === ROLE_DRIVER) {
      return res.redirect('/driver');
    }
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../views/driver/login.html'));
});

// POST /auth/driver — xử lý đăng nhập tài xế
router.post('/', express.json(), (req, res) => {
  const { username, password } = req.body || {};

  try {
    // driverOnly = true → admin (tài khoản .env) KHÔNG đăng nhập được ở đây
    const result = login(username, password, { driverOnly: true });

    if (result && result.role === ROLE_DRIVER) {
      res.cookie(DRIVER_COOKIE_NAME, result.token, driverCookieOptions());
      // A3: ghi nhật ký đăng nhập tài xế
      AuditLogService.record({
        action: AuditLogService.ACTIONS.LOGIN,
        actorUsername: result.username,
        actorRole: result.role,
        description: `Tài xế đăng nhập (${result.fullName || result.username})`,
        req,
      });
      res.json({
        success: true,
        token: result.token,
        role: result.role,
        username: result.username,
        fullName: result.fullName,
        redirect: '/driver',
      });
    } else {
      // A3: ghi nhận ký đăng nhập thất bại (KHÔNG ghi mật khẩu)
      AuditLogService.record({
        action: AuditLogService.ACTIONS.LOGIN_FAILED,
        actorUsername: username || null,
        actorRole: ROLE_DRIVER,
        description: 'Tài xế đăng nhập thất bại — sai tên đăng nhập hoặc mật khẩu',
        status: 'failed',
        req,
      });
      res.status(401).json({
        success: false,
        error: 'Tên đăng nhập hoặc mật khẩu không đúng',
      });
    }
  } catch (err) {
    // Log đầy đủ để chẩn đoán (không lộ thông tin nhạy cảm cho client)
    logger.error('Driver login error', {
      username: username || null,
      message: err.message,
      stack: err.stack,
    });
    res.status(500).json({
      success: false,
      error: 'Lỗi hệ thống khi đăng nhập',
    });
  }
});

// GET /auth/driver/logout — đăng xuất
router.get('/logout', (req, res) => {
  const token = req.cookies?.[DRIVER_COOKIE_NAME] ||
                req.headers.authorization?.replace('Bearer ', '');

  // A3: lấy thông tin phiên TRƯỚC khi xoá để ghi nhật ký
  const session = token ? getSession(token) : null;

  // A4: ngắt socket của tài xế → thiết bị khác mất phiên ngay lập tức.
  try { socketServer.disconnectToken(token, 'logout'); } catch (_) { /* ignore */ }
  if (token) logout(token);

  // A3: ghi nhật ký đăng xuất tài xế
  if (session) {
    AuditLogService.record({
      action: AuditLogService.ACTIONS.LOGOUT,
      actorUsername: session.username,
      actorRole: session.role,
      description: 'Tài xế đăng xuất',
      req,
    });
  }

  res.clearCookie(DRIVER_COOKIE_NAME);
  res.redirect('/auth/driver');
});

// POST /auth/driver/logout — đăng xuất (fetch)
router.post('/logout', (req, res) => {
  const token = req.cookies?.[DRIVER_COOKIE_NAME] ||
                req.headers.authorization?.replace('Bearer ', '');

  try { socketServer.disconnectToken(token, 'logout'); } catch (_) { /* ignore */ }
  if (token) logout(token);
  res.clearCookie(DRIVER_COOKIE_NAME);
  res.json({ success: true });
});

module.exports = router;
