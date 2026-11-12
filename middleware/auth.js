// ==================== PERSISTENT AUTH SESSIONS (SQLite) ====================
// auth_sessions table — survives PM2 restarts unlike in-memory store
const db = require('../database.js');
const { verifyPassword } = require('../src/utils/password');

// Migrate auth_sessions table schema if needed
try {
  const cols = db.prepare("PRAGMA table_info(auth_sessions)").all().map(r => r.name);

  if (cols.length === 0) {
    // Table doesn't exist — create it
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
    // Table created
  } else {
    // Table exists — migrate schema if needed
    if (!cols.includes('username')) {
      db.exec(`ALTER TABLE auth_sessions ADD COLUMN username TEXT NOT NULL DEFAULT 'admin'`);
      // username column added
    }
    if (!cols.includes('created_at')) {
      db.exec(`ALTER TABLE auth_sessions ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP`);
      // created_at column added
    }
    if (!cols.includes('last_active')) {
      db.exec(`ALTER TABLE auth_sessions ADD COLUMN last_active INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)`);
      // last_active column added
    }
    // ── Driver Portal: role + app_user_id (idempotent, additive) ──
    if (!cols.includes('role')) {
      db.exec(`ALTER TABLE auth_sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'ADMIN'`);
    }
    if (!cols.includes('app_user_id')) {
      db.exec(`ALTER TABLE auth_sessions ADD COLUMN app_user_id INTEGER`);
    }
    // Recreate index if missing
    db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_role ON auth_sessions(role)`);
  }
  } catch (e) {
    // auth_sessions table note
  }

// Periodic cleanup of expired sessions (runs every 30 minutes)
let cleanupHandle = null;
try {
  cleanupHandle = setInterval(() => {
    const now = Date.now();
    const cleaned = db.prepare(`DELETE FROM auth_sessions WHERE expires_at < ?`).run(now).changes;
    if (cleaned > 0) {}
  }, 30 * 60 * 1000);
  // unref() để timer không giữ process sống (nhất quán với middleware/cache.js)
  if (cleanupHandle && typeof cleanupHandle.unref === 'function') {
    cleanupHandle.unref();
  }
  } catch (e) {
    // Session cleanup not available
  }

function dbGetSession(token) {
  if (!token) return null;
  const now = Date.now();
  const row = db.prepare(`SELECT * FROM auth_sessions WHERE token = ? AND expires_at > ?`).get(token, now);
  if (!row) return null;
  // Extend session on activity
  db.prepare(`UPDATE auth_sessions SET last_active = ? WHERE token = ?`).run(now, token);
  return {
    username: row.username,
    // role: 'ADMIN' (quản trị, mặc định) hoặc 'DRIVER' (tài xế)
    role: row.role || 'ADMIN',
    appUserId: row.app_user_id || null,
    createdAt: new Date(row.created_at).getTime(),
    expiresAt: row.expires_at,
  };
}

function dbSaveSession(token, username, expiresAt, role = 'ADMIN', appUserId = null) {
  db.prepare(`
    INSERT OR REPLACE INTO auth_sessions (token, username, created_at, expires_at, last_active, role, app_user_id)
    VALUES (?, ?, datetime('now'), ?, ?, ?, ?)
  `).run(token, username, expiresAt, Date.now(), role, appUserId);
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
  // Trong môi trường test: không kill process (test chỉ cần role DRIVER)
  if (process.env.NODE_ENV !== 'test') {
    process.exit(1);
  }
}

// SECURITY: Warn if using weak/default password
const WEAK_PASSWORDS = ['admin', 'password', '123456', 'admin123', 'zxcasd123'];
  if (ADMIN_PASSWORD && WEAK_PASSWORDS.includes(ADMIN_PASSWORD.toLowerCase())) {
    console.warn('WARNING: Using a weak password is not recommended for production!');
    console.warn('Please change ADMIN_PASSWORD to a strong, unique value.');
    if (process.env.NODE_ENV === 'production') {
      console.error('FATAL: Weak password detected in production environment!');
      console.error('Please set a strong ADMIN_PASSWORD in your .env file.');
      process.exit(1);
    }
  }
const AUTH_CONFIG = {
  username: process.env.ADMIN_USER || 'admin',
  sessionDuration: parseInt(process.env.SESSION_DURATION_MS) || (30 * 24 * 60 * 60 * 1000), // 30 days
  cookieName: 'session_token',
  cookieSecure: process.env.NODE_ENV === 'production',
  cookieSameSite: 'strict', // Changed from 'lax' for better CSRF protection
  cookieHttpOnly: true // Ensure cookies are not accessible via JavaScript
};

// ── Driver Portal: cookie riêng cho domain giaohang ───────────────────────
// Host-only cookie → KHÔNG được gửi sang admin.biatuoitayninh.store và ngược lại.
// Điều này chặn nguy cơ "chiếm quyền phiên đăng nhập" giữa 2 subdomain.
const DRIVER_COOKIE_NAME = 'driver_session_token';

// ── Lookup user trong app_users ────────────────────────────────────────────
function findAppUser(username) {
  if (!username) return null;
  try {
    const row = db.prepare('SELECT * FROM app_users WHERE username = ? AND active = 1').get(username);
    return row || null;
  } catch (_) {
    return null;
  }
}

// Auth middleware — reads token from cookie OR Authorization header
function requireAuth(req, res, next) {
  const adminCookieToken = req.cookies?.[AUTH_CONFIG.cookieName];
  const driverCookieToken = req.cookies?.[DRIVER_COOKIE_NAME];
  const headerToken = req.headers.authorization?.replace('Bearer ', '');
  const queryToken = req.query?.token;

  // ── Thứ tự ưu tiên token ────────────────────────────────────────────────
  // 1. Authorization header  — client chủ động gửi token đúng ý mình.
  // 2. Cookie driver_session_token — session riêng của Driver Portal.
  // 3. Cookie session_token (admin).
  // 4. ?token=.
  //
  // BUG ĐÃ SỬA: trước đây cookie admin được ưu tiên trên Authorization header.
  // Khi 1 trình duyệt có CẢ cookie admin lẫn session driver, mọi request của
  // tài xế bị resolve thành session ADMIN → API trả 403 DRIVER_ONLY →
  // client redirect → reload liên tục.
  //
  // Duyệt lần lượt & chỉ nhận session HỢP LỆ (chưa hết hạn) → không hồi quy
  // khi token header đã cũ nhưng cookie admin còn sống.
  const candidates = [headerToken, driverCookieToken, adminCookieToken, queryToken];
  let session = null;
  for (let i = 0; i < candidates.length; i++) {
    if (!candidates[i]) continue;
    session = dbGetSession(candidates[i]);
    if (session) break;
  }

  if (!session) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }

  req.user = session;
  next();
}

// ── Login ────────────────────────────────────────────────────────────────────
/**
 * Login dùng chung cho admin lẫn driver.
 * - Admin: username/password từ .env (role ADMIN).
 * - Driver: username/password trong bảng app_users (role DRIVER).
 *
 * opts.driverOnly = true  → chỉ đăng nhập được bằng tài khoản DRIVER.
 * opts.adminOnly  = true  → chỉ đăng nhậng được bằng tài khoản ADMIN (.env).
 *                           Dùng cho endpoint admin để CHẶN tài xế đăng nhập
 *                           chéo sang domain admin.
 *
 * @returns {{token: string, role: string, username: string, redirect: string}|null}
 */
function login(username, password, opts = {}) {
  if (!username || !password) return null;

  const wantDriver = !!opts.driverOnly;
  const wantAdmin = !!opts.adminOnly;

  // ── Admin (env-based) ──────────────────────────────────────────────────
  if (!wantDriver && username === AUTH_CONFIG.username && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + AUTH_CONFIG.sessionDuration;
    dbSaveSession(token, username, expiresAt, 'ADMIN', null);
    return { token, role: 'ADMIN', username, redirect: '/' };
  }

  // Endpoint admin KHÔNG chấp nhận tài khoản tài xế.
  // (Tài khoản ADMIN trong app_users vẫn được phép — xử lý bên dưới.)

  // ── Driver (app_users) ────────────────────────────────────────────────
  const appUser = findAppUser(username);
  if (appUser && appUser.role === 'DRIVER') {
    if (wantAdmin) return null; // chặn driver đăng nhập chéo sang domain admin
    if (!verifyPassword(password, appUser.password_hash)) return null;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + AUTH_CONFIG.sessionDuration;
    dbSaveSession(token, username, expiresAt, 'DRIVER', appUser.id);
    try {
      db.prepare("UPDATE app_users SET last_login_at = datetime('now') WHERE id = ?").run(appUser.id);
    } catch (_) {}
    return {
      token,
      role: 'DRIVER',
      username,
      fullName: appUser.full_name || username,
      redirect: '/driver',
    };
  }

  // ── Admin trong app_users (role ADMIN) ───────────────────────────────
  // Cho phép nhiều tài khoản quản trị (ngoài tài khoản .env).
  // KHÔNG được đăng nhập qua Driver Portal (driverOnly = true).
  if (appUser && appUser.role === 'ADMIN' && !wantDriver) {
    if (!verifyPassword(password, appUser.password_hash)) return null;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + AUTH_CONFIG.sessionDuration;
    dbSaveSession(token, username, expiresAt, 'ADMIN', appUser.id);
    try {
      db.prepare("UPDATE app_users SET last_login_at = datetime('now') WHERE id = ?").run(appUser.id);
    } catch (_) {}
    return {
      token,
      role: 'ADMIN',
      username,
      fullName: appUser.full_name || username,
      redirect: '/',
    };
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
    httpOnly: AUTH_CONFIG.cookieHttpOnly,
    secure: AUTH_CONFIG.cookieSecure,
    sameSite: AUTH_CONFIG.cookieSameSite
  };
}

// Cookie options cho driver (host-only, không chia sẻ với admin domain)
function driverCookieOptions() {
  return {
    maxAge: AUTH_CONFIG.sessionDuration,
    httpOnly: true,
    secure: AUTH_CONFIG.cookieSecure,
    sameSite: 'strict',
  };
}

module.exports = {
  requireAuth,
  login,
  logout,
  getSession,
  findAppUser,
  AUTH_CONFIG,
  DRIVER_COOKIE_NAME,
  driverCookieOptions,
  cookieOptions
};
