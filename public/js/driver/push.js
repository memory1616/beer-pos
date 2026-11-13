/**
 * Driver Push Notification — đăng ký Web Push cho tài xế
 * ─────────────────────────────────────────────────────────────────────────────
 * Luồng:
 *  1. Đăng ký Service Worker (/js/driver/push-sw.js).
 *  2. Xin quyền thông báo (Notification.requestPermission).
 *  3. Subscribe với VAPID public key lấy từ /api/push/vapid-key.
 *  4. Gửi subscription lên server (POST /api/push/subscribe).
 *
 * Yêu cầu bắt buộc của Web Push: chỉ hoạt động trên HTTPS (hoặc localhost).
 * → Trên production (giaohang.biatuoitayninh.store) đã có HTTPS nên OK.
 *
 * Mọi lỗi đều được nuốt (log console) — KHÔNG được làm hỏng trang.
 */

(function () {
  'use strict';

  var SW_URL = '/js/driver/push-sw.js';
  var VAPID_URL = '/api/push/vapid-key';
  var SUBSCRIBE_URL = '/api/push/subscribe';
  var UNSUBSCRIBE_URL = '/api/push/unsubscribe';
  var STORAGE_KEY = 'drv_push_subscription';

  var registration = null;

  function log(msg, err) {
    console.log('[DRIVER PUSH] ' + msg, err || '');
  }

  /** Browser có hỗ trợ Web Push không? */
  function isSupported() {
    return (
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    );
  }

  /** Permission hiện tại: 'granted' | 'denied' | 'default' */
  function permission() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
  }

  /** Đảm bảo Service Worker đã đăng ký. */
  function ensureServiceWorker() {
    if (registration) return Promise.resolve(registration);
    if (!('serviceWorker' in navigator)) return Promise.reject(new Error('Trình duyệt không hỗ trợ Service Worker'));

    return navigator.serviceWorker
      .register(SW_URL, { scope: '/' })
      .then(function (reg) {
        registration = reg;
        log('Service Worker registered');
        return reg;
      })
  }

  /** Lấy VAPID public key từ server (dùng Bearer token của driver). */
  function fetchVapidKey() {
    var headers = {};
    try {
      var token = localStorage.getItem('driver_session_token');
      if (token) headers['Authorization'] = 'Bearer ' + token;
    } catch (_) {}

    return fetch(VAPID_URL, { headers: headers, credentials: 'include' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.publicKey) throw new Error('Thiếu VAPID public key');
        return data.publicKey;
      });
  }

  /** Gửi subscription lên server. */
  function sendToServer(subscription) {
    var headers = { 'Content-Type': 'application/json' };
    try {
      var token = localStorage.getItem('driver_session_token');
      if (token) headers['Authorization'] = 'Bearer ' + token;
    } catch (_) {}

    return fetch(SUBSCRIBE_URL, {
      method: 'POST',
      headers: headers,
      credentials: 'include',
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
  }

  /**
   * Bật thông báo đẩy.
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  function enable() {
    if (!isSupported()) {
      return Promise.resolve({ ok: false, reason: 'Trình duyệt không hỗ trợ thông báo đẩy' });
    }
    if (!window.isSecureContext) {
      return Promise.resolve({ ok: false, reason: 'Cần kết nối HTTPS để bật thông báo' });
    }

    return Notification.requestPermission()
      .then(function (perm) {
        if (perm !== 'granted') {
          return { ok: false, reason: 'Bạn chưa cho phép thông báo' };
        }
        return ensureServiceWorker()
          .then(function () { return navigator.serviceWorker.ready; })
          .then(function () { return fetchVapidKey(); })
          .then(function (publicKey) {
            return registration.pushManager
              .subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey),
              });
          })
          .then(function (subscription) {
            return sendToServer(subscription).then(function () {
              try {
                localStorage.setItem(
                  STORAGE_KEY,
                  JSON.stringify(subscription.toJSON())
                );
              } catch (_) {}
              log('Push enabled');
              return { ok: true };
            });
          });
      })
      .catch(function (err) {
        log('Enable failed', err);
        return { ok: false, reason: err.message || 'Không bật được thông báo' };
      });
  }

  /**
   * Tắt thông báo đẩy (xoá subscription).
   * @returns {Promise<{ok:boolean}>}
   */
  function disable() {
    if (!isSupported()) return Promise.resolve({ ok: false });

    var headers = { 'Content-Type': 'application/json' };
    try {
      var token = localStorage.getItem('driver_session_token');
      if (token) headers['Authorization'] = 'Bearer ' + token;
    } catch (_) {}

    return ensureServiceWorker()
      .then(function () { return registration.pushManager.getSubscription(); })
      .then(function (subscription) {
        if (!subscription) return null;
        var endpoint = subscription.endpoint;
        return subscription
          .unsubscribe()
          .then(function () {
            return fetch(UNSUBSCRIBE_URL, {
              method: 'POST',
              headers: headers,
              credentials: 'include',
              body: JSON.stringify({ endpoint: endpoint }),
            });
          });
      })
      .then(function () {
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
        log('Push disabled');
        return { ok: true };
      })
      .catch(function (err) {
        log('Disable failed', err);
        return { ok: false };
      });
  }

  /** Trạng thái hiện tại (dùng cho UI). */
  function status() {
    return {
      supported: isSupported(),
      permission: permission(),
      enabled: permission() === 'granted',
    };
  }

  /**
   * Chuyển base64 (VAPID key) sang Uint8Array.
   */
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  /**
   * Tự động bật push nếu tài xế đã cho phép trước đó.
   * Gọi 1 lần khi vào Driver Portal.
   */
  function autoEnableIfGranted() {
    if (!isSupported()) return;
    if (permission() !== 'granted') return;
    if (localStorage.getItem(STORAGE_KEY)) return; // đã đăng ký rồi

    ensureServiceWorker()
      .then(function () { return navigator.serviceWorker.ready; })
      .then(function () { return fetchVapidKey(); })
      .then(function (publicKey) {
        return registration.pushManager
          .subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          })
          .then(sendToServer);
      })
      .catch(function (err) {
        log('Auto enable failed', err);
      });
  }

  window.DrvPush = {
    isSupported: isSupported,
    permission: permission,
    enable: enable,
    disable: disable,
    status: status,
    autoEnableIfGranted: autoEnableIfGranted,
  };
})();
