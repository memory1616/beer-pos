/**
 * Driver Portal — Module BÁN HÀNG
 * ─────────────────────────────────────────────────────────────────────────────
 * Tái sử dụng nghiệp vụ chuẩn qua POST /api/driver/sales (forward tới
 * POST /api/sales của hệ thống) → giữ nguyên khuyến mãi, thưởng sản lượng,
 * công nợ, trừ kho và cập nhật số vỏ.
 */
(function () {
  'use strict';

  var D = window.Drv;

  var state = {
    customer: null,
    products: [],
    prices: {},          // productId → price của khách
    cart: [],            // { productId, name, price, qty, type }
    month: ''
  };

  // ── Helpers ─────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  function $(id) { return document.getElementById(id); }

  // ── Khách hàng ──────────────────────────────────────────────────────────
  async function searchCustomers(q) {
    try {
      var res = await D.api.customers(q);
      var list = res.customers || [];
      if (!list.length) {
        return '<div class="drv-empty"><div class="drv-empty__text">Không tìm thấy khách</div></div>';
      }
      return list.map(function (c) {
        return '<div class="drv-search-item" data-cust-id="' + c.id + '">' +
          '<div class="drv-search-item__body">' +
            '<div class="drv-search-item__name">' + esc(c.name) + '</div>' +
            '<div class="drv-search-item__meta">' +
              esc(c.phone || '—') + (c.address ? ' · ' + esc(c.address) : '') +
            '</div>' +
          '</div>' +
          '<div class="drv-search-item__meta">Nợ: ' + D.moneyShort(c.debt) + '</div>' +
        '</div>';
      }).join('');
    } catch (err) {
      return '<div class="drv-empty"><div class="drv-empty__text">' + esc(err.message) + '</div></div>';
    }
  }

  async function openCustomerPicker() {
    var body = D.openModal(
      '<div class="drv-field">' +
        '<input class="drv-input" id="mk-search" type="search" inputmode="search" ' +
               'placeholder="🔍 Tìm khách…" autocomplete="off">' +
      '</div>' +
      '<div class="drv-search-list" id="mk-results"><div class="drv-loading">Đang tải…</div></div>',
      { title: 'Chọn khách hàng' }
    );

    var input = document.getElementById('mk-search');
    var results = document.getElementById('mk-results');

    async function refresh() {
      results.innerHTML = await searchCustomers(input.value.trim());
    }

    input.addEventListener('input', debounce(refresh, 250));
    refresh();

    results.addEventListener('click', function (e) {
      var item = e.target.closest('[data-cust-id]');
      if (!item) return;
      var id = parseInt(item.getAttribute('data-cust-id'));
      selectCustomer(id);
      D.closeModal();
    });
  }

  async function selectCustomer(id) {
    try {
      var c = await D.api.customer(id);
      state.customer = c;

      // Lấy giá riêng của khách
      var pr = await D.api.prices(id);
      state.prices = {};
      (pr.prices || []).forEach(function (p) {
        if (p.product_id) state.prices[p.product_id] = p.price;
      });

      // Hiển thị
      $('customer-picker').classList.add('drv-hidden');
      $('selected-customer').classList.remove('drv-hidden');
      $('cust-name').textContent = c.name;
      $('cust-meta').textContent = (c.phone || '—') + (c.address ? ' · ' + c.address : '');
      $('cust-debt').textContent = D.money(c.debt || 0);
      $('cust-kegs').textContent = D.num(c.keg_balance || 0);

      renderProducts();
      renderCart();
    } catch (err) {
      D.toast(err.message, 'error');
    }
  }

  async function createCustomer() {
    var body = D.openModal(
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
        var res = await D.api.createCustomer({
          name: name,
          phone: document.getElementById('nc-phone').value.trim(),
          address: document.getElementById('nc-address').value.trim()
        });
        D.closeModal();
        D.toast('Đã tạo khách hàng', 'success');
        selectCustomer(res.id);
      } catch (err) {
        D.toast(err.message, 'error');
      }
    });
  }

  // ── Sản phẩm ────────────────────────────────────────────────────────────
  function effectivePrice(product) {
    if (state.customer && state.prices[product.id] !== undefined) {
      return Number(state.prices[product.id]) || 0;
    }
    return Number(product.sell_price) || 0;
  }

  function renderProducts(filter) {
    var el = $('product-list');
    var q = (filter || '').toLowerCase().trim();

    var list = state.products.filter(function (p) {
      if (!q) return true;
      return (p.name || '').toLowerCase().indexOf(q) >= 0 ||
             (p.slug || '').toLowerCase().indexOf(q) >= 0;
    });

    if (!list.length) {
      el.innerHTML = '<div class="drv-empty"><div class="drv-empty__text">Không tìm thấy sản phẩm</div></div>';
      return;
    }

    el.innerHTML = list.map(function (p) {
      var inCart = cartQty(p.id);
      return '<div class="drv-search-item" data-prod-id="' + p.id + '">' +
        '<div class="drv-search-item__body">' +
          '<div class="drv-search-item__name">' + esc(p.name) + '</div>' +
          '<div class="drv-search-item__meta">' +
            D.money(effectivePrice(p)) +
            ' · tồn: ' + D.num(p.stock || 0) +
            (p.type === 'pet' ? ' · PET' : '') +
          '</div>' +
        '</div>' +
        (inCart > 0
          ? '<div class="drv-search-item__check">' + inCart + '</div>'
          : '<div class="drv-search-item__meta">+</div>') +
      '</div>';
    }).join('');
  }

  function cartQty(productId) {
    var found = state.cart.find(function (c) { return c.productId === productId; });
    return found ? found.qty : 0;
  }

  function addToCart(productId) {
    var p = state.products.find(function (x) { return x.id === productId; });
    if (!p) return;

    var existing = state.cart.find(function (c) { return c.productId === productId; });
    if (existing) {
      existing.qty += 1;
    } else {
      state.cart.push({
        productId: p.id,
        name: p.name,
        type: p.type,
        price: effectivePrice(p),
        qty: 1
      });
    }
    renderCart();
    renderProducts($('prod-search').value);
  }

  // ── Giỏ hàng ────────────────────────────────────────────────────────────
  function renderCart() {
    var el = $('cart-items');
    var total = 0;

    if (!state.cart.length) {
      el.innerHTML = '<div class="drv-cart__row"><span class="drv-cart__label">Chưa chọn sản phẩm</span><strong>0 đ</strong></div>';
      $('btn-save-order').disabled = true;
      return;
    }

    var html = state.cart.map(function (c, idx) {
      var line = c.price * c.qty;
      total += line;
      return '<div class="drv-cart__row" style="align-items:center;">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-weight:700;font-size:0.92rem;">' + esc(c.name) + '</div>' +
          '<div class="drv-muted" style="font-size:0.78rem;">' + D.money(c.price) + ' / vỏ</div>' +
        '</div>' +
        '<div class="drv-qty" style="width:130px;">' +
          '<button class="drv-qty__btn" data-cart-dec="' + idx + '" type="button">−</button>' +
          '<span class="drv-qty__value">' + D.num(c.qty) + '</span>' +
          '<button class="drv-qty__btn" data-cart-inc="' + idx + '" type="button">+</button>' +
        '</div>' +
        '<div style="width:88px;text-align:right;font-weight:800;font-variant-numeric:tabular-nums;">' +
          D.money(line) +
        '</div>' +
      '</div>';
    }).join('');

    el.innerHTML = html +
      '<div class="drv-cart__row drv-cart__row--total">' +
        '<span class="drv-cart__label">TỔNG TIỀN</span>' +
        '<span id="cart-total">' + D.money(total) + '</span>' +
      '</div>';

    $('btn-save-order').disabled = false;
  }

  // ── Lưu đơn ─────────────────────────────────────────────────────────────
  async function saveOrder() {
    if (!state.customer) { D.toast('Vui lòng chọn khách hàng', 'warning'); return; }
    if (!state.cart.length) { D.toast('Đơn hàng trống', 'warning'); return; }

    var btn = $('btn-save-order');
    btn.disabled = true;
    btn.textContent = 'Đang lưu…';

    var payload = {
      customerId: state.customer.id,
      items: state.cart.map(function (c) {
        return { productId: c.productId, quantity: c.qty };
      }),
      deliverKegs: parseInt($('deliver-kegs').value) || 0,
      returnKegs: parseInt($('return-kegs').value) || 0,
      note: $('sale-note').value.trim()
    };

    try {
      var res = await D.api.createSale(payload);
      D.toast('Đã lưu đơn #' + res.id, 'success');

      // Reset giỏ
      state.cart = [];
      $('deliver-kegs').value = '0';
      $('return-kegs').value = '0';
      $('sale-note').value = '';
      renderCart();
      renderProducts($('prod-search').value);
      loadSales();

      // Nếu có hàng khuyến mãi → báo
      if (res.promo && res.promo.totalFree > 0) {
        D.toast('Đơn có ' + res.promo.totalFree + ' lít khuyến mãi', 'warning');
      }
    } catch (err) {
      D.toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Lưu đơn';
    }
  }

  // ── Lịch sử đơn ─────────────────────────────────────────────────────────
  async function loadSales() {
    var el = $('sales-list');
    try {
      var params = { limit: 30 };
      if (state.month) params.month = state.month;
      var res = await D.api.sales(params);
      var list = res.sales || [];

      if (!list.length) {
        el.innerHTML = '<div class="drv-empty"><div class="drv-empty__icon">📋</div>' +
          '<div class="drv-empty__text">Chưa có đơn hàng nào</div></div>';
        return;
      }

      el.innerHTML = list.map(function (s) {
        var badge = '';
        if (s.promo_free_liters > 0) {
          badge = '<span class="drv-badge drv-badge--reward">KM ' + D.num(s.promo_free_liters) + 'L</span>';
        }
        var payLabel = { paid: 'Đã trả', partial: 'Trả một phần', unpaid: 'Công nợ' }[s.payment_status] || '';
        var payBadge = s.payment_status === 'paid'
          ? '<span class="drv-badge drv-badge--delivered">Đã trả</span>'
          : (s.payment_status === 'partial'
              ? '<span class="drv-badge drv-badge--pending">Trả 1 phần</span>'
              : '<span class="drv-badge drv-badge--failed">Công nợ</span>');

        return '<div class="drv-item" data-sale-id="' + s.id + '">' +
          '<div class="drv-item__body">' +
            '<div class="drv-item__title">#' + s.id + ' · ' + esc(s.customer_name) + '</div>' +
            '<div class="drv-item__meta">' +
              D.dateLabel(s.date) + (s.sale_time ? ' ' + s.sale_time : '') +
              ' · ' + D.num(s.items_qty) + ' vỏ' +
            '</div>' +
            '<div class="drv-mt-8" style="display:flex;gap:6px;flex-wrap:wrap;">' + badge + payBadge + '</div>' +
          '</div>' +
          '<div class="drv-item__right">' +
            '<div class="drv-item__amount">' + D.money(s.total) + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    } catch (err) {
      el.innerHTML = '<div class="drv-empty"><div class="drv-empty__text">' + esc(err.message) + '</div></div>';
    }
  }

  // ── Chi tiết đơn ────────────────────────────────────────────────────────
  async function openSaleDetail(id) {
    try {
      var s = await D.api.sale(id);
      var items = s.items || [];
      var body = D.openModal(
        '<div class="drv-cart__row"><span class="drv-cart__label">Khách</span>' +
          '<strong>' + esc(s.customer_name) + '</strong></div>' +
        '<div class="drv-cart__row"><span class="drv-cart__label">Thời gian</span>' +
          '<strong>' + D.dateLabel(s.date) + (s.sale_time ? ' ' + s.sale_time : '') + '</strong></div>' +
        '<div class="drv-cart__row"><span class="drv-cart__label">Vỏ giao / trả</span>' +
          '<strong>' + D.num(s.deliver_kegs) + ' / ' + D.num(s.return_kegs) + '</strong></div>' +
        (s.promo_free_liters > 0
          ? '<div class="drv-cart__row"><span class="drv-cart__label">Khuyến mãi</span>' +
            '<strong>' + D.num(s.promo_free_liters) + ' lít</strong></div>'
          : '') +
        (s.debt
          ? '<div class="drv-cart__row"><span class="drv-cart__label">Còn công nợ</span>' +
            '<strong>' + D.money(s.debt.remaining_amount) + '</strong></div>'
          : '') +
        '<div class="drv-section__title drv-mt-16">Sản phẩm</div>' +
        items.map(function (it) {
          return '<div class="drv-cart__row">' +
            '<span>' + esc(it.product_name || it.product_slug) +
              (it.reward_quantity > 0 ? ' <span class="drv-badge drv-badge--reward">THƯỞNG</span>' : '') +
            '</span>' +
            '<strong>' + D.num(it.quantity) + ' × ' + D.money(it.price) + '</strong>' +
          '</div>';
        }).join('') +
        '<div class="drv-cart__row drv-cart__row--total">' +
          '<span class="drv-cart__label">TỔNG</span><span>' + D.money(s.total) + '</span></div>' +
        '<div class="drv-btn-row drv-mt-16">' +
          '<button class="drv-btn drv-btn--ghost" id="sd-close" type="button">Đóng</button>' +
          '<button class="drv-btn drv-btn--primary" id="sd-delivery" type="button">Tạo đơn giao</button>' +
        '</div>' +
        '<button class="drv-btn drv-btn--danger drv-mt-12" id="sd-cancel" type="button">Huỷ đơn hàng</button>',
        { title: 'Đơn #' + s.id }
      );

      document.getElementById('sd-close').addEventListener('click', D.closeModal);

      document.getElementById('sd-delivery').addEventListener('click', async function () {
        try {
          await D.api.createDelivery(s.id);
          D.closeModal();
          D.toast('Đã tạo đơn giao', 'success');
          setTimeout(function () { window.location.href = '/driver/giao-hang'; }, 500);
        } catch (err) {
          D.toast(err.message, 'error');
        }
      });

      document.getElementById('sd-cancel').addEventListener('click', async function () {
        var ok = await D.confirm(
          'Huỷ đơn #' + s.id + '? Hàng sẽ được hoàn lại kho.',
          { title: 'Huỷ đơn hàng', danger: true, okText: 'Huỷ đơn' }
        );
        if (!ok) return;
        try {
          await D.api.deleteSale(s.id);
          D.closeModal();
          D.toast('Đã huỷ đơn', 'success');
          loadSales();
        } catch (err) {
          D.toast(err.message, 'error');
        }
      });
    } catch (err) {
      D.toast(err.message, 'error');
    }
  }

  // ── Debounce ────────────────────────────────────────────────────────────
  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  // ── Init ────────────────────────────────────────────────────────────────
  async function init() {
    await D.requireAuth();
    D.setupNav('sale');
    D.setupHeader();

    try {
      var res = await D.api.products();
      state.products = res.products || [];
      renderProducts();
    } catch (err) {
      $('product-list').innerHTML = '<div class="drv-empty"><div class="drv-empty__text">' +
        esc(err.message) + '</div></div>';
    }

    loadSales();

    // Events
    $('btn-change-cust').addEventListener('click', openCustomerPicker);
    $('btn-new-cust').addEventListener('click', createCustomer);
    $('btn-save-order').addEventListener('click', saveOrder);
    $('btn-cancel-order').addEventListener('click', function () {
      state.cart = [];
      renderCart();
      renderProducts($('prod-search').value);
    });

    $('cust-search').addEventListener('input', debounce(function () {
      openCustomerPicker();
      var mk = document.getElementById('mk-search');
      if (mk) { mk.value = $('cust-search').value; mk.dispatchEvent(new Event('input')); }
    }, 300));

    $('prod-search').addEventListener('input', debounce(function () {
      renderProducts($('prod-search').value);
    }, 200));

    $('product-list').addEventListener('click', function (e) {
      var item = e.target.closest('[data-prod-id]');
      if (!item) return;
      addToCart(parseInt(item.getAttribute('data-prod-id')));
    });

    $('cart-items').addEventListener('click', function (e) {
      var inc = e.target.closest('[data-cart-inc]');
      var dec = e.target.closest('[data-cart-dec]');
      if (inc) {
        var i = parseInt(inc.getAttribute('data-cart-inc'));
        state.cart[i].qty += 1;
      } else if (dec) {
        var j = parseInt(dec.getAttribute('data-cart-dec'));
        state.cart[j].qty -= 1;
        if (state.cart[j].qty <= 0) state.cart.splice(j, 1);
      } else {
        return;
      }
      renderCart();
      renderProducts($('prod-search').value);
    });

    $('sales-list').addEventListener('click', function (e) {
      var item = e.target.closest('[data-sale-id]');
      if (!item) return;
      openSaleDetail(parseInt(item.getAttribute('data-sale-id')));
    });

    document.querySelectorAll('[data-month]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        document.querySelectorAll('[data-month]').forEach(function (c) {
          c.classList.remove('is-active');
        });
        chip.classList.add('is-active');
        state.month = chip.getAttribute('data-month');
        loadSales();
      });
    });
  }

  init();
})();
