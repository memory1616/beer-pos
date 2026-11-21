/**
 * install-prompt.js — Banner "Cài app lên màn hình chính" cho iOS/Android
 * ─────────────────────────────────────────────────────────────────────────────
 * - iOS Safari: KHÔNG có beforeinstallprompt → hiển thị hướng dẫn thủ công
 *   (nút Chia sẻ → Thêm vào Màn hình chính).
 * - Android/Chrome: có beforeinstallprompt → hiện nút "Cài ngay".
 * - Đã cài (display-mode: standalone) → không hiện gì.
 * - Người dùng tắt → không hiện lại (lưu localStorage).
 *
 * Chỉ hiện trên mobile (viewport <= 820px) để không làm phiền desktop.
 */
(function () {
  'use strict';

  var DISMISS_KEY = 'beerpos_install_dismissed';
  var SHOW_AFTER_MS = 2500; // đợi app tải xong rồi mới hiện

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function isMobileViewport() {
    return window.matchMedia('(max-width: 820px)').matches;
  }

  function dismissed() {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (_) { return false; }
  }

  function markDismissed() {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch (_) {}
  }

  var deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
  });

  function buildUI() {
    var wrap = document.createElement('div');
    wrap.id = 'installPromptBar';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Cài ứng dụng');
    wrap.innerHTML =
      '<div class="ipb-icon"><img src="/apple-touch-icon.png" alt=""></div>' +
      '<div class="ipb-text">' +
        '<strong>Cài BeerPOS lên iPhone</strong>' +
        '<span id="ipbMsg">Chạy toàn màn hình, offline, có thông báo đơn hàng.</span>' +
      '</div>' +
      '<button id="ipbAction" class="ipb-btn ipb-btn-primary">Cài ngay</button>' +
      '<button id="ipbClose" class="ipb-btn ipb-btn-close" aria-label="Đóng">&times;</button>';
    document.body.appendChild(wrap);
    return wrap;
  }

  function show() {
    if (isStandalone() || dismissed() || !isMobileViewport()) return;
    if (document.getElementById('installPromptBar')) return;

    var bar = buildUI();
    var msg = bar.querySelector('#ipbMsg');
    var action = bar.querySelector('#ipbAction');
    var close = bar.querySelector('#ipbClose');

    if (deferredPrompt) {
      // Chrome Android — cài trực tiếp
      action.addEventListener('click', function () {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function () {
          markDismissed();
          bar.remove();
          deferredPrompt = null;
        });
      });
    } else {
      // iOS Safari — hướng dẫn thủ công
      msg.textContent = 'Bấm nút Chia sẻ (⬆) rồi chọn "Thêm vào Màn hình chính".';
      action.addEventListener('click', function () {
        window.location.href = '/install';
      });
    }

    close.addEventListener('click', function () {
      markDismissed();
      bar.remove();
    });

    // Tự ẩn sau 20s
    setTimeout(function () {
      bar.classList.add('ipb-hide');
      setTimeout(function () { bar.remove(); }, 400);
    }, 20000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(show, SHOW_AFTER_MS);
    });
  } else {
    setTimeout(show, SHOW_AFTER_MS);
  }
})();
