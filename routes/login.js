const express = require('express');
const router = express.Router();
const path = require('path');
const { login, logout, getSession, AUTH_CONFIG, cookieOptions } = require('../middleware/auth');

// GET /login - Hiển thị form login
router.get('/', (req, res) => {
  const token = req.cookies?.[AUTH_CONFIG.cookieName] ||
                req.headers.authorization?.replace('Bearer ', '') ||
                req.query?.token;

  if (token && getSession(token)) {
    return res.redirect('/');
  }

  res.sendFile(path.join(__dirname, '../views/login.html'));
});

// POST /login - Xử lý đăng nhập (sets httpOnly cookie)
router.post('/', express.json(), (req, res) => {
  const { username, password } = req.body;

  const result = login(username, password);

  if (result) {
    res.cookie(AUTH_CONFIG.cookieName, result.token, cookieOptions());
    res.json({
      success: true,
      redirect: '/'
    });
  } else {
    res.status(401).json({
      success: false,
      error: 'Tên đăng nhập hoặc mật khẩu không đúng'
    });
  }
});

// GET /logout - Đăng xuất (clears cookie)
router.get('/logout', (req, res) => {
  const token = req.cookies?.[AUTH_CONFIG.cookieName] ||
                req.headers.authorization?.replace('Bearer ', '') ||
                req.query?.token;

  logout(token);
  res.clearCookie(AUTH_CONFIG.cookieName);
  res.redirect('/login');
});

module.exports = router;
