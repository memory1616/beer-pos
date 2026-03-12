const express = require('express');
const router = express.Router();
const path = require('path');
const { login, logout, getSession, AUTH_CONFIG } = require('../middleware/auth');

// GET /login - Hiển thị form login
router.get('/', (req, res) => {
  // Check if already logged in
  const token = req.headers.authorization?.replace('Bearer ', '') || 
                req.query?.token;
  
  if (token && getSession(token)) {
    return res.redirect('/');
  }
  
  res.sendFile(path.join(__dirname, '../views/login.html'));
});

// POST /login - Xử lý đăng nhập
router.post('/', express.json(), (req, res) => {
  const { username, password } = req.body;
  
  const result = login(username, password);
  
  if (result) {
    res.json({ 
      success: true, 
      token: result.token,
      redirect: '/'
    });
  } else {
    res.status(401).json({ 
      success: false, 
      error: 'Tên đăng nhập hoặc mật khẩu không đúng' 
    });
  }
});

// GET /logout - Đăng xuất
router.get('/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || 
                req.query?.token;
  
  logout(token);
  
  res.redirect('/login');
});

module.exports = router;
