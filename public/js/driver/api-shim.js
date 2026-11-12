/**
 * Driver Portal — API SHIM cho module SALE (Admin)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu: chạy NGUYÊN `public/js/sales.js` (file gốc của Admin) trên
 * Driver Portal mà KHÔNG sửa 1 dòng nào trong file đó.
 *
 * Cách hoạt động:
 *  `public/js/sales.js` gọi các path Admin:
 *    GET  /sale/data                → GET  /api/driver/sale/data
 *    GET  /sale/history             → GET  /api/driver/sale/history
 *    GET  /sale/:id                 → GET  /api/driver/sale/:id
 *    POST /api/sales                → POST /api/driver/sale
 *    PUT  /api/sales/:id            → PUT  /api/driver/sale/:id
 *    DELETE /api/sales/:id          → DELETE /api/driver/sale/:id
 *    POST /api/sales/update-kegs    → POST /api/driver/sale/update-kegs
 *    POST /api/sales/replacement    → POST /api/driver/sale/replacement
 *    PATCH /api/sales/:id/payment-status → PATCH /api/driver/sale/:id/payment-status
 *    GET  /api/products             → GET  /api/driver/sale/products
 *    GET  /api/promotions/settings  → GET  /api/driver/sale/promotions/settings
 *    GET  /api/promotions/new-shop/check/:id → .../sale/promotions/new-shop/check/:id
 *    GET  /api/promotions/customer/:id/overview → .../sale/promotions/customer/:id/overview
 *    GET  /api/settings/qr-config   → GET  /api/driver/sale/qr-config
 *    GET  /api/settings/qr-accounts/active → GET /api/driver/sale/qr-accounts/active
 *    POST /api/kegs/deliver         → POST /api/driver/sale/kegs/deliver
 *    POST /api/kegs/collect         → POST /api/driver/sale/kegs/collect
 *
 *  Tất cả logic nghiệp vụ vẫn nằm ở file gốc — shim chỉ đổi ĐƯỜNG DẪN.
 *
 * Bảo mật:
 *  - Không endpoint nào của Admin bị lộ (apiGuard vẫn chặn 403).
 *  - Response đã được server sanitize (không cost_price / profit).
 */
(function () {
  'use strict';

  var BASE = '/api/driver/sale';

  // ── Bảng ánh xạ path → path driver ──────────────────────────────────────
  // Thứ tự quan trọng: pattern dài/đặc biệt trước pattern chung.
  var EXACT_MAP = {
    '/sale/data': BASE + '/data',
    '/sale/history': BASE + '/history',
    '/api/products': BASE + '/products',
    '/api/promotions/settings': BASE + '/promotions/settings',
    '/api/settings/qr-config': BASE + '/qr-config',
    '/api/settings/qr-accounts/active': BASE + '/qr-accounts/active',
  };

  // Prefix map — khớp bằng `startsWith`, phần hậu tố được giữ nguyên.
  var PREFIX_MAP = [
    ['/api/promotions/new-shop/check/', BASE + '/promotions/new-shop/check/'],
    ['/api/promotions/customer/', BASE + '/promotions/customer/'],
    ['/api/kegs/deliver', BASE + '/kegs/deliver'],
    ['/api/kegs/collect', BASE + '/kegs/collect'],
    ['/api/sales/update-kegs', BASE + '/update-kegs'],
    ['/api/sales/replacement', BASE + '/replacement'],
    ['/sale/', BASE + '/'], // GET /sale/:id
    ['/api/sales/', BASE + '/'], // PUT/DELETE/PATCH /api/sales/:id
  ];

  /**
   * Chuyển đổi URL Admin → URL Driver.
   * @param {string} url - URL tuyệt đối hoặc tương đối
   * @returns {string} URL mới
   */
  function rewrite(url) {
    if (!url || typeof url !== 'string') return url;

    // Chỉ xử lý URL cùng origin (bỏ qua external: VietQR, maps, ...)
    var origin = window.location.origin;
    var pathname = url;

    // Tách query string
    var query = '';
    var qIdx = url.indexOf('?');
    if (qIdx !== -1) {
      query = url.slice(qIdx);
      pathname = url.slice(0, qIdx);
    }

    // URL tuyệt đối → lấy pathname
    if (pathname.indexOf('http') === 0) {
      if (origin && pathname.indexOf(origin) !== 0) return url; // external → giữ nguyên
      try {
        pathname = new URL(pathname).pathname;
      } catch (_) {
        return url;
      }
    }

    // Bỏ query trong pathname (nếu có)
    var hIdx = pathname.indexOf('?');
    if (hIdx !== -1) pathname = pathname.slice(0, hIdx);

    // 1. Exact match
    if (EXACT_MAP[pathname]) return EXACT_MAP[pathname] + query;

    // 2. Prefix match
    for (var i = 0; i < PREFIX_MAP.length; i++) {
      var from = PREFIX_MAP[i][0];
      if (pathname === from || pathname.indexOf(from) === 0) {
        var rest = pathname.slice(from.length);
        return PREFIX_MAP[i][1] + rest + query;
      }
    }

    // 3. POST /api/sales (không có hậu tố)
    if (pathname === '/api/sales') return BASE + query;

    return url;
  }

  // ── Patch window.fetch ────────────────────────────────────────────────────
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;

  if (nativeFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') {
          var rewritten = rewrite(input);
          if (rewritten !== input) return nativeFetch(rewritten, init);
        } else if (input && typeof input === 'object' && typeof input.url === 'string') {
          var rewrittenReq = rewrite(input.url);
          if (rewrittenReq !== input.url) {
            // Request object: tạo bản sao với URL mới
            var newReq = new Request(rewrittenReq, input);
            return nativeFetch(newReq, init);
          }
        }
      } catch (_) {
        // Không được phép làm hỏng request gốc
      }
      return nativeFetch(input, init);
    };
  }

  // ── Patch XMLHttpRequest (phòng trường hợp module khác dùng XHR) ────────
  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    try {
      args[1] = rewrite(url);
    } catch (_) {}
    return nativeOpen.apply(this, args);
  };

  // ── Expose để debug/test ─────────────────────────────────────────────────
  window.__driverSaleShim = { rewrite: rewrite, BASE: BASE };
})();
