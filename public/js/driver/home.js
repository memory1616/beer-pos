/**
 * Driver Portal — Trang chủ
 */
(function () {
  'use strict';

  var D = window.Drv;

  async function load() {
    await D.requireAuth();
    // Trang chủ không có trong bottom menu 4 mục của Driver
    D.setupNav('home');
    D.setupHeader();

    var listEl = document.getElementById('stop-list');
    try {
      var data = await D.api.dashboard();

      // Stats
      setText('st-total', data.orders.total);
      setText('st-delivered', data.orders.delivered);
      setText('st-pending', data.orders.pending);
      setText('st-stops', data.stops);
      setText('st-to-deliver', D.num(data.liters.toDeliver));
      setText('st-delivered-liters', D.num(data.liters.delivered));
      setText('st-missing', D.num(data.liters.missing));
      setText('st-kegs', D.num(data.kegs.collected));
      setText('st-walkin', D.num(data.walkinOrders));
      setText('st-wait', D.num(data.orders.pending));
      setText('st-discrepancy', D.num(data.orders.discrepancy));

      // Badge đơn chờ giao
      D.setNavBadge(data.orders.pending + data.orders.discrepancy);

      // Danh sách khách cần ghé
      if (!data.stopList || data.stopList.length === 0) {
        listEl.innerHTML =
          '<div class="drv-empty">' +
            '<div class="drv-empty__icon">✅</div>' +
            '<div class="drv-empty__text">Hôm nay không có khách cần ghé</div>' +
          '</div>';
      } else {
        listEl.innerHTML = data.stopList.map(function (c) {
          return '<a class="drv-item" href="tel:' + esc(c.phone || '') + '" ' +
                 'style="text-decoration:none;color:inherit;">' +
                   '<div class="drv-item__body">' +
                     '<div class="drv-item__title">' + esc(c.name) + '</div>' +
                     '<div class="drv-item__meta">' +
                       esc(c.phone || 'Không có SĐT') +
                       (c.address ? ' · ' + esc(c.address) : '') +
                     '</div>' +
                   '</div>' +
                   '<div class="drv-item__right">' +
                     '<span class="drv-badge drv-badge--pending">' +
                       D.num(c.order_count) + ' đơn</span>' +
                   '</div>' +
                 '</a>';
        }).join('');
      }
    } catch (err) {
      listEl.innerHTML =
        '<div class="drv-empty">' +
          '<div class="drv-empty__icon">⚠️</div>' +
          '<div class="drv-empty__text">' + esc(err.message) + '</div>' +
        '</div>';
    }
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  load();
})();
