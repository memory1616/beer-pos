/**
 * ============================================================
 * Driver Portal — Core JS
 * ============================================================
 * - API client gọi /api/driver/* (tự thêm Bearer token)
 * - Auth: dùng cookie host-only `driver_session_token` + token fallback
 * - Toast / Modal helpers
 * - Format tiền VND, ngày giờ
 * ============================================================
 */
(function () {
  'use strict';

  var SESSION_KEY = 'driver_session_token';

  // ── Token ───────────────────────────────────────────────────────────────
  function getToken() {
    try { return localStorage.getItem(SESSION_KEY) || null; } catch (_) { return null; }
  }

  function setToken(t) {
    try { if (t) localStorage.setItem(SESSION_KEY, t); else localStorage.removeItem(SESSION_KEY); } catch (_) {}
  }

  // ── API ─────────────────────────────────────────────────────────────────
  async function api(path, options) {
    options = options || {};
    var headers = Object.assign(
      { 'Content-Type': 'application/json' },
      options.headers || {}
    );

    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    var res = await fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      credentials: 'include',
      cache: 'no-store',
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (res.status === 401) {
      setToken(null);
      window.location.href = '/auth/driver';
      throw new Error('Phiên đăng nhập đã hết hạn');
    }

    var data = null;
    try { data = await res.json(); } catch (_) { data = {}; }

    if (!res.ok) {
      var msg = data.error || 'Lỗi ' + res.status;
      var err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  var API = {
    get: function (p) { return api(p); },
    post: function (p, b) { return api(p, { method: 'POST', body: b || {} }); },
    put: function (p, b) { return api(p, { method: 'PUT', body: b || {} }); },
    patch: function (p, b) { return api(p, { method: 'PATCH', body: b || {} }); },
    del: function (p) { return api(p, { method: 'DELETE' }); },

    me: function () { return api('/api/driver/me'); },
    dashboard: function () { return api('/api/driver/dashboard'); },
    products: function () { return api('/api/driver/products'); },
    prices: function (customerId) {
      return api('/api/driver/prices?customerId=' + encodeURIComponent(customerId));
    },
    customers: function (q) {
      return api('/api/driver/customers' + (q ? '?q=' + encodeURIComponent(q) : ''));
    },
    customer: function (id) { return api('/api/driver/customers/' + id); },
    createCustomer: function (b) { return api('/api/driver/customers', { method: 'POST', body: b }); },
    sales: function (params) {
      var qs = params ? '?' + new URLSearchParams(params).toString() : '';
      return api('/api/driver/sales' + qs);
    },
    sale: function (id) { return api('/api/driver/sales/' + id); },
    createSale: function (b) { return api('/api/driver/sales', { method: 'POST', body: b }); },
    updateSale: function (id, b) { return api('/api/driver/sales/' + id, { method: 'PUT', body: b }); },
    deleteSale: function (id) { return api('/api/driver/sales/' + id, { method: 'DELETE' }); },
    deliveries: function (date) {
      return api('/api/driver/deliveries' + (date ? '?date=' + date : ''));
    },
    deliveryHistory: function (params) {
      var qs = params ? '?' + new URLSearchParams(params).toString() : '';
      return api('/api/driver/deliveries/history' + qs);
    },
    createDelivery: function (saleId) {
      return api('/api/driver/deliveries', { method: 'POST', body: { saleId: saleId } });
    },
    delivery: function (id) { return api('/api/driver/deliveries/' + id); },
    setDeliveryStatus: function (id, status, extra) {
      var body = Object.assign({ status: status }, extra || {});
      return api('/api/driver/deliveries/' + id + '/status', { method: 'PATCH', body: body });
    },
    confirmDelivery: function (id, payload) {
      return api('/api/driver/deliveries/' + id + '/confirm', { method: 'POST', body: payload });
    },
    recordDiscrepancy: function (id, payload) {
      return api('/api/driver/deliveries/' + id + '/discrepancy', { method: 'POST', body: payload });
    },
    updateDeliveryKegs: function (id, collectedKegs) {
      return api('/api/driver/deliveries/' + id + '/kegs', {
        method: 'POST', body: { collectedKegs: collectedKegs }
      });
    },
    payDebt: function (customerId, amount, note) {
      return api('/api/driver/payments', {
        method: 'POST',
        body: { customerId: customerId, amount: amount, note: note }
      });
    },
    customerDebts: function (id) { return api('/api/driver/debts/' + id); },

    // ── POS nâng cao (khuyến mãi, QR, vỏ, đổi lỗi, trạng thái thanh toán) ──
    promotionsOverview: function (customerId) {
      return api('/api/driver/promotions/overview/' + encodeURIComponent(customerId));
    },
    qrAccounts: function () { return api('/api/driver/qr-accounts'); },
    updateSaleKegs: function (id, deliver, returned) {
      return api('/api/driver/sales/' + id + '/kegs', {
        method: 'POST',
        body: { deliver: deliver, returned: returned }
      });
    },
    replacement: function (b) {
      return api('/api/driver/replacement', { method: 'POST', body: b });
    },
    updatePaymentStatus: function (id, status) {
      return api('/api/driver/sales/' + id + '/payment-status', {
        method: 'PATCH', body: { payment_status: status }
      });
    }
  };

  // ── Format ──────────────────────────────────────────────────────────────
  function money(n) {
    var num = Number(n) || 0;
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency', currency: 'VND', maximumFractionDigits: 0
    }).format(num);
  }

  function moneyShort(n) {
    var num = Number(n) || 0;
    if (num >= 1000000) return (num / 1000000).toFixed(1).replace('.', ',') + ' tr';
    if (num >= 1000) return (num / 1000).toFixed(0) + 'k';
    return String(num);
  }

  function num(n) {
    return new Intl.NumberFormat('vi-VN').format(Number(n) || 0);
  }

  function dateLabel(d) {
    if (!d) return '';
    var parts = String(d).split(' ');
    var dt = parts[0].split('-');
    if (dt.length === 3) return dt[2] + '/' + dt[1] + '/' + dt[0];
    return d;
  }

  function timeNow() {
    var d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ── Bản đồ / Chỉ đường ─────────────────────────────────────────────────
  /**
   * Tạo link Google Maps chỉ đường tới khách hàng.
   * - Có lat/lng  → điểm chính xác
   * - Chỉ có địa chỉ → tìm theo text
   * Trả về null nếu không có đủ thông tin.
   */
  function mapDirectionsLink(customer) {
    if (!customer) return null;
    var lat = customer.lat;
    var lng = customer.lng;
    var hasPoint = lat !== null && lat !== undefined && lng !== null && lng !== undefined &&
                   lat !== '' && lng !== '' && !isNaN(Number(lat)) && !isNaN(Number(lng));

    if (hasPoint) {
      return 'https://www.google.com/maps/dir/?api=1&destination=' +
        encodeURIComponent(Number(lat) + ',' + Number(lng));
    }

    var address = (customer.address || '').trim();
    if (!address) return null;

    return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(address);
  }

  /** Mở Google Maps chỉ đường (tab mới) */
  function openDirections(customer) {
    var link = mapDirectionsLink(customer);
    if (!link) {
      toast('Khách chưa có địa chỉ hoặc tọa độ để chỉ đường', 'warning');
      return null;
    }
    window.open(link, '_blank', 'noopener');
    return link;
  }

  /** Link gọi điện cho khách */
  function telLink(phone) {
    var p = (phone || '').replace(/[^\d+]/g, '');
    return p ? 'tel:' + p : null;
  }

  // ── Toast ───────────────────────────────────────────────────────────────
  var toastTimer = null;
  function toast(msg, type) {
    var el = document.getElementById('drv-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'drv-toast';
      el.className = 'drv-toast';
      document.body.appendChild(el);
    }
    el.className = 'drv-toast' + (type ? ' drv-toast--' + type : '');
    el.textContent = msg;
    el.style.display = 'block';

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = 'none'; }, 2800);
  }

  // ── Modal ───────────────────────────────────────────────────────────────
  function openModal(html, opts) {
    opts = opts || {};
    closeModal();
    var wrap = document.createElement('div');
    wrap.className = 'drv-modal';
    wrap.id = 'drv-modal';
    wrap.innerHTML =
      '<div class="drv-modal__panel">' +
        '<div class="drv-modal__title">' +
          '<span>' + (opts.title || '') + '</span>' +
          '<button class="drv-modal__close" id="drv-modal-close" aria-label="Đóng">&times;</button>' +
        '</div>' +
        '<div id="drv-modal-body">' + html + '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    document.body.style.overflow = 'hidden';

    wrap.addEventListener('click', function (e) {
      if (e.target === wrap) closeModal();
    });
    document.getElementById('drv-modal-close').addEventListener('click', closeModal);
    return document.getElementById('drv-modal-body');
  }

  function closeModal() {
    var m = document.getElementById('drv-modal');
    if (m) m.remove();
    document.body.style.overflow = '';
  }

  // ── Confirm dialog ─────────────────────────────────────────────────────
  function confirmDialog(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var body = openModal(
        '<p style="margin:0 0 16px;font-size:0.95rem;line-height:1.5;">' + message + '</p>' +
        '<div class="drv-btn-row">' +
          '<button class="drv-btn drv-btn--ghost" id="drv-cancel">Huỷ</button>' +
          '<button class="drv-btn ' + (opts.danger ? 'drv-btn--danger' : 'drv-btn--primary') + '" id="drv-ok">' +
            (opts.okText || 'Xác nhận') +
          '</button>' +
        '</div>',
        { title: opts.title || 'Xác nhận' }
      );

      document.getElementById('drv-cancel').addEventListener('click', function () {
        closeModal(); resolve(false);
      });
      document.getElementById('drv-ok').addEventListener('click', function () {
        closeModal(); resolve(true);
      });
    });
  }

  // ── Prompt (nhập 1 giá trị) ─────────────────────────────────────────────
  function promptDialog(title, label, defaultValue, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var body = openModal(
        '<div class="drv-field">' +
          '<label class="drv-field__label">' + label + '</label>' +
          '<input class="drv-input" id="drv-prompt-input" type="' + (opts.type || 'text') + '" ' +
            'inputmode="' + (opts.inputmode || 'text') + '" value="' +
            (defaultValue === undefined || defaultValue === null ? '' : defaultValue) + '">' +
        '</div>' +
        '<div class="drv-btn-row">' +
          '<button class="drv-btn drv-btn--ghost" id="drv-cancel">Huỷ</button>' +
          '<button class="drv-btn drv-btn--primary" id="drv-ok">Lưu</button>' +
        '</div>',
        { title: title }
      );

      var input = document.getElementById('drv-prompt-input');
      setTimeout(function () { input.focus(); input.select(); }, 60);

      function done(val) { closeModal(); resolve(val); }
      document.getElementById('drv-cancel').addEventListener('click', function () { done(null); });
      document.getElementById('drv-ok').addEventListener('click', function () {
        done(input.value);
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') done(input.value);
      });
    });
  }

  // ── Bottom nav (active state + badge) ───────────────────────────────────
  function setupNav(activeKey) {
    var items = document.querySelectorAll('.drv-nav__item');
    items.forEach(function (el) {
      var key = el.getAttribute('data-nav');
      if (key === activeKey) el.classList.add('is-active');
    });
  }

  /**
   * Bottom menu riêng cho Driver Portal — 4 mục:
   * BÁN HÀNG · GIAO HÀNG · KHÁCH HÀNG (nếu cần cho Sale) · ĐĂNG XUẤT
   *
   * Dùng CHUNG class `.drv-nav` / `.drv-nav__item` của Driver Portal
   * (public/css/driver.css) — đây là bản Driver của `getBottomNav()` của Admin.
   */
  function getDriverBottomNav(activeKey) {
    var items = [
      { key: 'sale', href: '/driver/ban-hang', icon: '🛒', label: 'BÁN HÀNG' },
      { key: 'delivery', href: '/driver/giao-hang', icon: '🚚', label: 'GIAO HÀNG', badge: true },
      { key: 'customers', href: '/driver/khach-hang', icon: '👥', label: 'KHÁCH HÀNG' }
    ];

    var html = items.map(function (item) {
      var active = item.key === activeKey ? ' is-active' : '';
      var badge = item.badge
        ? '<span class="drv-nav__badge" data-nav-badge style="display:none">0</span>'
        : '';
      return '<a class="drv-nav__item' + active + '" data-nav="' + item.key + '" href="' + item.href + '">' +
        '<span class="drv-nav__icon">' + item.icon + '</span>' +
        '<span>' + item.label + '</span>' + badge +
      '</a>';
    }).join('');

    // Nút đăng xuất
    html += '<a class="drv-nav__item" data-nav="logout" href="/auth/driver/logout" ' +
      'onclick="event.preventDefault(); window.Drv.logout();">' +
      '<span class="drv-nav__icon">🚪</span><span>ĐĂNG XUẤT</span></a>';

    return '<nav class="drv-nav">' + html + '</nav>';
  }

  /** Đăng xuất tài xế */
  async function logout() {
    try { await fetch('/auth/driver/logout', { method: 'POST', credentials: 'include' }); } catch (_) {}
    setToken(null);
    window.location.href = '/auth/driver';
  }

  function setNavBadge(count) {
    var el = document.querySelector('[data-nav-badge]');
    if (!el) return;
    if (count > 0) {
      el.textContent = count > 99 ? '99+' : String(count);
      el.style.display = 'flex';
    } else {
      el.style.display = 'none';
    }
  }

  // ── Header user ─────────────────────────────────────────────────────────
  async function setupHeader() {
    var el = document.getElementById('drv-user');
    if (!el) return;
    try {
      var me = await API.me();
      el.textContent = me.fullName || me.username;
      var logoutBtn = document.getElementById('drv-logout');
      if (logoutBtn) {
        logoutBtn.addEventListener('click', async function () {
          try { await fetch('/auth/driver/logout', { method: 'POST', credentials: 'include' }); } catch (_) {}
          setToken(null);
          window.location.href = '/auth/driver';
        });
      }
      window.DRV_USER = me;
      return me;
    } catch (_) {
      return null;
    }
  }

  // ── Require auth (page guard) ───────────────────────────────────────────
  async function requireDriverAuth() {
    try {
      var me = await API.me();
      window.DRV_USER = me;
      return me;
    } catch (_) {
      window.location.href = '/auth/driver';
      return null;
    }
  }

  // ── Export ──────────────────────────────────────────────────────────────
  window.Drv = {
    api: API,
    money: money,
    moneyShort: moneyShort,
    num: num,
    dateLabel: dateLabel,
    timeNow: timeNow,
    mapDirectionsLink: mapDirectionsLink,
    openDirections: openDirections,
    telLink: telLink,
    toast: toast,
    openModal: openModal,
    closeModal: closeModal,
    confirm: confirmDialog,
    prompt: promptDialog,
    setupNav: setupNav,
    getDriverBottomNav: getDriverBottomNav,
    logout: logout,
    setNavBadge: setNavBadge,
    setupHeader: setupHeader,
    requireAuth: requireDriverAuth,
    getToken: getToken,
    setToken: setToken
  };

  // Bản global — tương đương `getBottomNav()` của Admin, dùng trong template.
  window.getDriverBottomNav = getDriverBottomNav;
})();
