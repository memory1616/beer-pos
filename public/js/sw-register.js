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

  // URL script SW kèm version HASH ỔN ĐỊNH (không dùng Date.now()).
  //
  // ⚠️ BUG (2026-11-25): `?v=Date.now()` tạo URL MỚI mỗi lần load trang →
  // browser luôn coi đó là SW mới → install → skipWaiting() → activate →
  // clients.claim() → reload → lặp lại (reload liên tục).
  //
  // Sửa: dùng hash version từ /version.json (fallback: window.APP_VERSION).
  // Cùng hash → cùng URL → browser so sánh byte → KHÔNG install lại →
  // KHÔNG reload.
  var swUrl = '/sw.v2.js?v=' + (window.SW_VERSION || window.APP_VERSION || '38');

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
          activateAndReload(reg.waiting);
        }
        if (reg && typeof reg.addEventListener === 'function') {
          reg.addEventListener('updatefound', function () {
            var sw = reg.installing;
            if (!sw) return;
            sw.addEventListener('statechange', function () {
              if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                activateAndReload(sw);
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

  // Yeu cau SW moi activate ngay + reload 1 lan (co han).
  function activateAndReload(sw) {
    if (!sw) return;
    try {
      var last = parseInt(sessionStorage.getItem(RELOAD_FLAG) || '0', 10);
      if (last && (Date.now() - last) < RELOAD_TTL) return;
    } catch (e) { /* im lặng */ }

    // SW khong tu skipWaiting() (tranh vong lap) → client yeu cau.
    try {
      if (sw.postMessage) sw.postMessage({ type: 'SKIP_WAITING' });
    } catch (e) { /* im lặng */ }

    var doReload = function () {
      try { sessionStorage.setItem(RELOAD_FLAG, String(Date.now())); } catch (e) { /* im lặng */ }
      window.location.reload();
    };
    if (sw.state === 'activated') { doReload(); return; }
    sw.addEventListener('statechange', function () {
      if (sw.state === 'activated') doReload();
    });
  }

  registerSW();
})();
