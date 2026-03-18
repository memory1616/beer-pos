// ==================== AUTHENTICATION ====================
// Simple session-based authentication for Beer POS
const crypto = require('crypto');

// In-memory session store (use Redis for production)
const sessions = {};

// Config - change password here
const AUTH_CONFIG = {
  username: 'admin',
  password: 'beer123',  // CHANGE THIS PASSWORD!
  sessionDuration: 24 * 60 * 60 * 1000 // 24 hours
};

// Generate session token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Auth middleware
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || 
                req.cookies?.sessionToken ||
                req.query?.token;
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }
  
  const session = sessions[token];
  if (!session) {
    return res.status(401).json({ error: 'Session expired', loginRequired: true });
  }
  
  if (Date.now() > session.expiresAt) {
    delete sessions[token];
    return res.status(401).json({ error: 'Session expired', loginRequired: true });
  }
  
  // Extend session on activity
  session.expiresAt = Date.now() + AUTH_CONFIG.sessionDuration;
  req.user = session;
  next();
}

// Login handler
function login(username, password) {
  if (username === AUTH_CONFIG.username && password === AUTH_CONFIG.password) {
    const token = generateToken();
    sessions[token] = {
      username,
      createdAt: Date.now(),
      expiresAt: Date.now() + AUTH_CONFIG.sessionDuration
    };
    return { token };
  }
  return null;
}

// Logout handler
function logout(token) {
  if (token && sessions[token]) {
    delete sessions[token];
    return true;
  }
  return false;
}

// Get session info
function getSession(token) {
  const session = sessions[token];
  if (!session || Date.now() > session.expiresAt) {
    return null;
  }
  return session;
}

module.exports = {
  requireAuth,
  login,
  logout,
  getSession,
  AUTH_CONFIG
};
