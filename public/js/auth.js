// ==================== AUTH UTILITY ====================
// Token stored in localStorage for persistence across browser sessions.
// Logout only clears when user explicitly logs out.

const SESSION_KEY = 'beer_session_token';

// Read token from localStorage (primary) or cookie (fallback)
function getToken() {
  return localStorage.getItem(SESSION_KEY) || null;
}

// Check if user is logged in (UI state — verified with server)
function isLoggedIn() {
  return !!localStorage.getItem('auth_uid');
}

// Logout — clears local state, then call server to clear cookie
function logout() {
  localStorage.removeItem('auth_uid');
  localStorage.removeItem(SESSION_KEY);
  window.location.href = '/login/logout';
}

// On successful login — store UI state + token
function markLoggedIn() {
  localStorage.setItem('auth_uid', '1');
}

// API fetch that includes token in Authorization header
async function authFetch(url, options = {}) {
  const token = localStorage.getItem(SESSION_KEY);
  const headers = { ...options.headers };
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    logout();
    throw new Error('Login required');
  }

  return response;
}

// Check auth on page load — verify session with server via /api/auth/me
async function requireAuth() {
  const token = localStorage.getItem(SESSION_KEY);
  if (!token) {
    window.location.replace('/login');
    return false;
  }

  // Verify session with server
  let res;
  try {
    res = await fetch('/api/auth/me', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
  } catch (_) {
    window.location.replace('/login');
    return false;
  }

  if (res.ok) {
    localStorage.setItem('auth_uid', '1');
    return true;
  }

  logout();
  return false;
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.isLoggedIn = isLoggedIn;
  window.markLoggedIn = markLoggedIn;
  window.logout = logout;
  window.authFetch = authFetch;
  window.requireAuth = requireAuth;
  window.getToken = getToken;
}
