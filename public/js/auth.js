// ==================== AUTH UTILITY ====================
// IMPORTANT: Token is now stored in an httpOnly cookie (set by server on login).
// We use sessionStorage for UI state only — it auto-clears when tab/browser closes.
// The actual auth is validated server-side via the httpOnly cookie.

// Check if user is logged in (UI state only — server validates cookie)
function isLoggedIn() {
  return sessionStorage.getItem('auth_uid') === '1';
}

// Logout — calls server to clear cookie, then clears UI state
function logout() {
  sessionStorage.removeItem('auth_uid');
  // Server will clear httpOnly cookie via /login/logout
  window.location.href = '/login/logout';
}

// On successful login, UI remembers auth state via sessionStorage
// (the real token is in the httpOnly cookie, sent automatically by browser)
function markLoggedIn() {
  sessionStorage.setItem('auth_uid', '1');
}

// API fetch with Authorization header fallback
// Token is read from sessionStorage for the header; server validates httpOnly cookie
async function authFetch(url, options = {}) {
  const token = sessionStorage.getItem('sessionToken');
  const headers = {
    ...options.headers,
  };
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    const data = await response.json().catch(() => ({}));
    if (data.loginRequired) {
      logout();
      throw new Error('Login required');
    }
  }

  return response;
}

// Check auth on page load — redirect if not logged in
async function requireAuth() {
  if (!isLoggedIn()) {
    window.location.href = '/login';
    return false;
  }
  return true;
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.isLoggedIn = isLoggedIn;
  window.markLoggedIn = markLoggedIn;
  window.logout = logout;
  window.authFetch = authFetch;
  window.requireAuth = requireAuth;
}
