/**
 * ============================================================
 * Driver Portal — Đồng bộ dữ liệu giữa các trang (real-time)
 * ============================================================
 * Mục tiêu: giữ cho "ĐƠN GẦN ĐÂY" (trang Bán hàng) và danh sách đơn giao
 * (trang Giao hàng) LUÔN khớp nhau.
 *
 * Cơ chế:
 *  - Server phát Socket.IO event `order:created` / `order:updated` /
 *    `order:deleted` / `refetch:now` cho mọi client đang kết nối.
 *  - `public/js/realtime.js` (nạp tự động qua layout.js) bắt các event này
 *    và dispatch `realtime:refetch` trên window.
 *  - Module này lắng nghe `realtime:refetch` + `data:mutated` và gọi lại
 *    callback đăng ký (refresh danh sách đơn) với debounce để tránh spam.
 *
 * Fallback: nếu Socket.IO không khả dụng (mạng yếu, proxy chặn), vẫn có
 * polling nhẹ (mỗi 60s) + refresh khi người dùng quay lại tab (visibility).
 * ============================================================
 */
(function () {
  'use strict';

  if (window.__DRIVER_SYNC__) return;

  var callbacks = [];
  var timer = null;
  var pollTimer = null;
  var POLL_MS = 60000;

  function scheduleRefresh(reason) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      var i;
      for (i = 0; i < callbacks.length; i++) {
        try {
          callbacks[i](reason);
        } catch (e) {
          console.error('[DRIVER-SYNC] callback error:', e);
        }
      }
    }, 300);
  }

  /**
   * Đăng ký hàm gọi lại khi có thay đổi dữ liệu đơn hàng.
   * @param {function(string):void} fn
   */
  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    callbacks.push(fn);
    return function () {
      var idx = callbacks.indexOf(fn);
      if (idx !== -1) callbacks.splice(idx, 1);
    };
  }

  /** Gọi refresh ngay (dùng sau khi tài xế tự tạo/sửa đơn). */
  function refreshNow(reason) {
    scheduleRefresh(reason || 'manual');
  }

  // ── Realtime events từ public/js/realtime.js ───────────────────────────
  window.addEventListener('realtime:refetch', function (e) {
    var entities = (e.detail && e.detail.entities) || [];
    if (
      entities.indexOf('all') !== -1 ||
      entities.indexOf('orders') !== -1 ||
      entities.indexOf('sales') !== -1 ||
      entities.indexOf('inventory') !== -1 ||
      entities.indexOf('products') !== -1 ||
      entities.indexOf('deliveries') !== -1
    ) {
      scheduleRefresh('realtime');
    }
  });

  // ── Sự kiện nội bộ (sau khi bán hàng / sửa đơn trong chính trang) ───────
  window.addEventListener('data:mutated', function (e) {
    var ent = e.detail && e.detail.entity;
    if (!ent) return;
    if (
      ent === 'sale' ||
      ent === 'inventory' ||
      ent === 'product' ||
      ent === 'kegs' ||
      ent === 'delivery' ||
      ent === 'deliveries' ||
      ent === 'sync' ||
      ent === 'all'
    ) {
      scheduleRefresh('mutated:' + ent);
    }
  });

  // ── Quay lại tab → refresh ngay ────────────────────────────────────────
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) scheduleRefresh('visibility');
  });

  window.addEventListener('focus', function () {
    scheduleRefresh('focus');
  });

  // ── Online lại → refresh ────────────────────────────────────────────────
  window.addEventListener('online', function () {
    scheduleRefresh('online');
  });

  // ── Fallback polling (khi Socket.IO không khả dụng) ────────────────────
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      // Chỉ poll khi tab đang hiển thị để không tốn pin/mạng
      if (!document.hidden) scheduleRefresh('poll');
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function isRealtimeActive() {
    return !!(window.Realtime && window.__BEERPOS_SOCKET_INST__ && window.__BEERPOS_SOCKET_INST__.connected);
  }

  // Bật polling ngay, và tắt khi realtime đã kết nối (tiết kiệm tài nguyên).
  startPolling();
  var realtimeWatch = setInterval(function () {
    if (isRealtimeActive()) {
      stopPolling();
      clearInterval(realtimeWatch);
    }
  }, 3000);

  window.__DRIVER_SYNC__ = {
    onChange: onChange,
    refreshNow: refreshNow,
    isRealtimeActive: isRealtimeActive,
    stopPolling: stopPolling
  };

  window.DrvSync = window.__DRIVER_SYNC__;

  /* ── Khoá cuộn nền khi mở modal ──────────────────────────────────────────
   * Driver Portal dùng DOCUMENT làm vùng cuộn duy nhất (body overflow visible).
   * Vì vậy khi modal mở, phải khoá scroll ở CẢ `html` lẫn `body`,
   * nếu không nền vẫn cuộn được sau modal.
   *
   * Gắn listener ở cấp document (capture) để áp dụng cho mọi modal:
   *  - class `modal-open` (sales.js, unified.css)
   *  - inline `body.style.overflow = 'hidden'` (driver/core.js)
   */
  function syncScrollLock() {
    var body = document.body;
    if (!body) return;
    var locked = body.classList.contains('modal-open') ||
      (body.style && body.style.overflow === 'hidden') ||
      !!document.querySelector('.drv-modal');
    document.documentElement.classList.toggle('drv-scroll-locked', locked);
  }

  window.DrvSync.syncScrollLock = syncScrollLock;

  // Quan sát thay đổi class/style của body
  if (window.MutationObserver) {
    var mo = new MutationObserver(syncScrollLock);
    var startObserve = function () {
      if (!document.body) return setTimeout(startObserve, 50);
      mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
      syncScrollLock();
    };
    startObserve();
  }

  // Bảo đảm khoá được set khi modal vừa được thêm vào DOM
  document.addEventListener('DOMNodeInserted', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('drv-modal')) {
      setTimeout(syncScrollLock, 0);
    }
  }, true);
})();
