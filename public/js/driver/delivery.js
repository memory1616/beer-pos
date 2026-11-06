/**
 * Driver Portal — Module GIAO HÀNG
 * ─────────────────────────────────────────────────────────────────────────────
 * Các trạng thái: Chờ giao → Đang giao → Đã giao / Giao thất bại / Chờ xử lý sai lệch
 */
(function () {
  'use strict';

  var D = window.Drv;

  var STATUS_CLASS = {
    PENDING: 'drv-badge--pending',
    IN_PROGRESS: 'drv-badge--progress',
    DELIVERED: 'drv-badge--delivered',
    FAILED: 'drv-badge--failed',
    DISCREPANCY: 'drv-badge--discrep'
  };

  var state = { filter: 'pending', rows: [], labels: {} };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  function $(id) { return document.getElementById(id); }

  function label(key) {
    return state.labels[key] || key;
  }

  // ── Load danh sách ──────────────────────────────────────────────────────
  async function load() {
    var el = $('delivery-list');
    el.innerHTML = '<div class="drv-loading">Đang tải…</div>';

    try {
      if (state.filter === 'history') {
        var h = await D.api.deliveryHistory({ limit: 100 });
        state.labels = h.statusLabels || state.labels;
        renderHistory(h.deliveries || []);
      } else {
        var res = await D.api.deliveries();
        state.labels = res.statusLabels || state.labels;
        var rows = res.deliveries || [];
        state.rows = rows;

        var pending = rows.filter(function (r) {
          return r.delivery_status !== 'DELIVERED';
        });

        D.setNavBadge(pending.length);

        if (state.filter === 'pending') {
          renderDeliveries(pending);
        } else {
          renderDeliveries(rows);
        }
      }
    } catch (err) {
      el.innerHTML = '<div class="drv-empty"><div class="drv-empty__icon">⚠️</div>' +
        '<div class="drv-empty__text">' + esc(err.message) + '</div></div>';
    }
  }

  function renderDeliveries(rows) {
    var el = $('delivery-list');
    if (!rows.length) {
      el.innerHTML = '<div class="drv-empty"><div class="drv-empty__icon">✅</div>' +
        '<div class="drv-empty__text">Không có đơn nào cần giao</div></div>';
      return;
    }

    el.innerHTML = rows.map(function (r) {
      var st = r.delivery_status || 'PENDING';
      var badge = '<span class="drv-badge ' + (STATUS_CLASS[st] || 'drv-badge--pending') + '">' +
        esc(label(st)) + '</span>';

      var promo = '';
      if (r.promo_free_liters > 0) {
        promo = '<span class="drv-badge drv-badge--reward">KM ' + D.num(r.promo_free_liters) + 'L</span>';
      }

      var kegInfo = 'giao ' + D.num(r.deliver_kegs || 0) + ' vỏ';
      if (r.collected_kegs > 0) kegInfo += ' · thu ' + D.num(r.collected_kegs);

      return '<div class="drv-card drv-card--tap" data-sale-id="' + r.sale_id + '" ' +
                 'data-delivery-id="' + (r.delivery_id || '') + '">' +
        '<div style="display:flex;align-items:flex-start;gap:10px;">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-weight:800;font-size:1.02rem;">' + esc(r.customer_name) + '</div>' +
            '<div class="drv-muted" style="font-size:0.85rem;margin-top:2px;">' +
              (r.customer_phone
                ? '<a href="tel:' + esc(r.customer_phone) + '" style="color:var(--accent);">' +
                  esc(r.customer_phone) + '</a>'
                : '—') +
            '</div>' +
            (r.customer_address
              ? '<div class="drv-muted" style="font-size:0.83rem;margin-top:2px;">📍 ' +
                esc(r.customer_address) + '</div>'
              : '') +
            '<div class="drv-muted" style="font-size:0.83rem;margin-top:4px;">' +
              D.num(r.expected_liters || 0) + ' lít · ' + kegInfo +
            '</div>' +
            '<div class="drv-mt-8" style="display:flex;gap:6px;flex-wrap:wrap;">' + badge + promo + '</div>' +
          '</div>' +
          '<div class="drv-item__right">' +
            '<div class="drv-item__amount">' + D.money(r.total) + '</div>' +
            '<div class="drv-muted" style="font-size:0.75rem;margin-top:3px;">#' + r.sale_id + '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderHistory(rows) {
    var el = $('delivery-list');
    if (!rows.length) {
      el.innerHTML = '<div class="drv-empty"><div class="drv-empty__icon">📋</div>' +
        '<div class="drv-empty__text">Chưa có lịch sử giao hàng</div></div>';
      return;
    }
    el.innerHTML = rows.map(function (r) {
      var st = r.status || 'PENDING';
      return '<div class="drv-item">' +
        '<div class="drv-item__body">' +
          '<div class="drv-item__title">' + esc(r.customer_name || '—') + '</div>' +
          '<div class="drv-item__meta">' + D.dateLabel(r.scheduled_date) +
            ' · giao ' + D.num(r.delivered_liters || 0) + ' lít' +
            (r.missing_liters > 0 ? ' · thiếu ' + D.num(r.missing_liters) : '') +
            (r.excess_liters > 0 ? ' · thừa ' + D.num(r.excess_liters) : '') +
            (r.damaged_liters > 0 ? ' · hỏng ' + D.num(r.damaged_liters) : '') +
          '</div>' +
          '<div class="drv-mt-8">' +
            '<span class="drv-badge ' + (STATUS_CLASS[st] || 'drv-badge--pending') + '">' +
              esc(label(st)) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="drv-item__right">' +
          '<div class="drv-item__amount">' + D.money(r.sale_total || 0) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // ── Chi tiết đơn giao ──────────────────────────────────────────────────
  async function openDelivery(saleId, deliveryId) {
    var record;

    if (deliveryId) {
      try {
        record = await D.api.delivery(deliveryId);
      } catch (err) {
        D.toast(err.message, 'error');
        return;
      }
    } else {
      // Chưa có delivery record → tạo mới
      try {
        var created = await D.api.createDelivery(saleId);
        record = await D.api.delivery(created.delivery.id);
      } catch (err) {
        D.toast(err.message, 'error');
        return;
      }
    }

    state.labels = record.statusLabels || state.labels;
    var items = record.items || [];
    var events = record.events || [];

    var html =
      '<div class="drv-cart__row"><span class="drv-cart__label">Khách</span>' +
        '<strong>' + esc(record.customer_name || '—') + '</strong></div>' +
      '<div class="drv-cart__row"><span class="drv-cart__label">SĐT</span>' +
        '<strong>' + (record.customer_phone
          ? '<a href="tel:' + esc(record.customer_phone) + '" style="color:var(--accent);">' +
            esc(record.customer_phone) + '</a>'
          : '—') + '</strong></div>' +
      (record.customer_address
        ? '<div class="drv-cart__row"><span class="drv-cart__label">Địa chỉ</span>' +
          '<strong style="text-align:right;max-width:60%;">' + esc(record.customer_address) + '</strong></div>'
        : '') +
      '<div class="drv-cart__row"><span class="drv-cart__label">Tổng đơn</span>' +
        '<strong>' + D.money(record.sale_total || 0) + '</strong></div>' +

      '<div class="drv-section__title drv-mt-16">Số lượng giao</div>' +
      (items.length
        ? items.map(function (it) {
            return '<div class="drv-dl-item">' +
              '<div style="flex:1;min-width:0;">' +
                '<div class="drv-dl-item__name">' + esc(it.product_name || '—') +
                  (it.is_reward ? ' <span class="drv-badge drv-badge--reward">THƯỞNG</span>' : '') +
                '</div>' +
                '<div class="drv-dl-item__expected">Cần giao: ' + D.num(it.expected_quantity) + '</div>' +
              '</div>' +
              '<input class="drv-input drv-dl-item__qty" type="number" inputmode="numeric" min="0" ' +
                'data-item-id="' + it.id + '" value="' + (it.delivered_quantity > 0 ? it.delivered_quantity : it.expected_quantity) + '">' +
            '</div>';
          }).join('')
        : '<div class="drv-muted">Không có chi tiết sản phẩm</div>') +

      '<div class="drv-field drv-mt-16">' +
        '<label class="drv-field__label" for="dl-kegs">Số vỏ đã thu hồi</label>' +
        '<input class="drv-input" id="dl-kegs" type="number" inputmode="numeric" min="0" value="' +
          (record.collected_kegs || 0) + '">' +
      '</div>' +
      '<div class="drv-field">' +
        '<label class="drv-field__label" for="dl-note">Ghi chú giao hàng</label>' +
        '<input class="drv-input" id="dl-note" type="text" placeholder="Ghi chú (không bắt buộc)" value="' +
          esc(record.note || '') + '">' +
      '</div>' +

      '<div class="drv-btn-row drv-mt-12">' +
        '<button class="drv-btn drv-btn--ghost" id="dl-start" type="button">Bắt đầu giao</button>' +
        '<button class="drv-btn drv-btn--success" id="dl-confirm" type="button">Xác nhận giao</button>' +
      '</div>' +
      '<div class="drv-btn-row drv-mt-8">' +
        '<button class="drv-btn drv-btn--warning" id="dl-fail" type="button">Giao thất bại</button>' +
        '<button class="drv-btn drv-btn--danger" id="dl-disc" type="button">Có sai lệch</button>' +
      '</div>' +
      '<button class="drv-btn drv-btn--ghost drv-mt-8" id="dl-close" type="button">Đóng</button>' +

      (events.length
        ? '<div class="drv-section__title drv-mt-16">Lịch sử</div>' +
          events.slice(0, 8).map(function (e) {
            return '<div class="drv-cart__row" style="font-size:0.8rem;">' +
              '<span>' + esc(e.event_type) +
                (e.to_status ? ' → ' + esc(label(e.to_status)) : '') + '</span>' +
              '<span class="drv-muted">' + esc(e.actor_username || '') + '</span>' +
            '</div>';
          }).join('')
        : '');

    D.openModal(html, { title: 'Giao đơn #' + (record.sale_id || '') });

    document.getElementById('dl-close').addEventListener('click', D.closeModal);

    document.getElementById('dl-start').addEventListener('click', async function () {
      try {
        await D.api.setDeliveryStatus(record.id, 'IN_PROGRESS');
        D.closeModal();
        D.toast('Đã bắt đầu giao', 'success');
        load();
      } catch (err) { D.toast(err.message, 'error'); }
    });

    document.getElementById('dl-confirm').addEventListener('click', async function () {
      var payloadItems = [];
      document.querySelectorAll('[data-item-id]').forEach(function (el) {
        payloadItems.push({
          itemId: parseInt(el.getAttribute('data-item-id')),
          deliveredQuantity: parseFloat(el.value) || 0
        });
      });

      try {
        var res = await D.api.confirmDelivery(record.id, {
          items: payloadItems,
          collectedKegs: parseInt($('dl-kegs').value) || 0,
          note: $('dl-note').value.trim()
        });
        D.closeModal();
        var s = res.summary || {};
        if (s.totalMissing > 0 || s.totalExcess > 0 || s.totalDamaged > 0) {
          D.toast('Đã ghi nhận — có sai lệch, chờ xử lý', 'warning');
        } else {
          D.toast('Giao hàng thành công', 'success');
        }
        load();
      } catch (err) { D.toast(err.message, 'error'); }
    });

    document.getElementById('dl-fail').addEventListener('click', async function () {
      var reason = await D.prompt('Giao thất bại', 'Lý do thất bại', '', { type: 'text' });
      if (reason === null) return;
      try {
        await D.api.setDeliveryStatus(record.id, 'FAILED', { failureReason: reason, note: reason });
        D.closeModal();
        D.toast('Đã ghi nhận giao thất bại', 'warning');
        load();
      } catch (err) { D.toast(err.message, 'error'); }
    });

    document.getElementById('dl-disc').addEventListener('click', async function () {
      D.openModal(
        '<div class="drv-field"><label class="drv-field__label">Thiếu (lít)</label>' +
          '<input class="drv-input" id="dc-missing" type="number" inputmode="numeric" min="0" value="0"></div>' +
        '<div class="drv-field"><label class="drv-field__label">Thừa (lít)</label>' +
          '<input class="drv-input" id="dc-excess" type="number" inputmode="numeric" min="0" value="0"></div>' +
        '<div class="drv-field"><label class="drv-field__label">Hư hỏng (lít)</label>' +
          '<input class="drv-input" id="dc-damaged" type="number" inputmode="numeric" min="0" value="0"></div>' +
        '<div class="drv-field"><label class="drv-field__label">Ghi chú</label>' +
          '<input class="drv-input" id="dc-note" type="text" placeholder="Mô tả sai lệch"></div>' +
        '<div class="drv-btn-row">' +
          '<button class="drv-btn drv-btn--ghost" id="dc-cancel" type="button">Huỷ</button>' +
          '<button class="drv-btn drv-btn--danger" id="dc-save" type="button">Lưu sai lệch</button>' +
        '</div>',
        { title: 'Ghi nhận sai lệch' }
      );

      document.getElementById('dc-cancel').addEventListener('click', D.closeModal);
      document.getElementById('dc-save').addEventListener('click', async function () {
        try {
          await D.api.recordDiscrepancy(record.id, {
            missingLiters: parseFloat($('dc-missing').value) || 0,
            excessLiters: parseFloat($('dc-excess').value) || 0,
            damagedLiters: parseFloat($('dc-damaged').value) || 0,
            note: $('dc-note').value.trim()
          });
          D.closeModal();
          D.toast('Đã ghi nhận sai lệch', 'warning');
          load();
        } catch (err) { D.toast(err.message, 'error'); }
      });
    });
  }

  // ── Init ────────────────────────────────────────────────────────────────
  async function init() {
    await D.requireAuth();
    D.setupNav('delivery');
    D.setupHeader();
    load();

    document.querySelectorAll('[data-filter]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        document.querySelectorAll('[data-filter]').forEach(function (c) {
          c.classList.remove('is-active');
        });
        chip.classList.add('is-active');
        state.filter = chip.getAttribute('data-filter');
        load();
      });
    });

    $('delivery-list').addEventListener('click', function (e) {
      var card = e.target.closest('[data-sale-id]');
      if (!card) return;
      var saleId = parseInt(card.getAttribute('data-sale-id'));
      var did = card.getAttribute('data-delivery-id');
      openDelivery(saleId, did ? parseInt(did) : null);
    });
  }

  init();
})();
