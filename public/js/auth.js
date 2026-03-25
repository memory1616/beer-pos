// ==================== AUTH UTILITY ====================
// IMPORTANT: Token stored in httpOnly cookie (set by server on login).
// localStorage keeps login state across browser restarts.
// The actual auth is validated server-side via the httpOnly cookie.
// Token is ALSO stored in localStorage for the Authorization header fallback.

// Check if user is logged in (localStorage persistence)
function isLoggedIn() {
  return localStorage.getItem('auth_uid') === '1';
}

// Logout — calls server to clear cookie + SQLite session, then clears localStorage
function logout() {
  localStorage.removeItem('auth_uid');
  localStorage.removeItem('sessionToken');
  window.location.href = '/login/logout';
}

// On successful login, UI persists auth state via localStorage
// (the real token is in the httpOnly cookie, sent automatically by browser)
function markLoggedIn() {
  localStorage.setItem('auth_uid', '1');
}

// API fetch with Authorization header fallback
// Token read from localStorage for the header; server validates httpOnly cookie
async function authFetch(url, options = {}) {
  const token = localStorage.getItem('sessionToken');
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
