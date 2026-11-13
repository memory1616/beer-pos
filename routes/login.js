const express = require('express');
const router = express.Router();
const path = require('path');
const { login, logout, getSession, AUTH_CONFIG, cookieOptions } = require('../middleware/auth');
const socketServer = require('../src/socket/socketServer');
const AuditLogService = require('../src/services/AuditLogService');

// GET /login - Hiển thị form login
router.get('/', (req, res) => {
  const token = req.cookies?.[AUTH_CONFIG.cookieName] ||
                req.headers.authorization?.replace('Bearer ', '') ||
    req.query?.token;

  if (token && getSession(token)) {
    return res.redirect('/'); // Admin is at root /
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../views/login.html'));
});

// POST /login - Xử lý đăng nhập (sets httpOnly cookie)
router.post('/', express.json(), (req, res) => {
  const { username, password } = req.body;

  // adminOnly=true → CHỈ nhận tài khoản ADMIN (.env).
  // Tài khoản tài xế KHÔNG được đăng nhập chéo sang domain admin.
  const result = login(username, password, { adminOnly: true });

  if (result) {
    res.cookie(AUTH_CONFIG.cookieName, result.token, cookieOptions());
    // A3: ghi nhật ký đăng nhập thành công
    AuditLogService.record({
      action: AuditLogService.ACTIONS.LOGIN,
      actorUsername: result.username,
      actorRole: result.role,
      description: `Đăng nhập thành công (${result.role})`,
      req,
    });
    res.json({
      success: true,
      token: result.token,
      redirect: '/' // Admin is at root /
    });
  } else {
    // A3: ghi nhận ký đăng nhập thất bại (KHÔNG ghi mật khẩu)
    AuditLogService.record({
      action: AuditLogService.ACTIONS.LOGIN_FAILED,
      actorUsername: username || null,
      actorRole: null,
      description: 'Đăng nhập thất bại — sai tên đăng nhập hoặc mật khẩu',
      status: 'failed',
      req,
    });
    res.status(401).json({
      success: false,
      error: 'Tên đăng nhập hoặc mật khẩu không đúng'
    });
  }
});

// ── Logout ─────────────────────────────────────────────────────────────────
//
// A4: thêm POST /logout. Trước đây public/js/auth.js gọi POST /auth/logout
// nhưng server CHỈ có GET /logout → session KHÔNG bị xoá phía server, chỉ
// cookie bị clear. Token vẫn còn hiệu lực trong DB (30 ngày) và socket
// vẫn kết nối được → đăng xuất không thật sự an toàn.
//
// GET /logout vẫn giữ (dùng bởi link / truy cập trực tiếp) nhưng giờ cũng
// ngắt socket tương ứng.
function handleLogout(req, res) {
  const token = req.cookies?.[AUTH_CONFIG.cookieName] ||
                req.headers.authorization?.replace('Bearer ', '') ||
                req.query?.token;

  // A3: lấy thông tin phiên TRƯỚC khi xoá để ghi nhật ký
  const session = token ? getSession(token) : null;

  // A4: ngắt mọi socket dùng token này → các thiết bị khác mất phiên ngay.
  try {
    socketServer.disconnectToken(token, 'logout');
  } catch (_) { /* ignore */ }

  logout(token);

  // A3: ghi nhật ký đăng xuất
  if (session) {
    AuditLogService.record({
      action: AuditLogService.ACTIONS.LOGOUT,
      actorUsername: session.username,
      actorRole: session.role,
      description: 'Đăng xuất',
      req,
    });
  }

  res.clearCookie(AUTH_CONFIG.cookieName);
}

// GET /logout - Đăng xuất (clears cookie)
router.get('/logout', (req, res) => {
  handleLogout(req, res);
  res.redirect('/login');
});

// POST /logout - Đăng xuất qua fetch (dùng bởi public/js/auth.js)
router.post('/logout', (req, res) => {
  handleLogout(req, res);
  res.json({ success: true });
});

module.exports = router;
