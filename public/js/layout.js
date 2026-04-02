// Layout System - Tách layout để dùng chung cho tất cả pages
let appVersion = '1.0.0';

// Load version from version.json
async function loadVersion() {
  try {
    const res = await fetch('/version.json');
    const data = await res.json();
    appVersion = data.version || '1.0.0';
  } catch (e) {
    appVersion = '1.0.0';
  }
}

// Generate standard header
function getHeader(title, icons = '') {
  return getHeaderWithActions(title, icons, '<a href="/" class="text-primary hover:bg-primary/10 px-2 rounded" title="Dashboard">🏠</a>');
}

// Generate header with custom actions
function getHeaderWithActions(title, icons = '', actions = '') {
  return `
    <header class="topbar">
      <div class="logo">
        <span class="logo-icon">${icons}</span>
        <div class="flex flex-col leading-tight">
          <span class="logo-text">${title}</span>
          <span class="text-[10px] text-muted -mt-0.5">v${appVersion}</span>
        </div>
      </div>
      <div class="actions">
        <span id="onlineStatus" class="text-xs px-2 py-0.5 rounded-full bg-bg text-muted mr-1">⏳</span>
        <span id="syncStatus" class="text-xs text-muted mr-1"></span>
        <button id="themeToggle" onclick="window.__darkMode && window.__darkMode.cycle()" title="Chế độ sáng" style="background:none;border:none;cursor:pointer;font-size:18px;padding:4px 6px;border-radius:6px;">☀️</button>
        ${actions}
      </div>
    </header>
  `;
}

// Generate main content wrapper
function getContent(content) {
  return `
    <main class="page-enter p-4 pb-24 max-w-md mx-auto">
      ${content}
    </main>
  `;
}

// Home = dashboard (explicit URL; / also serves dashboard on admin)
function isHomeActive(currentPage) {
  return currentPage === '/dashboard' || currentPage === '/';
}

// Generate bottom navigation - Mobile optimized (Grab-style)
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
        <a href="${p.href}" class="${isActive ? 'active' : ''}"${homeAttr}>
          <span class="icon">${p.icon}</span>
          <span>${p.label}</span>
        </a>`;
  };

  // Add expenses as floating button (not in bottom nav)
  // If current page is expenses, we'll show a different nav
  if (currentPage === '/expenses') {
    return `
      <nav class="bottomnav">
        ${pages.map(p => navItem(p)).join('')}
      </nav>
    `;
  }

  return `
    <nav class="bottomnav">
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

// Một số Chrome/PWA (standalone) chặn điều hướng thường → about:blank#blocked; ép tải lại cùng tab.
function installBottomNavHomeNavigationFix() {
  document.addEventListener(
    'click',
    function (e) {
      const a = e.target.closest && e.target.closest('.bottomnav a[data-nav-home]');
      if (!a) return;
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      window.location.assign(a.href || '/');
    },
    true
  );
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installBottomNavHomeNavigationFix);
  } else {
    installBottomNavHomeNavigationFix();
  }
}
