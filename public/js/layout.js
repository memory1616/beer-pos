// ============================================================
// Utility & layout functions — all declared before any calls
// ============================================================

let appVersion = '1.0.0';

// ── Global shared state (used by stock.js, sales.js, customers.js, etc.) ──────
// Must be declared before any page-specific scripts that reference window.store
window.store = {};

// Load version from server for cache-busting and display
async function loadVersion() {
  try {
    const res = await fetch('/version.json');
    const data = await res.json();
    appVersion = data.version || '1.0.0';
  } catch (e) {
    appVersion = '1.0.0';
  }
}

// ============================================================
// Page structure builders
// ============================================================
function getHeader(title, icons) {
  if (icons === undefined) icons = '';
  return getHeaderWithActions(title, icons, '<a href="/" class="header-home-btn" title="Dashboard">🏠</a>');
}

// Generate header with custom actions
function getHeaderWithActions(title, icons, actions) {
  if (icons === undefined) icons = '';
  if (actions === undefined) actions = '';
  return `
    <header class="topbar app-header" role="banner">
      <div class="header-logo">
        <span class="header-logo-icon" aria-hidden="true">${icons}</span>
        <div class="header-logo-text">
          <span class="header-title-text">${title}</span>
          <span class="header-version-text">v${appVersion}</span>
        </div>
      </div>
      <div class="header-actions" role="navigation" aria-label="Header actions">
        <span id="syncStatus" class="sync-status" role="status" aria-live="polite"></span>
        <button id="themeToggle" onclick="window.__darkMode && window.__darkMode.cycle()" title="Đổi chế độ sáng/tối" class="theme-toggle-btn touch-target"
          aria-label="Chuyển đổi chế độ sáng tối" aria-pressed="false">
          <svg id="themeToggleSun" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
          <svg id="themeToggleMoon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>
        ${actions}
      </div>
    </header>
  `;
}

// Generate main content wrapper
function getContent(content) {
  return `
    <main class="page-content page-enter app-main">
      ${content}
    </main>
  `;
}

// Generate bottom navigation
// Supports: /dashboard, /, /customers, /sale, /stock, /report,
//           /kegs, /delivery, /purchases, /backup, /customer-detail, /expenses,
//           /devices, /analytics
function getBottomNav(currentPage) {
  const nav = [
    { path: '/', name: 'home', icon: '🏠', label: 'Home', home: true },
    { path: '/customers', name: 'kh', icon: '👤', label: 'KH' },
    { path: '/sale', name: 'ban', icon: '🍺', label: 'Bán' },
    { path: '/stock', name: 'kho', icon: '📦', label: 'Kho' },
    { path: '/report', name: 'baocao', icon: '📊', label: 'Báo Cáo' }
  ];

  const isActive = (item) => {
    if (item.home) {
      return currentPage === '/dashboard' || currentPage === '/';
    }
    return currentPage === item.path;
  };

  const navItem = (item) => {
    const active = isActive(item);
    const homeAttr = item.home ? ' data-nav-home="1"' : '';
    return `<a href="${item.path}" class="nav-item${active ? ' active' : ''}" data-path="${item.path}" data-name="${item.name}"${homeAttr}
      aria-current="${active ? 'page' : 'false'}">
      <span class="nav-item-icon" aria-hidden="true">${item.icon}</span>
      <span class="nav-item-label">${item.label}</span>
    </a>`;
  };

  return `<nav class="bottomnav app-bottom-nav" role="navigation" aria-label="Main navigation">${nav.map(navItem).join('')}</nav>`;
}

// Update active nav item - call this on page load/navigation
function updateActiveNav(currentPath) {
  const normalizedPath = currentPath.replace(/\/$/, '') || '/';
  const navItems = document.querySelectorAll('.bottomnav .nav-item');
  
  navItems.forEach(item => {
    const itemPath = item.dataset.path;
    let isActive = false;
    
    if (itemPath === '/') {
      isActive = normalizedPath === '/dashboard' || normalizedPath === '/' || normalizedPath === '/index.html';
    } else {
      isActive = normalizedPath === itemPath;
    }
    
    item.classList.toggle('active', isActive);
  });
}

// Generate skeleton loading
function getSkeleton(lines = 3) {
  return Array(lines).fill(0).map(() => `
    <div class="animate-pulse mb-3">
      <div class="h-4 bg-muted rounded w-3/4 mb-2"></div>
      <div class="h-4 bg-muted rounded w-1/2"></div>
    </div>
  `).join('');
}

// Generate card skeleton
function getCardSkeleton() {
  return `
    <div class="card mb-3 animate-pulse">
      <div class="h-4 bg-muted rounded w-1/3 mb-3"></div>
      <div class="h-8 bg-muted rounded w-1/2"></div>
    </div>
  `;
}

// Auto-load version on script load
loadVersion();

// ── Global Error Boundary ─────────────────────────────────────────────────────
window.addEventListener('error', function(e) {
  // Ignore resource loading errors (favicon, etc.)
  if (e.target && (e.target.tagName === 'LINK' || e.target.tagName === 'SCRIPT' || e.target.tagName === 'IMG')) return;
  console.error('[GLOBAL ERROR]', e.error || e.message, { filename: e.filename, lineno: e.lineno });
});

window.addEventListener('unhandledrejection', function(e) {
  const reason = e.reason;
  // IgnoreAbortError are common and harmless
  if (reason && reason.name === 'AbortError') return;
  console.error('[PROMISE ERROR]', reason);
});

// Auto-populate bottom nav on static HTML pages (report, expenses, delivery, etc.)
// These pages have <div id="bottomNavContainer"></div> and inject nav via JS after layout.js loads.
function autoInjectBottomNav() {
  if (typeof getBottomNav !== 'function') return;
  const container = document.getElementById('bottomNavContainer');
  if (!container || container.innerHTML.trim()) return;

  // Detect page from URL or body class for correct active state
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const pageMap = {
    '/expenses': '/expenses',
    '/delivery': '/delivery',
    '/report':   '/report',
    '/purchases': '/purchases',
    '/kegs':     '/kegs',
    '/customers': '/customers',
  };
  const activePage = pageMap[path] || '/';
  container.innerHTML = getBottomNav(activePage);
  updateActiveNav(path);
}

// Fix PWA/Chrome standalone nav: intercept home link click and use assign()
function installBottomNavHomeNavigationFix() {
  document.addEventListener('click', function (e) {
    const a = e.target.closest && e.target.closest('.bottomnav a[data-nav-home]');
    if (!a) return;
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    window.location.assign(a.href || '/');
  }, true);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      installBottomNavHomeNavigationFix();
      autoInjectBottomNav();
    });
  } else {
    installBottomNavHomeNavigationFix();
    autoInjectBottomNav();
  }
}

// ── Button loading state helpers ─────────────────────────────────────────────
// Used by stock.js, sales.js, purchases.js, expenses.js, and others.
// Defined early so they're available before realtime.js loads (which is deferred).

/**
 * Set button to loading state.
 * @param {HTMLButtonElement} button
 * @param {string} [loadingText] - optional text to show while loading
 * @returns {object|null} state object for restoreButtonLoading(), or null if no button
 */
function setButtonLoading(button, loadingText) {
  if (!button) return null;
  var originalText = button.innerHTML;
  button.disabled = true;
  button.dataset.originalText = originalText;
  if (loadingText) {
    button.innerHTML = loadingText + '…';
  } else {
    button.innerHTML = '⏳…';
  }
  return { button: button };
}

/**
 * Restore button from loading state.
 * @param {object|null} btnState - state object returned by setButtonLoading()
 */
function restoreButtonLoading(btnState) {
  if (!btnState || !btnState.button) return;
  var button = btnState.button;
  button.disabled = false;
  button.innerHTML = button.dataset.originalText || button.innerHTML;
}

// ── Real-time WebSocket (Socket.IO) ────────────────────────────────────────────
// Load realtime.js after layout.js initializes.
// Uses MULTIPLE guards to prevent double-loading:
//   1. window.__BEERPOS_REALTIME__ — set by realtime.js itself (guard inside IIFE)
//   2. window.__beerRealtimeRunning — unified running flag
//   3. document.querySelector check — skip if already in DOM
//   4. window.__BEERPOS_REALTIME_LOADING__ — skip if currently loading
(function () {
  function loadRealtime() {
    // Skip login page — no data to sync
    if (window.location.pathname === '/login') return;

    // GUARD 1: realtime.js already loaded (its own __BEERPOS_REALTIME__ flag)
    if (window.__BEERPOS_REALTIME__) {
      return;
    }

    // GUARD 2: Script tag already in DOM (handles static HTML pages)
    if (document.querySelector('script[src="/js/realtime.js"]')) {
      return;
    }

    // GUARD 3: Currently being loaded (prevents race condition)
    if (window.__BEERPOS_REALTIME_LOADING__) {
      return;
    }

    // GUARD 4: Unified running flag
    if (window.__beerRealtimeRunning) {
      return;
    }

    window.__BEERPOS_REALTIME_LOADING__ = true;
    window.__beerRealtimeRunning = true;

    var script = document.createElement('script');
    script.src = '/js/realtime.js?v=20260408a';
    script.defer = true;
    script.onload = function () {
      window.__BEERPOS_REALTIME_LOADING__ = false;
    };
    script.onerror = function () {
      window.__BEERPOS_REALTIME_LOADING__ = false;
    };

    document.head.appendChild(script);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadRealtime);
  } else {
    loadRealtime();
  }
})();
