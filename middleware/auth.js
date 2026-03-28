// ==================== AUTHENTICATION ====================
// Session-based auth for Beer POS
// Token is returned to client on login and stored in localStorage.
const crypto = require('crypto');

// In-memory session store
const sessions = {};

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

// Periodic cleanup of expired sessions (runs every 30 minutes)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const token of Object.keys(sessions)) {
    if (now > sessions[token].expiresAt) {
      delete sessions[token];
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[Auth] Cleaned up ${cleaned} expired session(s)`);
  }
}, 30 * 60 * 1000);

// Generate a cryptographically random session token
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Auth middleware — reads token from cookie OR Authorization header
function requireAuth(req, res, next) {
  const cookieToken = req.cookies?.[AUTH_CONFIG.cookieName];
  const headerToken = req.headers.authorization?.replace('Bearer ', '');
  const queryToken = req.query?.token;

  const token = cookieToken || headerToken || queryToken;

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

// Login — sets httpOnly cookie instead of returning token to JS
function login(username, password) {
  if (username === AUTH_CONFIG.username && password === ADMIN_PASSWORD) {
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

// Logout — clears the session and cookie
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
