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
  return getHeaderWithActions(title, icons, '<a href="/" class="text-amber-600 hover:bg-amber-50 px-2 rounded">🏠</a>');
}

// Generate header with custom actions
function getHeaderWithActions(title, icons = '', actions = '') {
  return `
    <header class="topbar">
      <div class="logo">
        <span class="logo-icon">${icons}</span>
        <div class="flex flex-col leading-tight">
          <span class="logo-text">${title}</span>
          <span class="text-[10px] text-gray-400 -mt-0.5">v${appVersion}</span>
        </div>
      </div>
      <div class="actions">
        <span id="onlineStatus" class="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-400 mr-1">⏳</span>
        <span id="syncStatus" class="text-xs text-gray-400 mr-1"></span>
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

// Generate bottom navigation - Mobile optimized (Grab-style)
function getBottomNav(currentPage) {
  const pages = [
    { href: '/', icon: '🏠', label: 'Home' },
    { href: '/customers', icon: '👤', label: 'KH' },
    { href: '/sale', icon: '🍺', label: 'Bán' },
    { href: '/stock', icon: '📦', label: 'Kho' },
    { href: '/report', icon: '📊', label: 'Báo Cáo' }
  ];

  // Add expenses as floating button (not in bottom nav)
  // If current page is expenses, we'll show a different nav
  if (currentPage === '/expenses') {
    return `
      <nav class="bottomnav">
        ${pages.map(p => {
          const isActive = currentPage === p.href;
          return `
          <a href="${p.href}" class="${isActive ? 'active' : ''}">
            <span class="icon">${p.icon}</span>
            <span>${p.label}</span>
          </a>
        `}).join('')}
      </nav>
    `;
  }

  return `
    <nav class="bottomnav">
      ${pages.map(p => {
        const isActive = currentPage === p.href;
        return `
        <a href="${p.href}" class="${isActive ? 'active' : ''}">
          <span class="icon">${p.icon}</span>
          <span>${p.label}</span>
        </a>
      `}).join('')}
    </nav>
  `;
}

// Generate skeleton loading
function getSkeleton(lines = 3) {
  return Array(lines).fill(0).map(() => `
    <div class="animate-pulse mb-3">
      <div class="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
      <div class="h-4 bg-gray-200 rounded w-1/2"></div>
    </div>
  `).join('');
}

// Generate card skeleton
function getCardSkeleton() {
  return `
    <div class="card mb-3 animate-pulse">
      <div class="h-4 bg-gray-200 rounded w-1/3 mb-3"></div>
      <div class="h-8 bg-gray-200 rounded w-1/2"></div>
    </div>
  `;
}

// Auto-load version on script load
loadVersion();
