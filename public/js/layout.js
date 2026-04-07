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
function getHeader(title, icons = '') {
  return getHeaderWithActions(title, icons, '<a href="/" class="text-primary hover:bg-primary/10 px-2 rounded" title="Dashboard">🏠</a>');
}

// Generate header with custom actions
function getHeaderWithActions(title, icons = '', actions = '') {
  return `
    <header class="topbar" style="
      height: calc(var(--topbar-height) + env(safe-area-inset-top, 0px));
      position: fixed;
      top: 0; left: 0; right: 0;
      background: var(--color-card);
      border-bottom: 1px solid var(--color-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0;
      padding-top: env(safe-area-inset-top, 0px);
      padding-left: calc(16px + env(safe-area-inset-left, 0px));
      padding-right: calc(16px + env(safe-area-inset-right, 0px));
      box-shadow: 0 2px 10px rgba(0,0,0,0.05);
      z-index: 50;
      max-width: 100%;
      box-sizing: border-box;
    ">
      <div class="logo" style="display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto;">
        <span class="logo-icon" style="font-size:20px;flex-shrink:0;">${icons}</span>
        <div style="display:flex;flex-direction:column;line-height:1.2;">
          <span class="logo-text" style="font-weight:600;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${title}</span>
          <span style="font-size:10px;color:var(--color-text-muted);margin-top:-2px;">v${appVersion}</span>
        </div>
      </div>
      <div class="actions" style="display:flex;gap:8px;font-size:18px;flex-shrink:0;align-items:center;flex-wrap:nowrap;">
        <span id="onlineStatus" class="text-xs px-2 py-0.5 rounded-full" style="background:var(--color-bg);color:var(--color-text-muted);font-size:12px;padding:2px 8px;border-radius:9999px;margin-right:4px;">⏳</span>
        <span id="syncStatus" class="text-xs" style="font-size:12px;color:var(--color-text-muted);margin-right:4px;"></span>
        <button id="themeToggle" onclick="window.__darkMode && window.__darkMode.cycle()" title="Chế độ sáng" style="background:none;border:none;cursor:pointer;font-size:18px;padding:4px 6px;border-radius:6px;">☀️</button>
        ${actions}
      </div>
    </header>
  `;
}

// Generate main content wrapper
function getContent(content) {
  return `
    <main class="page-enter" style="
      padding-top: calc(var(--topbar-height) + env(safe-area-inset-top, 0px));
      padding-bottom: calc(var(--bottomnav-height) + env(safe-area-inset-bottom, 0px));
      padding-left: max(16px, env(safe-area-inset-left, 0px));
      padding-right: max(16px, env(safe-area-inset-right, 0px));
      max-width: min(500px, 100%);
      width: 100%;
      margin: 0 auto;
      box-sizing: border-box;
    ">
      ${content}
    </main>
  `;
}

// Home = dashboard (explicit URL; / also serves dashboard on admin)
function isHomeActive(currentPage) {
  return currentPage === '/dashboard' || currentPage === '/';
}

// Generate bottom navigation - Mobile optimized (Grab-style)
// Supports: /dashboard, /, /customers, /sale, /stock, /report,
//           /kegs, /delivery, /purchases, /backup, /customer-detail, /expenses
function getBottomNav(currentPage) {
  const BASE = '/';
  const pages = [
    { href: '/', icon: '🏠', label: 'Home', home: true },
    { href: BASE + 'customers', icon: '👤', label: 'KH' },
    { href: BASE + 'sale', icon: '🍺', label: 'Bán' },
    { href: BASE + 'stock', icon: '📦', label: 'Kho' },
    { href: BASE + 'report', icon: '📊', label: 'Báo Cáo' }
  ];

  const navItem = (p) => {
    const isActive = p.home ? isHomeActive(currentPage) : currentPage === p.href;
    const homeAttr = p.home ? ' data-nav-home="1"' : '';
    return `
        <a href="${p.href}" class="${isActive ? 'active' : ''}"${homeAttr} style="
          display:flex;
          flex-direction:column;
          align-items:center;
          justify-content:center;
          gap:2px;
          color:${isActive ? 'var(--color-primary)' : 'var(--color-text-muted)'};
          text-decoration:none;
          transition:.2s;
          ${isActive ? 'font-weight:600;transform:translateY(-2px);' : ''}
        ">
          <span style="font-size:20px;">${p.icon}</span>
          <span style="font-size:11px;">${p.label}</span>
        </a>`;
  };

  return `
    <nav class="bottomnav" style="
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      height: calc(var(--bottomnav-height) + env(safe-area-inset-bottom, 0px));
      background: var(--color-card);
      border-top: 3px solid var(--color-primary);
      box-shadow: 0 -4px 20px rgba(245,158,11,0.15);
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      text-align: center;
      max-width: 500px;
      margin: 0 auto;
      z-index: 50;
      padding-bottom: env(safe-area-inset-bottom, 0px);
      padding-left: env(safe-area-inset-left, 0px);
      padding-right: env(safe-area-inset-right, 0px);
      will-change: transform;
      transform: translateZ(0);
    ">
      ${pages.map(p => navItem(p)).join('')}
    </nav>
  `;
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
    '/backup':   '/backup',
    '/purchases': '/purchases',
    '/kegs':     '/kegs',
    '/customers': '/customers',
  };
  const activePage = pageMap[path] || '/';
  container.innerHTML = getBottomNav(activePage);
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
      console.log('[Layout] realtime.js already loaded (__BEERPOS_REALTIME__ set), skipping');
      return;
    }

    // GUARD 2: Script tag already in DOM (handles static HTML pages)
    if (document.querySelector('script[src="/js/realtime.js"]')) {
      console.log('[Layout] realtime.js script tag already present, skipping');
      return;
    }

    // GUARD 3: Currently being loaded (prevents race condition)
    if (window.__BEERPOS_REALTIME_LOADING__) {
      console.log('[Layout] realtime.js currently loading, skipping duplicate');
      return;
    }

    // GUARD 4: Unified running flag
    if (window.__beerRealtimeRunning) {
      console.log('[Layout] realtime.js already running (__beerRealtimeRunning), skipping');
      return;
    }

    window.__BEERPOS_REALTIME_LOADING__ = true;
    window.__beerRealtimeRunning = true;

    var script = document.createElement('script');
    script.src = '/js/realtime.js';
    script.defer = true;
    script.onload = function () {
      window.__BEERPOS_REALTIME_LOADING__ = false;
      console.log('[Layout] realtime.js loaded successfully');
    };
    script.onerror = function () {
      window.__BEERPOS_REALTIME_LOADING__ = false;
      console.error('[Layout] Failed to load realtime.js');
    };

    document.head.appendChild(script);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadRealtime);
  } else {
    loadRealtime();
  }
})();
