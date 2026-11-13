/**
 * Service Worker — Web Push cho Driver Portal
 * ─────────────────────────────────────────────────────────────────────────────
 * Nhiệm vụ:
 *  - Nhận event `push` từ server → hiện thông báo hệ thống của điện thoại.
 *  - Xử lý click vào thông báo → mở đúng trang (màn "Giao hàng").
 *
 * ⚠️ Không cache bất kỳ request nào — SW chỉ lo phần thông báo.
 */

// ── Khi cài đặt: kích hoạt ngay (không cần reload) ────────────────────────
self.addEventListener('install', function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

// ── Nhận push từ server ────────────────────────────────────────────────────
self.addEventListener('push', function (event) {
  var payload = {};

  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch (err) {
    payload = { title: 'BeerPOS', body: event.data ? event.data.text() : '' };
  }

  var title = payload.title || '🔔 Đơn giao mới';
  var options = {
    body: payload.body || '',
    tag: payload.tag || 'beerpos-notification',
    renotify: payload.renotify !== false,
    requireInteraction: payload.requireInteraction !== false,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: payload.vibrate || [200, 100, 200, 100, 200],
    data: payload.data || {},
    actions: [
      { action: 'open', title: 'Mở đơn giao' },
      { action: 'dismiss', title: 'Để sau' },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Click vào thông báo ────────────────────────────────────────────────────
self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  var action = event.action || 'open';
  if (action === 'dismiss') return;

  var data = event.notification.data || {};
  var url = data.url || '/driver';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      // Mở tab đang có sẵn và đưa nó lên trước
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.indexOf('/driver') === 0 && 'focus' in client) {
          client.postMessage({ type: 'push:click', data: data });
          return client.focus();
        }
      }
      // Không có tab nào → mở tab mới
      if (self.clients.openWindow) return self.clients.openWindow(url);
      return null;
    })
  );
});

// ── Đóng subscription khi server trả 404/410 (handled server-side) ────────
self.addEventListener('pushsubscriptionchange', function (event) {
  console.log('[PUSH SW] subscription changed — cần đăng ký lại từ client');
});
