/**
 * Driver Portal — Thông báo đơn giao mới (realtime trong app)
 * ─────────────────────────────────────────────────────────────────────────────
 * Khi Admin tạo đơn và gán cho tài xế này, server gửi socket event
 * `order:assigned` → module này hiển thị:
 *   - Banner lớn giữa màn hình (tên khách + số vỏ + số lít)
 *   - Âm báo (WebAudio — không cần file mp3)
 *   - Rung máy (navigator.vibrate)
 *
 * Ngoài ra hỗ trợ bật/tắt thông báo đẩy (Web Push) qua DrvPush.
 */

(function () {
  'use strict';

  var BANNER_ID = 'drv-order-banner';
  var audioCtx = null;
  var lastAlertAt = 0;

  // ── Âm báo (WebAudio) ────────────────────────────────────────────────────
  /**
   * Phát chuông 3 tiếng "bíp" ngắn bằng WebAudio.
   * Không cần file âm thanh → không tốn băng thông, hoạt động offline.
   */
  function playAlert() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended' && audioCtx.resume) {
        audioCtx.resume();
      }

      var now = audioCtx.currentTime;
      // 3 tiếng bíp: 880Hz → 1174Hz → 880Hz
      var freqs = [880, 1174, 880];
      for (var i = 0; i < freqs.length; i++) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        var start = now + i * 0.22;

        osc.type = 'sine';
        osc.frequency.value = freqs[i];

        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);

        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(start);
        osc.stop(start + 0.2);
      }
    } catch (err) {
      console.warn('[DRIVER NOTIFY] playAlert failed', err);
    }
  }

  /** Rung máy (hỗ trợ Android/Chrome). */
  function vibrate() {
    try {
      if (navigator.vibrate) {
        navigator.vibrate([220, 100, 220, 100, 220]);
      }
    } catch (_) {}
  }

  // ── Banner ───────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  /**
   * Hiện banner đơn giao mới giữa màn hình.
   * @param {object} data
   */
  function showBanner(data) {
    var existing = document.getElementById(BANNER_ID);
    if (existing) existing.remove();

    var lines = [];
    if (data.customerName) lines.push(escapeHtml(data.customerName));
    var meta = [];
    if (data.kegs > 0) meta.push(data.kegs + ' vỏ');
    if (data.liters > 0) meta.push(data.liters + ' lít');
    if (meta.length) lines.push(meta.join(' · '));
    if (data.customerAddress) {
      lines.push('<span class="drv-order-banner__addr">' + escapeHtml(data.customerAddress) + '</span>');
    }

    var banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.className = 'drv-order-banner';
    banner.innerHTML =
      '<div class="drv-order-banner__icon">🔔</div>' +
      '<div class="drv-order-banner__title">ĐƠN GIAO MỚI</div>' +
      '<div class="drv-order-banner__body">' + lines.join('<br>') + '</div>' +
      (data.customerPhone
        ? '<a class="drv-order-banner__call" href="tel:' +
          escapeHtml(String(data.customerPhone).replace(/[^\d+]/g, '')) +
          '">📞 ' + escapeHtml(data.customerPhone) + '</a>'
        : '') +
      '<button class="drv-order-banner__close" id="drv-order-banner-close">&times;</button>';

    document.body.appendChild(banner);

    var close = function () {
      if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    };
    var closeBtn = document.getElementById('drv-order-banner-close');
    if (closeBtn) closeBtn.addEventListener('click', close);

    // Tự ẩn sau 20s
    setTimeout(close, 20000);
  }

  // ── Xử lý event ──────────────────────────────────────────────────────────
  /**
   * Được gọi khi nhận socket event `order:assigned`.
   * @param {object} data
   */
  function handleOrderAssigned(data) {
    // Chống spam: tối đa 1 lần / 3 giây
    var now = Date.now();
    if (now - lastAlertAt < 3000) return;
    lastAlertAt = now;

    var customerName = data.customerName || 'Khách hàng';
    var meta = [];
    if (data.kegs > 0) meta.push(data.kegs + ' vỏ');
    if (data.liters > 0) meta.push(data.liters + ' lít');

    showBanner(data);
    playAlert();
    vibrate();

    if (window.Drv && typeof window.Drv.toast === 'function') {
      window.Drv.toast(
        '🔔 Đơn giao mới: ' + customerName + (meta.length ? ' (' + meta.join(', ') + ')' : ''),
        'warning'
      );
    }
  }

  // ── Đăng ký listener ─────────────────────────────────────────────────────
  window.addEventListener('driver:order-assigned', function (e) {
    handleOrderAssigned((e && e.detail) || {});
  });

  // Service Worker gửi message khi người dùng bấm vào thông báo đẩy
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      var msg = e && e.data;
      if (msg && msg.type === 'push:click') {
        handleOrderAssigned(msg.data || {});
      }
    });
  }

  // ── API công khai ────────────────────────────────────────────────────────
  window.DrvNotify = {
    handleOrderAssigned: handleOrderAssigned,
    playAlert: playAlert,
    vibrate: vibrate,
    showBanner: showBanner,
  };
})();
