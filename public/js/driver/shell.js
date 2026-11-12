/**
 * ============================================================
 * Driver Portal — App Shell (Design System)
 * ============================================================
 * Nơi DUY NHẤT render khung ứng dụng dùng chung cho mọi trang:
 *   /driver · /driver/ban-hang · /driver/giao-hang · /driver/khach-hang
 *
 * Mọi trang cùng dùng:
 *   • App bar (sticky top) — logo, tiêu đề, tên tài xế, nút tài khoản
 *   • Main content
 *   • Bottom nav 4 mục — luôn ở vùng ngón cái
 *
 * Không trang nào được tự vẽ header/nav riêng.
 * ============================================================
 */
(function () {
  'use strict';

  var NAV = [
    { key: 'home',     href: '/driver',             icon: '🏠', label: 'Trang chủ' },
    { key: 'sale',     href: '/driver/ban-hang',    icon: '🛒', label: 'Bán hàng' },
    { key: 'delivery', href: '/driver/giao-hang',   icon: '🚚', label: 'Giao hàng' }
  ];

  /* ═══════════════════════════════════════════════════════════════════
   * App bar
   * ═══════════════════════════════════════════════════════════════════ */
  function appBar(opts) {
    opts = opts || {};
    var icon = opts.icon || '🚚';
    var title = opts.title || 'Cổng Tài xế';
    var sub = opts.sub || '';

    var actions = '';
    if (opts.actions) actions += opts.actions;

    return '' +
      '<header class="ds-appbar">' +
        '<span class="ds-appbar__icon" aria-hidden="true">' + icon + '</span>' +
        '<span class="ds-appbar__text">' +
          '<span class="ds-appbar__title">' + title + '</span>' +
          '<span class="ds-appbar__sub" id="drv-user">' + sub + '</span>' +
        '</span>' +
        '<span class="ds-appbar__actions">' +
          '<button type="button" class="ds-appbar__action" id="drv-logout" ' +
            'aria-label="Đăng xuất" title="Đăng xuất">🚪</button>' +
          actions +
        '</span>' +
      '</header>';
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Bottom nav
   * ═══════════════════════════════════════════════════════════════════ */
  function bottomNav(activeKey) {
    var html = NAV.map(function (item) {
      var active = item.key === activeKey ? ' is-active' : '';
      return '<a class="ds-nav__item' + active + '" data-nav="' + item.key + '" href="' + item.href + '">' +
        '<span class="ds-nav__icon" aria-hidden="true">' + item.icon + '</span>' +
        '<span class="ds-nav__label">' + item.label + '</span>' +
      '</a>';
    }).join('');

    // Nút đăng xuất (4 mục)
    html += '<a class="ds-nav__item" data-nav="logout" href="/auth/driver/logout" ' +
      'onclick="event.preventDefault(); window.Drv.logout();">' +
      '<span class="ds-nav__icon" aria-hidden="true">🚪</span>' +
      '<span class="ds-nav__label">Đăng xuất</span>' +
    '</a>';

    return '<nav class="ds-nav" aria-label="Điều hướng chính">' + html + '</nav>';
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Mount — dựng toàn bộ shell
   * ═══════════════════════════════════════════════════════════════════ */
  /**
   * @param {object} opts
   * @param {string} opts.key       trang hiện tại: home | sale | delivery
   * @param {string} opts.icon      emoji icon trên app bar
   * @param {string} opts.title     tiêu đề trang
   * @param {string} opts.content   HTML phần nội dung
   * @param {string} [opts.sub]     dòng phụ (tên tài xế) — sẽ được điền bởi setupHeader
   * @param {string} [opts.actions] extra nút trên app bar
   */
  function mount(opts) {
    opts = opts || {};

    document.body.classList.add('ds-app');
    document.body.classList.remove('ds-scroll-locked');

    // Driver Portal LUÔN dùng theme tối — đồng nhất với Trang chủ / Giao hàng.
    // Bán hàng nạp unified.css (có hỗ trợ light) → phải ép dark ở đây.
    var html = document.documentElement;
    html.setAttribute('data-theme', 'dark');
    html.classList.remove('light');
    html.classList.add('dark');
    var metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', '#0B0E11');

    var root = document.getElementById('app') || document.querySelector('main') ||
               document.body;

    // Nếu trang có #app (Admin POS) → dựng vào đó, giữ nguyên markup POS.
    if (root && root.id === 'app') {
      root.innerHTML = appBar(opts) + '<main class="ds-main" id="drv-content">' + (opts.content || '') + '</main>' + bottomNav(opts.key);
      return;
    }

    // Trang có sẵn <main> → thay nội dung bên trong, thêm app bar + nav.
    root.innerHTML = appBar(opts) + '<main class="ds-main" id="drv-content">' + (opts.content || '') + '</main>' + bottomNav(opts.key);
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Helpers cho nội dung
   * ═══════════════════════════════════════════════════════════════════ */
  function section(title, badge, body, note) {
    return '<section class="ds-section">' +
      '<div class="ds-section__head">' +
        '<h2 class="ds-section__title">' + title + '</h2>' +
        (badge !== undefined && badge !== null ? '<span class="ds-section__badge">' + badge + '</span>' : '') +
      '</div>' +
      (note ? '<p class="ds-section__note">' + note + '</p>' : '') +
      body +
    '</section>';
  }

  function card(body, mod) {
    return '<div class="ds-card' + (mod ? ' ' + mod : '') + '">' + body + '</div>';
  }

  function stat(value, label, opts) {
    opts = opts || {};
    var icon = opts.icon ? '<span class="ds-stat__icon">' + opts.icon + '</span>' : '';
    var note = opts.note ? '<span class="ds-stat__note ds-stat__note--' + (opts.noteTone || 'info') + '">' + opts.note + '</span>' : '';
    var cls = 'ds-stat' + (opts.tone ? ' ds-stat--' + opts.tone : '');
    return '<div class="' + cls + '">' + icon +
      '<span class="ds-stat__value">' + value + '</span>' +
      '<span class="ds-stat__label">' + label + '</span>' + note + '</div>';
  }

  function empty(icon, text) {
    return '<div class="ds-empty">' +
      '<span class="ds-empty__icon" aria-hidden="true">' + icon + '</span>' +
      '<span class="ds-empty__text">' + text + '</span>' +
    '</div>';
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Public API
   * ═══════════════════════════════════════════════════════════════════ */
  window.DrvShell = {
    mount: mount,
    appBar: appBar,
    bottomNav: bottomNav,
    section: section,
    card: card,
    stat: stat,
    empty: empty,
    activeKey: function () {
      var path = location.pathname.replace(/\/$/, '') || '/';
      if (path.indexOf('/driver/ban-hang') === 0) return 'sale';
      if (path.indexOf('/driver/giao-hang') === 0) return 'delivery';
      return 'home';
    }
  };
})();
