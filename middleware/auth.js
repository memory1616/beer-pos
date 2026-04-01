// ==================== PERSISTENT AUTH SESSIONS (SQLite) ====================
// auth_sessions table — survives PM2 restarts unlike in-memory store
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at INTEGER NOT NULL,
      last_active INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at)`);
  console.log('Created auth_sessions table (SQLite-backed)');
} catch (e) {
  console.log('auth_sessions table note:', e.message);
}

// Periodic cleanup of expired sessions (runs every 30 minutes)
setInterval(() => {
  const now = Date.now();
  const cleaned = db.prepare(`DELETE FROM auth_sessions WHERE expires_at < ?`).run(now).changes;
  if (cleaned > 0) console.log(`[Auth] Cleaned up ${cleaned} expired session(s)`);
}, 30 * 60 * 1000);

function dbGetSession(token) {
  if (!token) return null;
  const now = Date.now();
  const row = db.prepare(`SELECT * FROM auth_sessions WHERE token = ? AND expires_at > ?`).get(token, now);
  if (!row) return null;
  // Extend session on activity
  db.prepare(`UPDATE auth_sessions SET last_active = ? WHERE token = ?`).run(now, token);
  return { username: row.username, createdAt: new Date(row.created_at).getTime(), expiresAt: row.expires_at };
}

function dbSaveSession(token, username, expiresAt) {
  db.prepare(`
    INSERT OR REPLACE INTO auth_sessions (token, username, created_at, expires_at, last_active)
    VALUES (?, ?, datetime('now'), ?, ?)
  `).run(token, username, expiresAt, Date.now());
}

function dbDeleteSession(token) {
  if (!token) return;
  db.prepare(`DELETE FROM auth_sessions WHERE token = ?`).run(token);
}

// ==================== AUTHENTICATION ====================
// Token is returned to client on login and stored in localStorage.
const crypto = require('crypto');

// Config from env (ADMIN_PASSWORD MUST be set in .env for security)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('FATAL: ADMIN_PASSWORD is not set in environment variables.');
  console.error('Please set ADMIN_PASSWORD in your .env file.');
  process.exit(1);
}

const AUTH_CONFIG = {
  username: process.env.ADMIN_USER || 'admin',
  sessionDuration: parseInt(process.env.SESSION_DURATION_MS) || (30 * 24 * 60 * 60 * 1000), // 30 days
  cookieName: 'session_token',
  cookieSecure: process.env.NODE_ENV === 'production',
  cookieSameSite: 'lax'
};

// Auth middleware — reads token from cookie OR Authorization header
function requireAuth(req, res, next) {
  const cookieToken = req.cookies?.[AUTH_CONFIG.cookieName];
  const headerToken = req.headers.authorization?.replace('Bearer ', '');
  const queryToken = req.query?.token;

  const token = cookieToken || headerToken || queryToken;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }

  const session = dbGetSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Session expired', loginRequired: true });
  }

  req.user = session;
  next();
}

// Login — sets httpOnly cookie instead of returning token to JS
function login(username, password) {
  if (username === AUTH_CONFIG.username && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + AUTH_CONFIG.sessionDuration;
    dbSaveSession(token, username, expiresAt);
    return { token };
  }
  return null;
}

// Logout — clears the session and cookie
function logout(token) {
  dbDeleteSession(token);
  return true;
}

// Get session info
function getSession(token) {
  return dbGetSession(token);
}

// Middleware options for setting the auth cookie
function cookieOptions() {
  return {
    maxAge: AUTH_CONFIG.sessionDuration,
    secure: AUTH_CONFIG.cookieSecure,
    sameSite: AUTH_CONFIG.cookieSameSite
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
