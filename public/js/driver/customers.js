/**
 * Driver Portal — Module KHÁCH HÀNG
 */
(function () {
  'use strict';

  var D = window.Drv;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  function $(id) { return document.getElementById(id); }

  async function load(q) {
    var el = $('cust-list');
    try {
      var res = await D.api.customers(q || '');
      var list = res.customers || [];

      if (!list.length) {
        el.innerHTML = '<div class="drv-empty"><div class="drv-empty__icon">🔍</div>' +
          '<div class="drv-empty__text">Không tìm thấy khách hàng</div></div>';
        return;
      }

      el.innerHTML = list.map(function (c) {
        var debtBadge = (c.debt > 0)
          ? '<span class="drv-badge drv-badge--failed">Nợ ' + D.moneyShort(c.debt) + '</span>'
          : '<span class="drv-badge drv-badge--delivered">Sạch nợ</span>';
        var kegBadge = '<span class="drv-badge drv-badge--progress">Vỏ: ' +
          D.num(c.keg_balance || 0) + '</span>';

        return '<div class="drv-item drv-card--tap" data-cust-id="' + c.id + '">' +
          '<div class="drv-item__body">' +
            '<div class="drv-item__title">' + esc(c.name) + '</div>' +
            '<div class="drv-item__meta">' +
              (c.phone
                ? '<a href="tel:' + esc(c.phone) + '" style="color:var(--accent);">' + esc(c.phone) + '</a>'
                : '—') +
              (c.address ? ' · ' + esc(c.address) : '') +
            '</div>' +
            '<div class="drv-mt-8" style="display:flex;gap:6px;flex-wrap:wrap;">' +
              debtBadge + kegBadge +
            '</div>' +
          '</div>' +
          '<div class="drv-item__right drv-muted" style="font-size:1.3rem;">›</div>' +
        '</div>';
      }).join('');
    } catch (err) {
      el.innerHTML = '<div class="drv-empty"><div class="drv-empty__icon">⚠️</div>' +
        '<div class="drv-empty__text">' + esc(err.message) + '</div></div>';
    }
  }

  async function openDetail(id) {
    try {
      var c = await D.api.customer(id);
      var history = c.purchaseHistory || [];

      var html =
        '<div class="drv-cart__row"><span class="drv-cart__label">Số điện thoại</span>' +
          '<strong>' + (c.phone
            ? '<a href="tel:' + esc(c.phone) + '" style="color:var(--accent);">' + esc(c.phone) + '</a>'
            : '—') + '</strong></div>' +
        '<div class="drv-cart__row"><span class="drv-cart__label">Địa chỉ</span>' +
          '<strong style="text-align:right;max-width:60%;">' + esc(c.address || '—') + '</strong></div>' +
        '<div class="drv-cart__row"><span class="drv-cart__label">Công nợ</span>' +
          '<strong>' + D.money(c.debt || 0) + '</strong></div>' +
        '<div class="drv-cart__row"><span class="drv-cart__label">Số vỏ đang giữ</span>' +
          '<strong>' + D.num(c.keg_balance || 0) + '</strong></div>' +
        '<div class="drv-cart__row"><span class="drv-cart__label">Đơn gần nhất</span>' +
          '<strong>' + (c.last_order_date ? D.dateLabel(c.last_order_date) : '—') + '</strong></div>' +
        (c.note ? '<div class="drv-cart__row"><span class="drv-cart__label">Ghi chú</span>' +
          '<strong style="text-align:right;max-width:60%;">' + esc(c.note) + '</strong></div>' : '') +

        '<div class="drv-btn-row drv-mt-16">' +
          '<button class="drv-btn drv-btn--ghost" id="cd-close" type="button">Đóng</button>' +
          '<button class="drv-btn drv-btn--primary" id="cd-order" type="button">Bán cho khách này</button>' +
        '</div>' +
        '<button class="drv-btn drv-btn--warning drv-mt-8" id="cd-pay" type="button">💰 Thu tiền công nợ</button>' +

        (history.length
          ? '<div class="drv-section__title drv-mt-16">Lịch sử đã mua</div>' +
            history.slice(0, 15).map(function (h) {
              return '<div class="drv-cart__row" style="font-size:0.85rem;">' +
                '<span>' + esc(h.product_name || h.product_slug) + '</span>' +
                '<strong>' + D.num(h.quantity) + ' × ' + D.money(h.price) + '</strong>' +
              '</div>';
            }).join('')
          : '<div class="drv-section__title drv-mt-16">Chưa có lịch sử mua</div>');

      D.openModal(html, { title: c.name });

      document.getElementById('cd-close').addEventListener('click', D.closeModal);

      document.getElementById('cd-order').addEventListener('click', function () {
        try { sessionStorage.setItem('drv_pick_customer', String(c.id)); } catch (_) {}
        window.location.href = '/driver/ban-hang';
      });

      document.getElementById('cd-pay').addEventListener('click', async function () {
        var amount = await D.prompt('Thu tiền công nợ', 'Số tiền thu (đ)', String(c.debt || 0), {
          type: 'number', inputmode: 'numeric'
        });
        if (amount === null) return;
        var val = parseFloat(amount);
        if (!val || val <= 0) { D.toast('Số tiền không hợp lệ', 'warning'); return; }
        try {
          await D.api.payDebt(c.id, val, 'Thu tiền tại điểm giao');
          D.closeModal();
          D.toast('Đã ghi nhận thanh toán', 'success');
          load($('cust-search').value);
        } catch (err) { D.toast(err.message, 'error'); }
      });
    } catch (err) {
      D.toast(err.message, 'error');
    }
  }

  function createCustomer() {
    D.openModal(
      '<div class="drv-field"><label class="drv-field__label">Tên khách *</label>' +
        '<input class="drv-input" id="nc-name" type="text" autocomplete="off"></div>' +
      '<div class="drv-field"><label class="drv-field__label">Số điện thoại</label>' +
        '<input class="drv-input" id="nc-phone" type="tel" inputmode="tel" autocomplete="off"></div>' +
      '<div class="drv-field"><label class="drv-field__label">Địa chỉ</label>' +
        '<input class="drv-input" id="nc-address" type="text" autocomplete="off"></div>' +
      '<div class="drv-btn-row">' +
        '<button class="drv-btn drv-btn--ghost" id="nc-cancel" type="button">Huỷ</button>' +
        '<button class="drv-btn drv-btn--primary" id="nc-save" type="button">Tạo</button>' +
      '</div>',
      { title: 'Thêm khách hàng' }
    );

    document.getElementById('nc-cancel').addEventListener('click', D.closeModal);
    document.getElementById('nc-save').addEventListener('click', async function () {
      var name = document.getElementById('nc-name').value.trim();
      if (!name) { D.toast('Vui lòng nhập tên khách', 'warning'); return; }
      try {
        await D.api.createCustomer({
          name: name,
          phone: document.getElementById('nc-phone').value.trim(),
          address: document.getElementById('nc-address').value.trim()
        });
        D.closeModal();
        D.toast('Đã tạo khách hàng', 'success');
        load($('cust-search').value);
      } catch (err) { D.toast(err.message, 'error'); }
    });
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  async function init() {
    await D.requireAuth();
    D.setupNav('customers');
    D.setupHeader();
    load();

    $('cust-search').addEventListener('input', debounce(function () {
      load($('cust-search').value.trim());
    }, 280));

    $('btn-new-cust').addEventListener('click', createCustomer);

    $('cust-list').addEventListener('click', function (e) {
      var item = e.target.closest('[data-cust-id]');
      if (!item) return;
      openDetail(parseInt(item.getAttribute('data-cust-id')));
    });
  }

  init();
})();
