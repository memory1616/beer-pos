/**
 * Driver Portal — Module BÁN HÀNG (POS đầy đủ)
 * ─────────────────────────────────────────────────────────────────────────────
 * Nghiệp vụ bán hàng ĐƯỢC TÁI SỬ DỤNG nguyên vẹn qua POST/PUT /api/driver/sales
 * (forward tới routes/api/sales.js) → giữ nguyên khuyến mãi, thưởng sản lượng,
 * công nợ, trừ kho và cập nhật số vỏ.
 *
 * Tính năng (mirror trang /sale của admin, đã sanitize cho DRIVER):
 *  - Chọn khách + badge KM quán mới / thưởng sản lượng
 *  - Bảng sản phẩm sửa GIÁ + SỐ LƯỢNG trực tiếp
 *  - Vỏ giao / vỏ thu / ghi chú / bán chịu
 *  - Preview khuyến mãi quán mới
 *  - Hoá đơn + VietQR (chọn tài khoản QR)
 *  - Cập nhật vỏ theo đơn, đổi bia lỗi / tặng uống thử
 *  - Lịch sử đơn có phân trang + lọc theo tháng
 *  - 🗺️ Chỉ đường tới khách (Google Maps link) + 📞 Gọi khách
 */
(function () {
  'use strict';

  var D = window.Drv;

  var state = {
    customer: null,
    products: [],
    prices: {},          // productId → price của khách
    cart: [],            // { productId, name, type, price, qty }
    month: '',
    page: 1,
    totalPages: 1,
    promo: null,         // overview khuyến mãi của khách hiện tại
    qrAccounts: [],
    currentQR: null
  };

  // ── Helpers ─────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  function $(id) { return document.getElementById(id); }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function classifyBeerType(productName) {
    if (!productName) return 'gold';
    var name = String(productName).toLowerCase();
    var blackKeywords = ['guinness', 'kilkenny', 'murphy', 'black', 'đen', 'smithwick'];
    for (var i = 0; i < blackKeywords.length; i++) {
      if (name.indexOf(blackKeywords[i]) !== -1) return 'black';
    }
    return 'gold';
  }

  // ═════════════════════════════════════════════════════════════════════════
  // KHÁCH HÀNG
  // ═════════════════════════════════════════════════════════════════════════
  async function searchCustomers(q) {
    try {
      var res = await D.api.customers(q);
      var list = res.customers || [];
      if (!list.length) {
        return '<div class="drv-empty"><div class="drv-empty__text">Không tìm thấy khách</div></div>';
      }
      return list.map(function (c) {
        var dir = D.mapDirectionsLink(c);
        var mapBtn = dir
          ? '<a href="' + esc(dir) + '" target="_blank" rel="noopener" ' +
            'class="drv-btn drv-btn--ghost drv-btn--sm" style="width:auto;">🗺️</a>'
          : '';
        return '<div class="drv-search-item" data-cust-id="' + c.id + '">' +
          '<div class="drv-search-item__body">' +
            '<div class="drv-search-item__name">' + esc(c.name) + '</div>' +
            '<div class="drv-search-item__meta">' +
              esc(c.phone || '—') + (c.address ? ' · ' + esc(c.address) : '') +
            '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:6px;">' +
            '<div class="drv-search-item__meta">Nợ: ' + D.moneyShort(c.debt) + '</div>' +
            mapBtn +
          '</div>' +
        '</div>';
      }).join('');
    } catch (err) {
      return '<div class="drv-empty"><div class="drv-empty__text">' + esc(err.message) + '</div></div>';
    }
  }

  async function openCustomerPicker() {
    D.openModal(
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
      if (e.target.closest('a[href^="https://www.google.com/maps"]')) return;
      var item = e.target.closest('[data-cust-id]');
      if (!item) return;
      selectCustomer(parseInt(item.getAttribute('data-cust-id')));
      D.closeModal();
    });
  }

  async function selectCustomer(id) {
    try {
      var c = await D.api.customer(id);
      state.customer = c;

      // Giá riêng của khách
      var pr = await D.api.prices(id);
      state.prices = {};
      (pr.prices || []).forEach(function (p) {
        if (p.product_id) state.prices[p.product_id] = p.price;
      });

      $('customer-picker').classList.add('drv-hidden');
      $('selected-customer').classList.remove('drv-hidden');
      $('cust-name').textContent = c.name;
      $('cust-meta').textContent = (c.phone || '—') + (c.address ? ' · ' + c.address : '');
      $('cust-addr').textContent = c.lat && c.lng
        ? '📍 Đã có tọa độ GPS — có thể chỉ đường'
        : (c.address ? '📍 ' + c.address : '📍 Chưa có địa chỉ');
      $('cust-debt').textContent = D.money(c.debt || 0);
      $('cust-kegs').textContent = D.num(c.keg_balance || 0);

      renderProducts();
      renderCart();
      loadPromoBadges(id);

      // Nếu đến từ trang khách hàng (sessionStorage)
      try {
        var picked = sessionStorage.getItem('drv_pick_customer');
        if (picked && String(picked) === String(id)) {
          sessionStorage.removeItem('drv_pick_customer');
        }
      } catch (_) {}
    } catch (err) {
      D.toast(err.message, 'error');
    }
  }

  async function createCustomer() {
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

  // ═════════════════════════════════════════════════════════════════════════
  // KHUYẾN MÃI
  // ═════════════════════════════════════════════════════════════════════════
  async function loadPromoBadges(customerId) {
    var box = $('promo-badges');
    try {
      var res = await D.api.promotionsOverview(customerId);
      var d = (res && res.data) || {};
      state.promo = d;

      var html = '';

      if (d.promotionEnabled === false) {
        html += '<div class="drv-promo-badge drv-promo-badge--danger">🚫 Khách tắt CTKM — Không áp dụng khuyến mãi</div>';
      } else {
        if (d.newShop && d.newShop.eligible) {
          html += '<div class="drv-promo-badge drv-promo-badge--new">🎁 Khách mới (ngày ' +
            esc(d.newShop.createdDay) + ') — Mua ' + esc(d.newShop.buyGold) +
            ' tặng ' + esc(d.newShop.freeGold) + '</div>';
        } else if (d.isInNewShopPeriod) {
          html += '<div class="drv-promo-badge drv-promo-badge--new">🔥 Khách đang trong thời gian quán mới</div>';
        }

        var reward = d.monthlyReward;
        if (reward && reward.hasRemaining && d.canReceiveReward) {
          var parts = [];
          if (reward.yellowReward > 0) parts.push(reward.yellowReward + 'L vàng');
          if (reward.blackReward > 0) parts.push(reward.blackReward + 'L đen');
          var txt = parts.length ? parts.join(' + ') : (reward.remainingReward || 0) + 'L';
          html += '<div class="drv-promo-badge drv-promo-badge--reward">🏆 Thưởng tháng: ' +
            esc(txt) + ' còn có thể nhận</div>';
        }
      }

      box.innerHTML = html;
      box.classList.toggle('drv-hidden', !html);
      updatePromoPreview();
    } catch (err) {
      box.classList.add('drv-hidden');
      state.promo = null;
    }
  }

  function updatePromoPreview() {
    var el = $('promo-preview');
    if (!el) return;

    var promo = state.promo;
    if (!promo || promo.promotionEnabled === false || !promo.newShop || !promo.newShop.eligible) {
      el.classList.add('drv-hidden');
      el.innerHTML = '';
      return;
    }

    var qtyGold = 0, qtyBlack = 0;
    state.cart.forEach(function (item) {
      if (!item.qty || item.qty <= 0) return;
      if (item.type !== 'keg') return;
      if (classifyBeerType(item.name) === 'black') qtyBlack += item.qty;
      else qtyGold += item.qty;
    });

    var s = promo.newShopSettings || {};
    var goldBuy = s.goldBuy || 10, goldFree = s.goldFree || 1;
    var blackBuy = s.blackBuy || 20, blackFree = s.blackFree || 1;

    var freeGold = Math.floor(qtyGold / goldBuy) * goldFree;
    var freeBlack = Math.floor(qtyBlack / blackBuy) * blackFree;
    var totalFree = freeGold + freeBlack;

    if (totalFree <= 0) {
      el.classList.add('drv-hidden');
      el.innerHTML = '';
      return;
    }

    var lines = [];
    if (freeGold > 0) lines.push('Tặng <b>' + freeGold + 'L</b> bia vàng');
    if (freeBlack > 0) lines.push('Tặng <b>' + freeBlack + 'L</b> bia đen');

    el.classList.remove('drv-hidden');
    el.innerHTML = '🎁 Khuyến mãi quán mới: ' + lines.join(' | ');
  }

  // ═════════════════════════════════════════════════════════════════════════
  // SẢN PHẨM
  // ═════════════════════════════════════════════════════════════════════════
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
      var cart = cartItem(p.id);
      var price = cart ? cart.price : effectivePrice(p);
      var qty = cart ? cart.qty : '';
      var edited = price !== (Number(p.sell_price) || 0);

      return '<div class="drv-prod" data-prod-id="' + p.id + '">' +
        '<div class="drv-prod__main">' +
          '<div class="drv-prod__name">' + esc(p.name) + '</div>' +
          '<div class="drv-prod__meta">Tồn: ' + D.num(p.stock || 0) +
            (p.type === 'pet' ? ' · PET' : '') + '</div>' +
          '<div class="drv-prod__price-wrap">' +
            '<input class="drv-prod__price' + (edited ? ' is-edited' : '') + '" ' +
              'type="number" inputmode="numeric" min="0" step="1000" ' +
              'data-price-id="' + p.id + '" value="' + price + '">' +
            '<span class="drv-prod__price-label">đ / vỏ</span>' +
          '</div>' +
        '</div>' +
        '<div class="drv-prod__qty">' +
          '<button class="drv-qty__btn" data-prod-dec="' + p.id + '" type="button">−</button>' +
          '<input class="drv-prod__qty-input" type="number" inputmode="numeric" min="0" ' +
            'data-qty-id="' + p.id + '" value="' + qty + '" placeholder="0">' +
          '<button class="drv-qty__btn" data-prod-inc="' + p.id + '" type="button">+</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function cartItem(productId) {
    return state.cart.find(function (c) { return c.productId === productId; }) || null;
  }

  function cartQty(productId) {
    var it = cartItem(productId);
    return it ? it.qty : 0;
  }

  function setCartQty(productId, qty) {
    var p = state.products.find(function (x) { return x.id === productId; });
    if (!p) return;

    qty = parseInt(qty) || 0;

    if (qty <= 0) {
      state.cart = state.cart.filter(function (c) { return c.productId !== productId; });
    } else {
      var existing = cartItem(productId);
      if (existing) {
        existing.qty = qty;
      } else {
        state.cart.push({
          productId: p.id,
          name: p.name,
          type: p.type,
          price: effectivePrice(p),
          qty: qty
        });
      }
    }

    renderCart();
    updatePromoPreview();
  }

  function setCartPrice(productId, price) {
    var existing = cartItem(productId);
    if (!existing) return;
    existing.price = parseInt(price) || 0;
    renderCart();
  }

  function addToCart(productId) {
    var cur = cartQty(productId);
    setCartQty(productId, cur + 1);
    renderProducts($('prod-search').value);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // GIỎ HÀNG
  // ═════════════════════════════════════════════════════════════════════════
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

  // ═════════════════════════════════════════════════════════════════════════
  // LƯU ĐƠN
  // ═════════════════════════════════════════════════════════════════════════
  async function saveOrder() {
    if (!state.customer) { D.toast('Vui lòng chọn khách hàng', 'warning'); return; }
    if (!state.cart.length) { D.toast('Đơn hàng trống', 'warning'); return; }

    var btn = $('btn-save-order');
    btn.disabled = true;
    btn.textContent = 'Đang lưu…';

    var payload = {
      customerId: state.customer.id,
      items: state.cart.map(function (c) {
        return { productId: c.productId, quantity: c.qty, price: c.price };
      }),
      deliverKegs: parseInt($('deliver-kegs').value) || 0,
      returnKegs: parseInt($('return-kegs').value) || 0,
      debt: $('sale-debt') ? $('sale-debt').checked : false,
      note: $('sale-note').value.trim()
    };

    try {
      var res = await D.api.createSale(payload);
      D.toast('Đã lưu đơn #' + res.id, 'success');

      state.cart = [];
      $('deliver-kegs').value = '0';
      $('return-kegs').value = '0';
      $('sale-note').value = '';
      if ($('sale-debt')) $('sale-debt').checked = false;
      renderCart();
      renderProducts($('prod-search').value);
      loadSales();

      if (res.promo && res.promo.totalFree > 0) {
        D.toast('Đơn có ' + res.promo.totalFree + ' lít khuyến mãi', 'warning');
      }
      if (res.autoReward && res.autoReward.success) {
        D.toast('Đã gắn thưởng sản lượng vào đơn', 'success');
      }

      showInvoice(res.id);
    } catch (err) {
      D.toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Lưu đơn';
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // HOÁ ĐƠN + VIETQR
  // ═════════════════════════════════════════════════════════════════════════
  function generateVietQR(invoice) {
    var amount = invoice && invoice.total ? Math.round(invoice.total) : 0;
    var invoiceId = invoice && invoice.id ? invoice.id : '';

    var qr = state.currentQR;
    var bankCode = qr ? qr.bank_code : 'ICB';
    var accountNo = qr ? qr.account_no : '';
    var accountName = qr ? qr.account_name : '';
    var template = (qr && qr.template) || 'compact2';
    var defaultContent = (qr && qr.default_content) || 'Thanh toan HD {invoice_id}';

    if (!accountNo) return null;

    var content = String(defaultContent).replace(/\{invoice_id\}/gi, invoiceId);

    return 'https://img.vietqr.io/image/' + String(bankCode).toUpperCase() + '-' + accountNo + '-' +
      template + '.png?amount=' + amount +
      '&addInfo=' + encodeURIComponent(content) +
      '&accountName=' + encodeURIComponent(String(accountName).toUpperCase());
  }

  async function loadQRAccounts() {
    if (state.qrAccounts.length) return state.qrAccounts;
    try {
      var res = await D.api.qrAccounts();
      state.qrAccounts = Array.isArray(res) ? res : [];
      if (state.qrAccounts.length && !state.currentQR) {
        state.currentQR = state.qrAccounts[0];
      }
    } catch (err) {
      state.qrAccounts = [];
    }
    return state.qrAccounts;
  }

  async function showInvoice(saleId) {
    var card = $('invoice-card');
    card.innerHTML = '<div class="drv-loading">Đang tải hoá đơn…</div>';

    try {
      await loadQRAccounts();
      var s = await D.api.sale(saleId);
      var items = s.items || [];

      var qrSelect = '';
      if (state.qrAccounts.length > 1) {
        qrSelect = '<select class="drv-select drv-mt-12" id="inv-qr-select">' +
          state.qrAccounts.map(function (q) {
            return '<option value="' + q.id + '">' + esc(q.label) + ' — ' +
              esc(q.bank_code) + ' ' + esc(q.account_no) + '</option>';
          }).join('') +
        '</select>';
      }

      var qrUrl = generateVietQR({
        id: s.id,
        total: s.total
      });

      var qrHtml = qrUrl
        ? '<div class="drv-invoice__qr">' +
            '<img src="' + esc(qrUrl) + '" alt="QR" class="drv-invoice__qr-img">' +
            '<div class="drv-muted" style="font-size:0.78rem;">Quét QR thanh toán</div>' +
          '</div>'
        : '';

      card.innerHTML =
        '<div class="drv-invoice">' +
          '<div class="drv-invoice__row"><span>Đơn</span><strong>#' + esc(s.id) + '</strong></div>' +
          '<div class="drv-invoice__row"><span>Khách</span><strong>' + esc(s.customer_name || 'Khách lẻ') + '</strong></div>' +
          '<div class="drv-invoice__row"><span>Thời gian</span><strong>' +
            esc(D.dateLabel(s.date)) + (s.sale_time ? ' ' + esc(s.sale_time) : '') + '</strong></div>' +
          '<div class="drv-invoice__row"><span>Vỏ giao / thu</span><strong>' +
            D.num(s.deliver_kegs) + ' / ' + D.num(s.return_kegs) + '</strong></div>' +
          (s.promo_free_liters > 0
            ? '<div class="drv-invoice__row"><span>Khuyến mãi</span><strong>' +
              D.num(s.promo_free_liters) + ' lít</strong></div>'
            : '') +
          (s.debt
            ? '<div class="drv-invoice__row"><span>Còn công nợ</span><strong>' +
              D.money(s.debt.remaining_amount) + '</strong></div>'
            : '') +
          '<div class="drv-invoice__items">' +
            items.map(function (it) {
              return '<div class="drv-invoice__row drv-invoice__row--item">' +
                '<span>' + esc(it.product_name || it.product_slug) +
                  (it.reward_quantity > 0 ? ' <span class="drv-badge drv-badge--reward">THƯỞNG</span>' : '') +
                '</span>' +
                '<strong>' + D.num(it.quantity) + ' × ' + D.money(it.price) + '</strong>' +
              '</div>';
            }).join('') +
          '</div>' +
          '<div class="drv-invoice__row drv-invoice__row--total">' +
            '<span>TỔNG</span><span>' + D.money(s.total) + '</span></div>' +
          qrSelect +
          qrHtml +
          '<div class="drv-btn-row drv-mt-12">' +
            '<button class="drv-btn drv-btn--ghost drv-btn--sm" id="inv-kegs" type="button">📦 Cập nhật vỏ</button>' +
            '<button class="drv-btn drv-btn--ghost drv-btn--sm" id="inv-delivery" type="button">🚚 Tạo đơn giao</button>' +
          '</div>' +
          '<div class="drv-btn-row drv-mt-8">' +
            '<button class="drv-btn drv-btn--ghost drv-btn--sm" id="inv-pay" type="button">💰 Thu tiền công nợ</button>' +
            '<button class="drv-btn drv-btn--danger drv-btn--sm" id="inv-cancel" type="button">🗑️ Huỷ đơn</button>' +
          '</div>' +
        '</div>';

      // Đổi QR
      var sel = document.getElementById('inv-qr-select');
      if (sel) {
        sel.addEventListener('change', function () {
          var id = parseInt(sel.value);
          state.currentQR = state.qrAccounts.find(function (q) { return q.id === id; }) || null;
          var img = card.querySelector('.drv-invoice__qr-img');
          if (img && state.currentQR) {
            img.src = generateVietQR({ id: s.id, total: s.total });
          }
        });
      }

      var kegBtn = document.getElementById('inv-kegs');
      if (kegBtn) kegBtn.addEventListener('click', function () { openKegModal(s); });

      var delBtn = document.getElementById('inv-delivery');
      if (delBtn) delBtn.addEventListener('click', async function () {
        try {
          await D.api.createDelivery(s.id);
          D.toast('Đã tạo đơn giao', 'success');
          setTimeout(function () { window.location.href = '/driver/giao-hang'; }, 500);
        } catch (err) { D.toast(err.message, 'error'); }
      });

      var payBtn = document.getElementById('inv-pay');
      if (payBtn) payBtn.addEventListener('click', async function () {
        if (!s.customer_id) { D.toast('Đơn khách lẻ không có công nợ', 'warning'); return; }
        var amount = await D.prompt('Thu tiền công nợ', 'Số tiền thu (đ)', '0', {
          type: 'number', inputmode: 'numeric'
        });
        if (amount === null) return;
        var val = parseFloat(amount);
        if (!val || val <= 0) { D.toast('Số tiền không hợp lệ', 'warning'); return; }
        try {
          await D.api.payDebt(s.customer_id, val, 'Thu tiền tại điểm giao');
          D.toast('Đã ghi nhận thanh toán', 'success');
          showInvoice(saleId);
        } catch (err) { D.toast(err.message, 'error'); }
      });

      var cancelBtn = document.getElementById('inv-cancel');
      if (cancelBtn) cancelBtn.addEventListener('click', async function () {
        var ok = await D.confirm(
          'Huỷ đơn #' + s.id + '? Hàng sẽ được hoàn lại kho.',
          { title: 'Huỷ đơn hàng', danger: true, okText: 'Huỷ đơn' }
        );
        if (!ok) return;
        try {
          await D.api.deleteSale(s.id);
          D.toast('Đã huỷ đơn', 'success');
          card.innerHTML = '<div class="drv-empty"><div class="drv-empty__icon">🧾</div>' +
            '<div class="drv-empty__text">Chọn đơn hàng để xem hoá đơn & QR thanh toán</div></div>';
          loadSales();
        } catch (err) { D.toast(err.message, 'error'); }
      });

    } catch (err) {
      card.innerHTML = '<div class="drv-empty"><div class="drv-empty__icon">⚠️</div>' +
        '<div class="drv-empty__text">' + esc(err.message) + '</div></div>';
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // CẬP NHẬT VỎ THEO ĐƠN
  // ═════════════════════════════════════════════════════════════════════════
  function openKegModal(sale) {
    var currentBalance = sale.customer_keg_balance || 0;
    var deliver = sale.deliver_kegs || 0;
    var returned = sale.return_kegs || 0;

    D.openModal(
      '<div class="drv-cart__row"><span class="drv-cart__label">Tồn hiện tại khách</span>' +
        '<strong>' + D.num(currentBalance) + '</strong></div>' +
      '<div class="drv-field drv-mt-12">' +
        '<label class="drv-field__label" for="kg-deliver">📦 Vỏ giao đi</label>' +
        '<input class="drv-input" id="kg-deliver" type="number" inputmode="numeric" min="0" value="' + deliver + '">' +
      '</div>' +
      '<div class="drv-field">' +
        '<label class="drv-field__label" for="kg-return">🔄 Vỏ thu về</label>' +
        '<input class="drv-input" id="kg-return" type="number" inputmode="numeric" min="0" value="' + returned + '">' +
      '</div>' +
      '<div class="drv-field">' +
        '<label class="drv-field__label" for="kg-note">Ghi chú</label>' +
        '<input class="drv-input" id="kg-note" type="text" placeholder="Không bắt buộc">' +
      '</div>' +
      '<div class="drv-btn-row">' +
        '<button class="drv-btn drv-btn--ghost" id="kg-cancel" type="button">Huỷ</button>' +
        '<button class="drv-btn drv-btn--primary" id="kg-save" type="button">Lưu</button>' +
      '</div>',
      { title: 'Cập nhật vỏ — đơn #' + sale.id }
    );

    document.getElementById('kg-cancel').addEventListener('click', D.closeModal);
    document.getElementById('kg-save').addEventListener('click', async function () {
      var d = parseInt(document.getElementById('kg-deliver').value) || 0;
      var r = parseInt(document.getElementById('kg-return').value) || 0;
      try {
        await D.api.updateSaleKegs(sale.id, d, r);
        D.closeModal();
        D.toast('Đã cập nhật vỏ', 'success');
        showInvoice(sale.id);
      } catch (err) { D.toast(err.message, 'error'); }
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // ĐỔI BIA LỖI / TẶNG UỐNG THỬ
  // ═════════════════════════════════════════════════════════════════════════
  function openReplacementModal() {
    var productOptions = '<option value="">-- Chọn sản phẩm --</option>' +
      state.products.map(function (p) {
        return '<option value="' + p.id + '">' + esc(p.name) + '</option>';
      }).join('');

    D.openModal(
      '<div class="drv-field">' +
        '<label class="drv-check" for="rp-gift">' +
          '<input type="checkbox" id="rp-gift">' +
          '<span>🎁 Tặng uống thử (khách mới)</span>' +
        '</label>' +
      '</div>' +
      '<div class="drv-field drv-hidden" id="rp-guest-row">' +
        '<label class="drv-field__label">Tên khách tặng</label>' +
        '<input class="drv-input" id="rp-guest-name" type="text" autocomplete="off">' +
      '</div>' +
      '<div class="drv-field">' +
        '<label class="drv-field__label" for="rp-customer">👤 Khách hàng</label>' +
        '<select class="drv-select" id="rp-customer">' +
          '<option value="">-- Chọn khách hàng --</option>' +
          (state.customer ? '<option value="' + state.customer.id + '" selected>' +
            esc(state.customer.name) + '</option>' : '') +
        '</select>' +
      '</div>' +
      '<div class="drv-field">' +
        '<label class="drv-field__label" for="rp-product">📦 Sản phẩm</label>' +
        '<select class="drv-select" id="rp-product">' + productOptions + '</select>' +
      '</div>' +
      '<div class="drv-field">' +
        '<label class="drv-field__label" for="rp-qty">Số lượng</label>' +
        '<input class="drv-input" id="rp-qty" type="number" inputmode="numeric" min="1" value="1">' +
      '</div>' +
      '<div class="drv-field">' +
        '<label class="drv-field__label" for="rp-reason">Lý do</label>' +
        '<select class="drv-select" id="rp-reason">' +
          '<option>Bia hư</option><option>Bia chua</option>' +
          '<option>Bia hết hạn</option><option>Khác</option>' +
        '</select>' +
      '</div>' +
      '<div class="drv-btn-row">' +
        '<button class="drv-btn drv-btn--ghost" id="rp-cancel" type="button">Huỷ</button>' +
        '<button class="drv-btn drv-btn--primary" id="rp-save" type="button">Cập nhật</button>' +
      '</div>',
      { title: '🔄 Đổi bia lỗi' }
    );

    document.getElementById('rp-cancel').addEventListener('click', D.closeModal);

    var gift = document.getElementById('rp-gift');
    gift.addEventListener('change', function () {
      document.getElementById('rp-guest-row').classList.toggle('drv-hidden', !gift.checked);
    });

    document.getElementById('rp-save').addEventListener('click', async function () {
      var isGift = gift.checked;
      var customerId = document.getElementById('rp-customer').value || '';
      var productId = document.getElementById('rp-product').value || '';
      var qty = parseInt(document.getElementById('rp-qty').value) || 0;
      var reason = document.getElementById('rp-reason').value || 'Bia hư';
      var guestName = document.getElementById('rp-guest-name').value.trim();

      if (!productId) { D.toast('Vui lòng chọn sản phẩm', 'warning'); return; }
      if (!isGift && !customerId) { D.toast('Vui lòng chọn khách hàng', 'warning'); return; }
      if (isGift && !guestName && !customerId) { D.toast('Vui lòng nhập tên khách tặng', 'warning'); return; }

      try {
        await D.api.replacement({
          customer_id: customerId ? parseInt(customerId) : null,
          product_id: parseInt(productId),
          quantity: qty,
          reason: reason,
          gift: isGift,
          giftGuestName: guestName
        });
        D.closeModal();
        D.toast('Đã cập nhật đổi bia lỗi', 'success');
        loadSales();
      } catch (err) { D.toast(err.message, 'error'); }
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // LỊCH SỬ ĐƠN
  // ═════════════════════════════════════════════════════════════════════════
  async function loadSales() {
    var el = $('sales-list');
    try {
      var params = { limit: 20, page: state.page };
      if (state.month) params.month = state.month;
      var res = await D.api.sales(params);
      var list = res.sales || [];
      state.totalPages = res.totalPages || 1;

      if (!list.length) {
        el.innerHTML = '<div class="drv-empty"><div class="drv-empty__icon">📋</div>' +
          '<div class="drv-empty__text">Chưa có đơn hàng nào</div></div>';
        renderPagination();
        return;
      }

      el.innerHTML = list.map(function (s) {
        var badge = '';
        if (s.promo_free_liters > 0) {
          badge = '<span class="drv-badge drv-badge--reward">KM ' + D.num(s.promo_free_liters) + 'L</span>';
        }
        var payBadge = s.payment_status === 'paid'
          ? '<span class="drv-badge drv-badge--delivered">Đã trả</span>'
          : (s.payment_status === 'partial'
              ? '<span class="drv-badge drv-badge--pending">Trả 1 phần</span>'
              : '<span class="drv-badge drv-badge--failed">Công nợ</span>');

        var dir = D.mapDirectionsLink({
          lat: s.customer_lat, lng: s.customer_lng, address: s.customer_address
        });
        var mapBtn = dir
          ? '<a href="' + esc(dir) + '" target="_blank" rel="noopener" ' +
            'class="drv-btn drv-btn--ghost drv-btn--sm" style="width:auto;">🗺️</a>'
          : '';

        return '<div class="drv-item" data-sale-id="' + s.id + '">' +
          '<div class="drv-item__body">' +
            '<div class="drv-item__title">#' + s.id + ' · ' + esc(s.customer_name) + '</div>' +
            '<div class="drv-item__meta">' +
              D.dateLabel(s.date) + (s.sale_time ? ' ' + s.sale_time : '') +
              ' · ' + D.num(s.items_qty) + ' vỏ' +
              (s.customer_address ? ' · ' + esc(s.customer_address) : '') +
            '</div>' +
            '<div class="drv-mt-8" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">' +
              badge + payBadge + mapBtn +
            '</div>' +
          '</div>' +
          '<div class="drv-item__right">' +
            '<div class="drv-item__amount">' + D.money(s.total) + '</div>' +
          '</div>' +
        '</div>';
      }).join('');

      renderPagination();
    } catch (err) {
      el.innerHTML = '<div class="drv-empty"><div class="drv-empty__text">' + esc(err.message) + '</div></div>';
    }
  }

  function renderPagination() {
    var box = $('sales-pagination');
    if (!box) return;

    if (state.totalPages <= 1) {
      box.innerHTML = '';
      return;
    }

    box.innerHTML =
      '<button class="drv-btn drv-btn--ghost drv-btn--sm" id="pg-prev" type="button"' +
        (state.page <= 1 ? ' disabled' : '') + '← Trước</button>' +
      '<button class="drv-btn drv-btn--ghost drv-btn--sm" id="pg-next" type="button"' +
        (state.page >= state.totalPages ? ' disabled' : '') + 'Sau →</button>';

    var prev = document.getElementById('pg-prev');
    var next = document.getElementById('pg-next');
    if (prev) prev.addEventListener('click', function () {
      if (state.page > 1) { state.page--; loadSales(); }
    });
    if (next) next.addEventListener('click', function () {
      if (state.page < state.totalPages) { state.page++; loadSales(); }
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // CHI TIẾT ĐƠN (modal)
  // ═════════════════════════════════════════════════════════════════════════
  async function openSaleDetail(id) {
    try {
      var s = await D.api.sale(id);
      var items = s.items || [];

      var dir = D.mapDirectionsLink({
        lat: s.customer_lat, lng: s.customer_lng, address: s.customer_address
      });
      var tel = D.telLink(s.customer_phone);

      D.openModal(
        '<div class="drv-cart__row"><span class="drv-cart__label">Khách</span>' +
          '<strong>' + esc(s.customer_name) + '</strong></div>' +
        '<div class="drv-cart__row"><span class="drv-cart__label">Thời gian</span>' +
          '<strong>' + esc(D.dateLabel(s.date)) + (s.sale_time ? ' ' + esc(s.sale_time) : '') + '</strong></div>' +
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
          (tel ? '<a href="' + esc(tel) + '" class="drv-btn drv-btn--ghost drv-btn--sm">📞 Gọi</a>' : '') +
          (dir ? '<a href="' + esc(dir) + '" target="_blank" rel="noopener" ' +
            'class="drv-btn drv-btn--primary drv-btn--sm">🗺️ Chỉ đường</a>' : '') +
        '</div>' +
        '<div class="drv-btn-row drv-mt-8">' +
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

  // ═════════════════════════════════════════════════════════════════════════
  // INIT
  // ═════════════════════════════════════════════════════════════════════════
  function buildMonthChips() {
    var box = $('month-chips');
    if (!box) return;

    var now = new Date();
    var html = '<button class="drv-chip' + (state.month ? '' : ' is-active') +
      '" data-month="">Tất cả</button>';
    for (var i = 0; i < 6; i++) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      html += '<button class="drv-chip' + (state.month === key ? ' is-active' : '') +
        '" data-month="' + key + '">Tháng ' + (d.getMonth() + 1) + '/' + d.getFullYear() + '</button>';
    }
    box.innerHTML = html;

    box.querySelectorAll('[data-month]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        state.month = chip.getAttribute('data-month');
        state.page = 1;
        buildMonthChips();
        loadSales();
      });
    });
  }

  async function init() {
    await D.requireAuth();
    D.setupNav('sale');
    D.setupHeader();

    buildMonthChips();

    try {
      var res = await D.api.products();
      state.products = res.products || [];
      renderProducts();
    } catch (err) {
      $('product-list').innerHTML = '<div class="drv-empty"><div class="drv-empty__text">' +
        esc(err.message) + '</div></div>';
    }

    loadSales();

    // Khách được chọn từ trang "Khách hàng"
    try {
      var picked = sessionStorage.getItem('drv_pick_customer');
      if (picked) {
        sessionStorage.removeItem('drv_pick_customer');
        await selectCustomer(parseInt(picked));
      }
    } catch (_) {}

    // ── Events ─────────────────────────────────────────────────────────────
    $('btn-change-cust').addEventListener('click', openCustomerPicker);
    $('btn-new-cust').addEventListener('click', createCustomer);
    $('btn-save-order').addEventListener('click', saveOrder);
    $('btn-replacement').addEventListener('click', openReplacementModal);

    $('btn-call-cust').addEventListener('click', function () {
      var tel = D.telLink(state.customer && state.customer.phone);
      if (!tel) { D.toast('Khách chưa có số điện thoại', 'warning'); return; }
      window.location.href = tel;
    });

    $('btn-directions-cust').addEventListener('click', function () {
      if (!D.openDirections(state.customer)) {
        D.toast('Khách chưa có địa chỉ hoặc tọa độ để chỉ đường', 'warning');
      }
    });

    $('btn-cancel-order').addEventListener('click', function () {
      state.cart = [];
      renderCart();
      updatePromoPreview();
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

    // Sản phẩm: tăng/giảm số lượng, sửa giá
    $('product-list').addEventListener('click', function (e) {
      var inc = e.target.closest('[data-prod-inc]');
      var dec = e.target.closest('[data-prod-dec]');
      if (inc) {
        addToCart(parseInt(inc.getAttribute('data-prod-inc')));
        return;
      }
      if (dec) {
        var id = parseInt(dec.getAttribute('data-prod-dec'));
        setCartQty(id, cartQty(id) - 1);
        renderProducts($('prod-search').value);
      }
    });

    $('product-list').addEventListener('input', function (e) {
      var qtyEl = e.target.closest('[data-qty-id]');
      if (qtyEl) {
        setCartQty(parseInt(qtyEl.getAttribute('data-qty-id')), qtyEl.value);
        return;
      }
      var priceEl = e.target.closest('[data-price-id]');
      if (priceEl) {
        var pid = parseInt(priceEl.getAttribute('data-price-id'));
        var p = state.products.find(function (x) { return x.id === pid; });
        if (p && (Number(p.sell_price) || 0) !== (parseInt(priceEl.value) || 0)) {
          priceEl.classList.add('is-edited');
        } else {
          priceEl.classList.remove('is-edited');
        }
        setCartPrice(pid, priceEl.value);
      }
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
      updatePromoPreview();
      renderProducts($('prod-search').value);
    });

    $('sales-list').addEventListener('click', function (e) {
      if (e.target.closest('a[href^="https://www.google.com/maps"]')) return;
      var item = e.target.closest('[data-sale-id]');
      if (!item) return;
      openSaleDetail(parseInt(item.getAttribute('data-sale-id')));
    });
  }

  init();
})();
