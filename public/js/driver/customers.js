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

  function markup() {
    return '' +
      '<section class="ds-section">' +
        '<div class="ds-field">' +
          '<input class="ds-input" id="cust-search" type="search" inputmode="search" ' +
            'placeholder="🔍 Tìm khách theo tên, SĐT, địa chỉ…" autocomplete="off">' +
        '</div>' +
        '<button class="ds-btn ds-btn--primary ds-btn--block" id="btn-new-cust" type="button">' +
          '➕ Thêm khách hàng mới' +
        '</button>' +
      '</section>' +
      '<section class="ds-section">' +
        '<div class="ds-list" id="cust-list">' +
          '<div class="ds-loading">Đang tải…</div>' +
        '</div>' +
      '</section>';
  }

  async function load(q) {
    var el = $('cust-list');
    try {
      var res = await D.api.customers(q || '');
      var list = res.customers || [];

      if (!list.length) {
        el.innerHTML = window.DrvShell.empty('🔍', 'Không tìm thấy khách hàng');
        return;
      }

      el.innerHTML = list.map(function (c) {
        var debtBadge = (c.debt > 0)
          ? '<span class="ds-badge ds-badge--danger">Nợ ' + D.moneyShort(c.debt) + '</span>'
          : '<span class="ds-badge ds-badge--ok">Sạch nợ</span>';
        var kegBadge = '<span class="ds-badge ds-badge--info">Vỏ: ' +
          D.num(c.keg_balance || 0) + '</span>';

        return '<div class="ds-row ds-card--tap" data-cust-id="' + c.id + '">' +
          '<span class="ds-row__body">' +
            '<span class="ds-row__title">' + esc(c.name) + '</span>' +
            '<span class="ds-row__meta">' +
              (c.phone
                ? '<a href="tel:' + esc(c.phone) + '" style="color:var(--ds-brand-500);">' + esc(c.phone) + '</a>'
                : '—') +
              (c.address ? ' · ' + esc(c.address) : '') +
            '</span>' +
            '<span class="ds-wrap ds-mt-2">' + debtBadge + kegBadge + '</span>' +
          '</span>' +
          '<span class="ds-row__tail ds-muted" style="font-size:1.3rem;">›</span>' +
        '</div>';
      }).join('');
    } catch (err) {
      el.innerHTML = window.DrvShell.empty('⚠️', esc(err.message));
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

    // Dựng shell dùng chung (app bar + main + bottom nav)
    window.DrvShell.mount({
      key: 'customers',
      icon: '👥',
      title: 'Khách hàng',
      content: markup()
    });

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
