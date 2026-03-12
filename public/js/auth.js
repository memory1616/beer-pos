// ==================== AUTH UTILITY ====================
// Check if user is logged in
function isLoggedIn() {
  const token = localStorage.getItem('sessionToken');
  return !!token;
}

// Get auth token
function getAuthToken() {
  return localStorage.getItem('sessionToken');
}

// Logout
function logout() {
  localStorage.removeItem('sessionToken');
  window.location.href = '/login';
}

// API fetch with auth
async function authFetch(url, options = {}) {
  const token = getAuthToken();
  
  const headers = {
    ...options.headers,
    'Authorization': 'Bearer ' + token
  };
  
  const response = await fetch(url, { ...options, headers });
  
  // Handle 401 - redirect to login
  if (response.status === 401) {
    const data = await response.json();
    if (data.loginRequired) {
      logout();
      throw new Error('Login required');
    }
  }
  
  return response;
}

// Check auth on page load - redirect if not logged in
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
  window.getAuthToken = getAuthToken;
  window.logout = logout;
  window.authFetch = authFetch;
  window.requireAuth = requireAuth;
}
