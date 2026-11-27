/**
 * delivery-recon.js — Trang "Quản lý phiếu giao hàng" (đối soát phiếu giao).
 *
 * ⚠️ FILE NÀY TỪNG BỊ THIẾU (404) → trang không load được dữ liệu.
 * Được viết lại ngày 2026-11-25 dựa trên API sẵn có:
 *   GET  /api/admin/deliveries/reconciliation?reconciled=0|1&limit=&offset=
 *   GET  /api/admin/deliveries/:id
 *   PUT  /api/admin/deliveries/:id/confirm
 *   POST /api/admin/deliveries/:id/reconcile
 */
(function () {
  'use strict';

  var API = '/api/admin/deliveries';
  var state = {
    rows: [],
    offset: 0,
    limit: 50,
    total: 0,
    filterReconciled: '1',
    status: '',
    search: ''
  };

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function num(n) {
    var v = Number(n || 0);
    return v.toLocaleString('vi-VN');
  }

  function fmtTime(s) {
    if (!s) return '—';
    try {
      var d = new Date(String(s).replace(' ', 'T'));
      if (isNaN(d.getTime())) return String(s);
      return d.toLocaleString('vi-VN', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) {
      return String(s);
    }
  }

  var STATUS_LABEL = {
    PENDING: 'Chờ giao',
    IN_PROGRESS: 'Đang giao',
    DELIVERED: 'Đã giao',
    DISCREPANCY: 'Sai lệch',
    FAILED: 'Thất bại'
  };

  var STATUS_BADGE = {
    PENDING: 'none',
    IN_PROGRESS: 'warn',
    DELIVERED: 'ok',
    DISCREPANCY: 'err',
    FAILED: 'err'
  };

  function statusBadge(st) {
    var key = st || 'none';
    var cls = STATUS_BADGE[key] || 'none';
    var text = STATUS_LABEL[key] || key;
    return '<span class="dl-badge dl-badge--' + esc(cls) + '">' + esc(text) + '</span>';
  }

  function lockBadge(r) {
    if (r.reconciled_at) {
      return '<span class="dl-badge dl-badge--lock" title="' + esc(fmtTime(r.reconciled_at)) +
        ' by ' + esc(r.reconciled_by || '') + '">🔒 Đã đối soát</span>';
    }
    return '<span class="dl-badge dl-badge--none">📋 Chưa đối soát</span>';
  }

  function showError(msg) {
    var body = $('dlBody');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="8" class="dl-empty">' + esc(msg) + '</td></tr>';
  }

  function renderStats() {
    var box = $('dlStats');
    if (!box) return;
    var total = state.total;
    var locked = 0;
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].reconciled_at) locked++;
    }
    box.innerHTML =
      '<div class="dl-stat"><div class="dl-stat-label">Tổng phiếu</div>' +
      '<div class="dl-stat-value">' + num(total) + '</div></div>' +
      '<div class="dl-stat"><div class="dl-stat-label">Đang xem</div>' +
      '<div class="dl-stat-value">' + num(state.rows.length) + '</div></div>' +
      '<div class="dl-stat"><div class="dl-stat-label">Đã khoá</div>' +
      '<div class="dl-stat-value">' + num(locked) + '</div></div>';
  }

  function renderRows() {
    var body = $('dlBody');
    if (!body) return;

    if (!state.rows.length) {
      body.innerHTML = '<tr><td colspan="8" class="dl-empty">Không có phiếu giao nào</td></tr>';
      return;
    }

    var html = '';
    for (var i = 0; i < state.rows.length; i++) {
      var r = state.rows[i];
      html += '<tr>' +
        '<td>#' + num(r.id) + (r.sale_id ? '<br><small>ĐH ' + num(r.sale_id) + '</small>' : '') + '</td>' +
        '<td>' + esc(r.customer_name || '—') + '</td>' +
        '<td>' + esc(r.driver_username || '—') + '</td>' +
        '<td>' + statusBadge(r.status) + '</td>' +
        '<td class="dl-num">' + num(r.delivered_liters) + '</td>' +
        '<td class="dl-num">' + num(r.collected_kegs) +
        (r.expected_kegs !== null && r.expected_kegs !== undefined
          ? ' / ' + num(r.expected_kegs) : '') + '</td>' +
        '<td>' + lockBadge(r) + '</td>' +
        '<td><button class="dl-btn dl-btn--ghost" style="height:32px;padding:0 10px;font-size:12px" ' +
        'data-edit="' + esc(r.id) + '">Sửa</button></td>' +
        '</tr>';
    }
    body.innerHTML = html;
  }

  function buildQuery() {
    var q = '/api/admin/deliveries/reconciliation' +
      '?reconciled=' + encodeURIComponent(state.filterReconciled) +
      '&limit=' + encodeURIComponent(state.limit) +
      '&offset=' + encodeURIComponent(state.offset);
    if (state.status) q += '&status=' + encodeURIComponent(state.status);
    if (state.search) q += '&search=' + encodeURIComponent(state.search);
    return q;
  }

  function load() {
    var body = $('dlBody');
    if (body) {
      body.innerHTML = '<tr><td colspan="8" class="dl-empty">Đang tải…</td></tr>';
    }
    fetch(buildQuery(), { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        state.rows = data.deliveries || [];
        state.total = data.total || 0;
        renderStats();
        renderRows();
      })
      .catch(function (err) {
        showError('Lỗi tải dữ liệu: ' + (err && err.message ? err.message : err));
      });
  }

  // ── Modal sửa số liệu ────────────────────────────────────────────────────
  function openModal(id) {
    var modal = $('dlModal');
    var body = $('dlModalBody');
    var title = $('dlModalTitle');
    if (!modal || !body) return;

    body.innerHTML = '<div class="dl-empty">Đang tải…</div>';
    modal.hidden = false;
    if (title) title.textContent = 'Sửa số liệu phiếu #' + id;

    fetch(API + '/' + id, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var d = data.delivery || {};
        var items = data.items || [];
        var rowsHtml = '';
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          rowsHtml += '<tr>' +
            '<td>' + esc(it.product_name || ('#' + it.product_id)) + '</td>' +
            '<td class="dl-num"><input class="dl-input" style="width:86px;text-align:right" type="number" step="0.01" ' +
            'data-item-litres="' + esc(it.id) + '" value="' + esc(it.delivered_liters || 0) + '"></td>' +
            '<td class="dl-num"><input class="dl-input" style="width:86px;text-align:right" type="number" step="0.01" ' +
            'data-item-kegs="' + esc(it.id) + '" value="' + esc(it.collected_kegs || 0) + '"></td>' +
            '</tr>';
        }

        body.innerHTML =
          '<table class="dl-table"><thead><tr>' +
          '<th>Sản phẩm</th><th class="dl-num">Lít giao</th><th class="dl-num">Vỏ thu</th>' +
          '</tr></thead><tbody>' +
          (rowsHtml || '<tr><td colspan="3" class="dl-empty">Phiếu không có sản phẩm</td></tr>') +
          '</tbody></table>' +
          '<div class="dl-field" style="margin-top:12px">' +
          '<label class="dl-label">Tổng vỏ thu</label>' +
          '<input class="dl-input" style="width:120px" type="number" id="dlKegs" ' +
          'value="' + esc(d.collected_kegs || 0) + '">' +
          '</div>' +
          '<div class="dl-field">' +
          '<label class="dl-label">Ghi chú</label>' +
          '<textarea class="dl-input" id="dlNote" rows="2" ' +
          'placeholder="Lý do sửa số liệu (ghi vào nhật ký)"></textarea>' +
          '</div>';
      })
      .catch(function (err) {
        body.innerHTML = '<div class="dl-empty">Lỗi: ' +
          esc(err && err.message ? err.message : err) + '</div>';
      });
  }

  function closeModal() {
    var modal = $('dlModal');
    if (modal) modal.hidden = true;
  }

  function saveModal(id) {
    var body = $('dlModalBody');
    if (!body) return;

    var items = [];
    var litres = body.querySelectorAll('[data-item-litres]');
    var kegs = body.querySelectorAll('[data-item-kegs]');
    for (var i = 0; i < litres.length; i++) {
      items.push({
        itemId: Number(litres[i].getAttribute('data-item-litres')),
        deliveredLiters: Number(litres[i].value || 0),
        collectedKegs: Number(kegs[i] ? kegs[i].value || 0 : 0)
      });
    }

    var payload = {
      items: items,
      collectedKegs: Number(($('dlKegs') || {}).value || 0),
      note: (($('dlNote') || {}).value || '').trim()
    };

    fetch(API + '/' + id + '/confirm', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function () {
        closeModal();
        load();
        if (window.showToast) window.showToast('Đã lưu số liệu phiếu #' + id, 'success');
      })
      .catch(function (err) {
        var msg = 'Lỗi lưu: ' + (err && err.message ? err.message : err);
        if (window.showToast) window.showToast(msg, 'error');
        else showError(msg);
      });
  }

  // ── Gắn sự kiện ─────────────────────────────────────────────────────────
  function init() {
    var filter = $('dlFilter');
    var status = $('dlStatus');
    var search = $('dlSearch');
    var refresh = $('dlRefresh');
    var save = $('dlSave');
    var cancel = $('dlCancel');
    var close = $('dlModalClose');

    if (filter) {
      filter.value = state.filterReconciled;
      filter.addEventListener('change', function () {
        state.filterReconciled = filter.value;
        state.offset = 0;
        load();
      });
    }

    if (status) {
      status.addEventListener('change', function () {
        state.status = status.value;
        state.offset = 0;
        load();
      });
    }

    var timer = null;
    if (search) {
      search.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          state.search = search.value.trim();
          state.offset = 0;
          load();
        }, 300);
      });
    }

    if (refresh) {
      refresh.addEventListener('click', function () { load(); });
    }

    var body = $('dlBody');
    if (body) {
      body.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-edit]') : null;
        if (btn) openModal(btn.getAttribute('data-edit'));
      });
    }

    if (save) {
      save.addEventListener('click', function () {
        var modal = $('dlModal');
        var title = $('dlModalTitle');
        var id = title ? (title.textContent.match(/#(\d+)/) || [])[1] : null;
        if (id) saveModal(id);
      });
    }
    if (cancel) cancel.addEventListener('click', closeModal);
    if (close) close.addEventListener('click', closeModal);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeModal();
    });

    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
