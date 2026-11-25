/**
 * Đăng ký Service Worker — luôn cập nhật, không bao giờ kẹt bản cũ.
 *
 * Vì sao cần helper riêng?
 * ────────────────────────────────────────────────────────────────────────
 * Nhiều view trước đây dùng:
 *     if (!navigator.serviceWorker.controller) {
 *       navigator.serviceWorker.register('/sw.v2.js?v=' + swVer)
 *     }
 *
 * Guard `!controller` có 2 hậu quả nghiêm trọng:
 *   1. Nếu SW cũ đang active → KHÔNG đăng ký lại → SW mới (chứa fix
 *      cache-busting) không bao giờ được cài → SW cũ (Cache-First cho
 *      JS/CSS) tiếp tục trả CSS cũ từ cache → user phải Ctrl+F5.
 *   2. `?v=` dùng `window.APP_VERSION` (git hash) → không đổi khi deploy
 *      mà chưa commit → browser so sánh byte thấy "không đổi" → không update.
 *
 * Cách sửa ở đây:
 *   - LUÔN đăng ký lại (không guard theo controller).
 *   - `updateViaCache: 'none'` → browser bypass HTTP cache khi tải script SW
 *     (Nginx cache `.js` 30 ngày).
 *   - `reg.update()` → ép kiểm tra bản mới ngay, kể cả khi SW đang active.
 *   - `?v=` dùng timestamp → URL luôn mới → browser chắc chắn tải script mới.
 *   - Khi có SW mới chờ activate → reload 1 lần để trang mới dùng SW mới.
 */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  // URL script SW kèm timestamp → luôn là URL mới → không bao giờ dùng bản cache.
  var swUrl = '/sw.v2.js?v=' + Date.now();

  // Cờ đánh dấu: đã reload vì SW update trong phiên này chưa.
  var RELOAD_FLAG = 'swReloadedForUpdate';

  function registerSW() {
    navigator.serviceWorker.register(swUrl, { updateViaCache: 'none' })
      .then(function (reg) {
        // Ép kiểm tra bản mới ngay (kể cả khi SW đang active).
        if (reg && typeof reg.update === 'function') {
          reg.update().catch(function () { /* im lặng */ });
        }

        // Nếu có SW mới đang chờ activate → reload 1 lần để áp dụng.
        if (reg && reg.waiting) {
          reloadOnceWhenActivated(reg.waiting);
        }
        if (reg && typeof reg.addEventListener === 'function') {
          reg.addEventListener('updatefound', function () {
            var sw = reg.installing;
            if (!sw) return;
            sw.addEventListener('statechange', function () {
              if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                reloadOnceWhenActivated(sw);
              }
            });
          });
        }
      })
      .catch(function () { /* đăng ký thất bại → im lặng, app vẫn chạy */ });

    // Nếu đang có controller → hỏi SW hiện tại có bản mới không.
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready
        .then(function (reg) {
          if (reg && typeof reg.update === 'function') {
            reg.update().catch(function () { /* im lặng */ });
          }
        })
        .catch(function () { /* im lặng */ });
    }
  }

  function reloadOnceWhenActivated(sw) {
    if (!sw) return;
    if (sessionStorage.getItem(RELOAD_FLAG)) return;
    var doReload = function () {
      try { sessionStorage.setItem(RELOAD_FLAG, '1'); } catch (e) { /* im lặng */ }
      window.location.reload();
    };
    if (sw.state === 'activated') { doReload(); return; }
    sw.addEventListener('statechange', function () {
      if (sw.state === 'activated') doReload();
    });
  }

  registerSW();
})();
