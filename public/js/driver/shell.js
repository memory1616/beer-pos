/**
 * ============================================================
 * Driver Portal — App Shell (Design System + Responsive)
 * ============================================================
 * Nơi DUY NHẤT render khung ứng dụng dùng chung cho mọi trang:
 *   /driver            (Tổng quan)
 *   /driver/ban-hang   (Bán hàng)
 *   /driver/giao-hang  (Giao hàng)
 *   /driver/khach-hang (Khách hàng)
 *   /auth/driver       (Đăng nhập — dựng riêng, không qua shell)
 *
 * Mọi trang cùng dùng:
 *   • App bar (sticky top) — logo, tiêu đề, tên tài xế, nút đăng xuất
 *   • Main content
 *   • Bottom nav 4 mục (mobile/tablet) — luôn ở vùng ngón cái
 *   • Sidebar (desktop ≥1024px) — thay thế bottom nav, nhiều thông tin hơn
 *
 * Không trang nào được tự vẽ header/nav riêng.
 * ============================================================
 */
(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════
   * Điều hướng
   * mobile  : 4 mục — Tổng quan · Bán hàng · Giao hàng · Tài khoản
   * desktop : sidebar đầy đủ + Khách hàng + Đăng xuất
   * ═══════════════════════════════════════════════════════════════════ */
  var NAV = [
    { key: 'home',      href: '/driver',            icon: '🏠', label: 'Tổng quan',  full: 'TỔNG QUAN' },
    { key: 'sale',      href: '/driver/ban-hang',   icon: '🛒', label: 'Bán hàng',  full: 'BÁN HÀNG' },
    { key: 'delivery',  href: '/driver/giao-hang',  icon: '🚚', label: 'Giao hàng', full: 'GIAO HÀNG' },
    { key: 'customers', href: '/driver/khach-hang', icon: '👥', label: 'Khách hàng', full: 'KHÁCH HÀNG' }
  ];

  var ACCOUNT = {
    key: 'account',
    icon: '👤',
    label: 'Tài khoản',
    full: 'TÀI KHOẢN'
  };

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
          '<a class="ds-appbar__action ds-appbar__action--link" href="/driver/khach-hang" ' +
            'aria-label="Khách hàng" title="Khách hàng">👥</a>' +
          '<button type="button" class="ds-appbar__action" id="drv-logout" ' +
            'aria-label="Đăng xuất" title="Đăng xuất">🚪</button>' +
          actions +
        '</span>' +
      '</header>';
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Bottom navigation (mobile + tablet)
   * 4 mục: Tổng quan · Bán hàng · Giao hàng · Tài khoản
   * ═══════════════════════════════════════════════════════════════════ */
  function bottomNav(activeKey) {
    var html = NAV.slice(0, 3).map(function (item) {
      var active = item.key === activeKey ? ' is-active' : '';
      return '<a class="ds-nav__item' + active + '" data-nav="' + item.key + '" href="' + item.href + '">' +
        '<span class="ds-nav__icon" aria-hidden="true">' + item.icon + '</span>' +
        '<span class="ds-nav__label">' + item.label + '</span>' +
      '</a>';
    }).join('');

    // Mục "Tài khoản" → mở modal tài khoản (không đổi trang)
    var accActive = activeKey === ACCOUNT.key ? ' is-active' : '';
    html += '<button type="button" class="ds-nav__item' + accActive + '" data-nav="account">' +
      '<span class="ds-nav__icon" aria-hidden="true">' + ACCOUNT.icon + '</span>' +
      '<span class="ds-nav__label">' + ACCOUNT.label + '</span>' +
    '</button>';

    return '<nav class="ds-nav" aria-label="Điều hướng chính">' + html + '</nav>';
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Sidebar (desktop ≥1024px)
   * Thay thế bottom nav — rộng rãi, nhiều thông tin hơn.
   * ═══════════════════════════════════════════════════════════════════ */
  function sidebar(opts) {
    opts = opts || {};
    var activeKey = opts.key || 'home';

    var items = NAV.map(function (item) {
      var active = item.key === activeKey ? ' is-active' : '';
      return '<a class="ds-side__item' + active + '" data-nav="' + item.key + '" href="' + item.href + '">' +
        '<span class="ds-side__icon" aria-hidden="true">' + item.icon + '</span>' +
        '<span class="ds-side__label">' + item.full + '</span>' +
      '</a>';
    }).join('');

    items += '<button type="button" class="ds-side__item' +
      (activeKey === ACCOUNT.key ? ' is-active' : '') + '" data-nav="account">' +
      '<span class="ds-side__icon" aria-hidden="true">' + ACCOUNT.icon + '</span>' +
      '<span class="ds-side__label">' + ACCOUNT.full + '</span>' +
    '</button>';

    return '' +
      '<aside class="ds-sidebar" aria-label="Điều hướng chính">' +
        '<div class="ds-side__brand">' +
          '<img class="ds-side__logo" src="/brand/logo-64.png" alt="" width="40" height="40" decoding="async">' +
          '<span class="ds-side__brandtext">' +
            '<span class="ds-side__name">Cổng Tài xế</span>' +
            '<span class="ds-side__tag">Bia Tươi Tây Ninh</span>' +
          '</span>' +
        '</div>' +
        '<nav class="ds-side__nav">' + items + '</nav>' +
        '<div class="ds-side__foot">' +
          '<a class="ds-side__logout" href="/auth/driver/logout" ' +
            'onclick="event.preventDefault(); window.Drv &amp;&amp; window.Drv.logout();">' +
            '<span aria-hidden="true">🚪</span> ĐĂNG XUẤT' +
          '</a>' +
        '</div>' +
      '</aside>';
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Mount — dựng toàn bộ shell
   * ═══════════════════════════════════════════════════════════════════ */
  /**
   * @param {object} opts
   * @param {string} opts.key       trang hiện tại: home | sale | delivery | customers
   * @param {string} opts.icon      emoji icon trên app bar
   * @param {string} opts.title     tiêu đề trang
   * @param {string} opts.content   HTML phần nội dung
   * @param {string} [opts.sub]     dòng phụ (tên tài xế) — sẽ được điền bởi setupHeader
   * @param {string} [opts.actions] extra nút trên app bar
   * @param {string} [opts.layout]  class modifier cho <main> (ví dụ: 'ds-main--pos')
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

    var layoutClass = opts.layout ? ' ' + opts.layout : '';

    root.innerHTML =
      '<div class="ds-shell">' +
        sidebar(opts) +
        '<div class="ds-shell__body">' +
          appBar(opts) +
          '<main class="ds-main' + layoutClass + '" id="drv-content">' + (opts.content || '') + '</main>' +
        '</div>' +
      '</div>' +
      bottomNav(opts.key);

    // Nút "Tài khoản" (bottom nav + sidebar) → mở modal tài khoản
    var accountBtns = document.querySelectorAll('[data-nav="account"]');
    for (var i = 0; i < accountBtns.length; i++) {
      accountBtns[i].addEventListener('click', function () {
        if (window.Drv && typeof window.Drv.openAccountModal === 'function') {
          window.Drv.openAccountModal();
        }
      });
    }
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
    sidebar: sidebar,
    section: section,
    card: card,
    stat: stat,
    empty: empty,
    activeKey: function () {
      var path = location.pathname.replace(/\/$/, '') || '/';
      if (path.indexOf('/driver/ban-hang') === 0) return 'sale';
      if (path.indexOf('/driver/giao-hang') === 0) return 'delivery';
      if (path.indexOf('/driver/khach-hang') === 0) return 'customers';
      return 'home';
    }
  };
})();
