// ==================== AUTHENTICATION ====================
// Session-based auth for Beer POS
// Sessions stored persistently in SQLite (survives server restart)
// Token stored in httpOnly cookie (not localStorage) to prevent XSS theft
const crypto = require('crypto');

// Lazy import db to avoid circular dependency
let db = null;
function getDb() {
  if (!db) {
    db = require('../database.js');
    // Periodic cleanup of expired sessions (runs every 30 minutes)
    setInterval(() => {
      try {
        const cleaned = db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(Date.now()).changes;
        if (cleaned > 0) console.log(`[Auth] Cleaned up ${cleaned} expired session(s)`);
      } catch (e) { /* ignore */ }
    }, 30 * 60 * 1000);
  }
  return db;
}

// Config from env (ADMIN_PASSWORD MUST be set in .env for security)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('FATAL: ADMIN_PASSWORD is not set in environment variables.');
  console.error('Please set ADMIN_PASSWORD in your .env file.');
  process.exit(1);
}

const AUTH_CONFIG = {
  username: process.env.ADMIN_USER || 'admin',
  sessionDuration: parseInt(process.env.SESSION_DURATION_MS) || (365 * 24 * 60 * 60 * 1000), // 1 year default
  cookieName: 'session_token',
  cookieSecure: process.env.USE_SECURE_COOKIE === 'true',
  cookieSameSite: 'lax'
};

// Generate a cryptographically random session token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Auth middleware — reads token from cookie OR Authorization header
function requireAuth(req, res, next) {
  const database = getDb();
  const cookieToken = req.cookies?.[AUTH_CONFIG.cookieName];
  const headerToken = req.headers.authorization?.replace('Bearer ', '');
  const queryToken = req.query?.token;

  const token = cookieToken || headerToken || queryToken;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }

  const row = database.prepare('SELECT data, expires_at FROM auth_sessions WHERE token = ?').get(token);
  if (!row) {
    return res.status(401).json({ error: 'Session expired', loginRequired: true });
  }

  if (Date.now() > row.expires_at) {
    database.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
    return res.status(401).json({ error: 'Session expired', loginRequired: true });
  }

  // Extend session on activity
  const newExpiry = Date.now() + AUTH_CONFIG.sessionDuration;
  database.prepare('UPDATE auth_sessions SET expires_at = ? WHERE token = ?').run(newExpiry, token);
  req.user = JSON.parse(row.data || '{}');
  next();
}

// Login — sets httpOnly cookie and stores session in SQLite
function login(username, password) {
  if (username === AUTH_CONFIG.username && password === ADMIN_PASSWORD) {
    const token = generateToken();
    const expiresAt = Date.now() + AUTH_CONFIG.sessionDuration;
    const data = JSON.stringify({ username });
    getDb().prepare(
      'INSERT OR REPLACE INTO auth_sessions (token, data, expires_at) VALUES (?, ?, ?)'
    ).run(token, data, expiresAt);
    return { token };
  }
  return null;
}

// Logout — clears the session from SQLite and cookie
function logout(token) {
  if (token) {
    try {
      getDb().prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
    } catch (e) { /* ignore */ }
  }
  return true;
}

// Get session info
function getSession(token) {
  if (!token) return null;
  try {
    const row = getDb().prepare('SELECT data, expires_at FROM auth_sessions WHERE token = ?').get(token);
    if (!row || Date.now() > row.expires_at) return null;
    return JSON.parse(row.data || '{}');
  } catch (e) {
    return null;
  }
}

// Middleware options for setting the auth cookie
function cookieOptions() {
  return {
    httpOnly: true,
    secure: AUTH_CONFIG.cookieSecure,
    sameSite: AUTH_CONFIG.cookieSameSite,
    maxAge: AUTH_CONFIG.sessionDuration
  };
}

module.exports = {
  requireAuth,
  login,
  logout,
  getSession,
  AUTH_CONFIG,
  cookieOptions
};
