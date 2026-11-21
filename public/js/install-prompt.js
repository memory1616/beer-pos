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
  var barVisible = false;

  /**
   * Gọi prompt() của Chrome để mở hộp thoại cài app.
   * Được tách riêng để dùng được cả khi beforeinstallprompt đến SAU khi banner
   * đã hiển thị (iOS-style banner) — khi đó cần đổi nút "Hướng dẫn" thành "Cài ngay".
   */
  function doPromptInstall() {
    if (!deferredPrompt) return;
    var p = deferredPrompt;
    deferredPrompt = null;
    try { p.prompt(); } catch (_) {}
    if (p.userChoice && p.userChoice.then) {
      p.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') {
          markDismissed();
          var bar = document.getElementById('installPromptBar');
          if (bar) bar.remove();
          barVisible = false;
        }
      });
    }
  }

  /**
   * Gắn handler cho nút hành động.
   * Dùng 1 listener duy nhất + cờ mode để tránh addEventListener chồng lên nhau
   * khi beforeinstallprompt đến muộn (sau khi banner đã hiện).
   */
  function bindAction(action) {
    if (action.dataset.ipbBound === '1') return;
    action.dataset.ipbBound = '1';
    action.addEventListener('click', function () {
      if (deferredPrompt) {
        doPromptInstall();
      } else {
        window.location.href = '/install';
      }
    });
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    // preventDefault() để chặn mini-infobar native của Chrome.
    // Hệ quả: Chrome sẽ log cảnh báo "Banner not shown..." — ĐÂY LÀ THÔNG BÁO
    // THÔNG TỦ, KHÔNG PHẢI LỖI. Nút "Cài ngay" trong banner của app vẫn hoạt động
    // vì gọi deferredPrompt.prompt().
    e.preventDefault();
    deferredPrompt = e;
    // Nếu banner đã hiện (iOS-style) → đổi sang chế độ có nút cài trực tiếp
    var action = document.getElementById('ipbAction');
    if (action && barVisible) {
      action.textContent = 'Cài ngay';
      bindAction(action);
    }
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
    barVisible = true;
    var msg = bar.querySelector('#ipbMsg');
    var action = bar.querySelector('#ipbAction');
    var close = bar.querySelector('#ipbClose');

    if (deferredPrompt) {
      // Chrome Android — cài trực tiếp
      action.textContent = 'Cài ngay';
    } else {
      // iOS Safari — hướng dẫn thủ công
      msg.textContent = 'Bấm nút Chia sẻ (⬆) rồi chọn "Thêm vào Màn hình chính".';
    }
    bindAction(action);

    close.addEventListener('click', function () {
      markDismissed();
      barVisible = false;
      bar.remove();
    });

    // Tự ẩn sau 20s
    setTimeout(function () {
      bar.classList.add('ipb-hide');
      setTimeout(function () { barVisible = false; bar.remove(); }, 400);
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
