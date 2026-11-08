/**
 * Driver Portal — Module PHIẾU THU VỎ
 * ─────────────────────────────────────────────────────────────────────────────
 * Dùng khi tài xế thu vỏ rỗng ngoài chuyến giao (không giao hàng).
 * Phiếu là căn cứ BÁO CÁO với khách hàng → có thể IN hoặc CHIA SẺ.
 *
 * Quy tắc nghiệp vụ (server xử lý, client chỉ hiển thị):
 *   • Bắt buộc chọn KHÁCH HÀNG.
 *   • Trừ `customers.keg_balance` (vỏ khách đang giữ).
 *   • Cộng `keg_stats.empty_collected` (vỏ rỗng về kho chờ nạp).
 */
(function () {
  'use strict';

  var D = window.Drv;

  var state = {
    customers: [],
    q: '',
    receipts: [],
    lastReceipt: null,
  };

  /* ═══════════════════════════════════════════════════════════════════
   * Helpers
   * ═══════════════════════════════════════════════════════════════════ */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  function $(id) { return document.getElementById(id); }

  function timeLabel(iso) {
    if (!iso) return '—';
    var d = new Date(String(iso).replace(' ', 'T'));
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('vi-VN', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Form tạo phiếu
   * ═══════════════════════════════════════════════════════════════════ */
  function openCreateForm(preselectId) {
    var body = D.openSheet(
      '<div class="ds-field">' +
        '<label class="ds-label" for="kr-search">Khách hàng *</label>' +
        '<input class="ds-input" id="kr-search" type="search" inputmode="search" ' +
          'placeholder="🔍 Tìm khách hàng…" autocomplete="off">' +
        '<div class="ds-list ds-mt-2" id="kr-cust-list" ' +
          'style="max-height:34vh;overflow-y:auto;"></div>' +
      '</div>' +

      '<div class="ds-field">' +
        '<label class="ds-label" for="kr-kegs">Số vỏ thu về *</label>' +
        '<input class="ds-input" id="kr-kegs" type="number" min="1" step="1" value="1">' +
        '<div class="ds-muted ds-mt-2" id="kr-hint" style="font-size:.8rem;">' +
          'Chọn khách hàng để xem số vỏ họ đang giữ.' +
        '</div>' +
      '</div>' +

      '<div class="ds-field">' +
        '<label class="ds-label" for="kr-note">Ghi chú</label>' +
        '<input class="ds-input" id="kr-note" type="text" ' +
          'placeholder="Lý do thu vỏ (không bắt buộc)">' +
      '</div>' +

      '<div class="ds-btn-row ds-mt-4">' +
        '<button class="ds-btn ds-btn--ghost" id="kr-cancel" type="button">Huỷ</button>' +
        '<button class="ds-btn ds-btn--primary" id="kr-save" type="button" disabled>' +
          '📄 Tạo phiếu thu vỏ' +
        '</button>' +
      '</div>',
      { title: '📄 Phiếu thu vỏ' }
    );
    if (!body) return;

    var selected = null;

    /* ── Danh sách khách (tìm kiếm) ── */
    var listEl = $('kr-cust-list');
    var searchEl = $('kr-search');
    var kegsEl = $('kr-kegs');
    var hintEl = $('kr-hint');
    var saveBtn = $('kr-save');

    function renderCustomers() {
      var q = searchEl.value.trim().toLowerCase();
      var rows = state.customers.filter(function (c) {
        if (!q) return true;
        return (c.name || '').toLowerCase().indexOf(q) >= 0 ||
               (c.phone || '').indexOf(q) >= 0;
      });

      if (!rows.length) {
        listEl.innerHTML = '<div class="ds-empty ds-mb-3">' +
          '<span class="ds-empty__icon">🔍</span>' +
          '<span class="ds-empty__text">Không tìm thấy khách</span></div>';
        return;
      }

      listEl.innerHTML = rows.map(function (c) {
        var active = selected && selected.id === c.id ? ' is-active' : '';
        return '<button type="button" class="ds-row ds-card--tap' + active + '" ' +
          'data-cust-id="' + c.id + '" style="width:100%;text-align:left;">' +
          '<span class="ds-row__body">' +
            '<span class="ds-row__title">' + esc(c.name) + '</span>' +
            '<span class="ds-row__meta">' + esc(c.phone || '—') + '</span>' +
          '</span>' +
          '<span class="ds-row__tail">' +
            '<span class="ds-badge ds-badge--info">Vỏ: ' + D.num(c.keg_balance || 0) + '</span>' +
          '</span>' +
        '</button>';
      }).join('');
    }

    function selectCustomer(c) {
      selected = c;
      var bal = c.keg_balance || 0;
      hintEl.textContent = bal > 0
        ? esc(c.name) + ' đang giữ ' + D.num(bal) + ' vỏ.'
        : esc(c.name) + ' hiện KHÔNG còn vỏ nào — không thể thu.';
      hintEl.style.color = bal > 0 ? 'var(--ds-text-2)' : 'var(--ds-danger)';
      saveBtn.disabled = bal <= 0;
      if (bal > 0 && parseInt(kegsEl.value, 10) > bal) kegsEl.value = bal;
      renderCustomers();
    }

    listEl.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-cust-id]');
      if (!btn) return;
      var id = parseInt(btn.getAttribute('data-cust-id'), 10);
      var c = state.customers.find(function (x) { return x.id === id; });
      if (c) selectCustomer(c);
    });

    searchEl.addEventListener('input', renderCustomers);

    /* ── Tự chọn khách nếu có preselect ── */
    if (preselectId) {
      var pre = state.customers.find(function (x) { return x.id === preselectId; });
      if (pre) {
        selectCustomer(pre);
        searchEl.value = pre.name;
      }
    }
    renderCustomers();

    /* ── Lưu ── */
    $('kr-cancel').addEventListener('click', function () {
      D.closeSheet();
    });

    saveBtn.addEventListener('click', async function () {
      if (!selected) { D.toast('Vui lòng chọn khách hàng', 'warning'); return; }
      var kegs = parseInt(kegsEl.value, 10);
      if (!kegs || kegs < 1) { D.toast('Số vỏ phải lớn hơn 0', 'warning'); return; }
      if (kegs > (selected.keg_balance || 0)) {
        D.toast('Khách chỉ đang giữ ' + D.num(selected.keg_balance || 0) + ' vỏ', 'warning');
        return;
      }

      saveBtn.disabled = true;
      try {
        var res = await D.api.createKegReceipt({
          customerId: selected.id,
          kegs: kegs,
          note: $('kr-note').value.trim()
        });
        state.lastReceipt = res.receipt;
        D.closeSheet();
        D.toast('Đã tạo phiếu ' + res.receipt.receipt_no, 'success');
        openReceipt(res.receipt);
        loadReceipts();
        loadCustomers();
      } catch (err) {
        D.toast(err.message || 'Lỗi khi tạo phiếu', 'error');
        saveBtn.disabled = false;
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Hiển thị phiếu (in / chia sẻ)
   * ═══════════════════════════════════════════════════════════════════ */
  function receiptHtml(r) {
    return '' +
      '<div class="ds-receipt" id="kr-print-area">' +
        '<div class="ds-receipt__head">' +
          '<div class="ds-receipt__brand">Bia Tươi Tây Ninh</div>' +
          '<div class="ds-receipt__title">PHIẾU THU VỎ</div>' +
          '<div class="ds-receipt__no">Số phiếu: ' + esc(r.receipt_no) + '</div>' +
        '</div>' +

        '<div class="ds-receipt__body">' +
          '<dl class="ds-receipt__grid">' +
            '<dt>Khách hàng</dt><dd>' + esc(r.customer_name) + '</dd>' +
            (r.customer_phone
              ? '<dt>Số điện thoại</dt><dd>' + esc(r.customer_phone) + '</dd>' : '') +
            (r.customer_address
              ? '<dt>Địa chỉ</dt><dd>' + esc(r.customer_address) + '</dd>' : '') +
            '<dt>Thời gian</dt><dd>' + esc(timeLabel(r.created_at)) + '</dd>' +
            '<dt>Tài xế</dt><dd>' + esc(r.driver_username) + '</dd>' +
            '<dt>Vỏ khách giữ trước</dt><dd>' + D.num(r.balance_before) + ' vỏ</dd>' +
            '<dt>Vỏ khách giữ sau</dt><dd>' + D.num(r.balance_after) + ' vỏ</dd>' +
          '</dl>' +

          '<div class="ds-receipt__amount">' +
            '<span>Số vỏ thu về</span>' +
            '<b>' + D.num(r.kegs) + ' vỏ</b>' +
          '</div>' +

          (r.note
            ? '<div class="ds-receipt__note">📝 ' + esc(r.note) + '</div>'
            : '') +
        '</div>' +

        '<div class="ds-receipt__sign">' +
          '<div><b>Tài xế</b><i>(ký, ghi rõ họ tên)</i></div>' +
          '<div><b>Khách hàng</b><i>(ký, ghi rõ họ tên)</i></div>' +
        '</div>' +

        '<div class="ds-receipt__foot">' +
          'Phiếu được lập tự động từ Cổng Tài xế — Bia Tươi Tây Ninh' +
        '</div>' +
      '</div>';
  }

  function openReceipt(receipt) {
    var r = receipt;
    if (!r || !r.receipt_no) return;

    var body = D.openSheet(
      receiptHtml(r) +
      '<div class="ds-receipt__actions">' +
        '<button class="ds-btn ds-btn--ghost" id="kr-print" type="button">🖨️ In phiếu</button>' +
        '<button class="ds-btn ds-btn--primary" id="kr-copy" type="button">📋 Copy nội dung</button>' +
      '</div>',
      { title: 'Phiếu ' + r.receipt_no }
    );
    if (!body) return;

    $('kr-print').addEventListener('click', function () {
      window.print();
    });

    $('kr-copy').addEventListener('click', async function () {
      var text =
        'PHIẾU THU VỎ — Bia Tươi Tây Ninh\n' +
        'Số phiếu: ' + r.receipt_no + '\n' +
        'Khách hàng: ' + (r.customer_name || '—') +
        (r.customer_phone ? ' (' + r.customer_phone + ')' : '') + '\n' +
        'Thời gian: ' + timeLabel(r.created_at) + '\n' +
        'Tài xế: ' + r.driver_username + '\n' +
        'Số vỏ thu về: ' + r.kegs + ' vỏ\n' +
        'Vỏ khách còn giữ: ' + r.balance_before + ' → ' + r.balance_after + ' vỏ' +
        (r.note ? '\nGhi chú: ' + r.note : '') +
        '\n\n— Tài xế: ____________    Khách hàng: ____________';

      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          D.toast('Đã copy nội dung phiếu', 'success');
        } else {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          D.toast('Đã copy nội dung phiếu', 'success');
        }
      } catch (err) {
        D.toast('Không copy được — hãy chụp ảnh phiếu', 'warning');
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Danh sách phiếu
   * ═══════════════════════════════════════════════════════════════════ */
  function renderReceipts() {
    var el = $('kr-list');
    if (!el) return;

    if (!state.receipts.length) {
      el.innerHTML = window.DrvShell.empty(
        '📄',
        'Chưa có phiếu thu vỏ nào. Nhấn "Tạo phiếu thu vỏ" để lập phiếu đầu tiên.'
      );
      return;
    }

    el.innerHTML = state.receipts.map(function (r) {
      return '<div class="ds-row ds-card--tap" data-receipt-id="' + r.id + '">' +
        '<span class="ds-row__lead" aria-hidden="true">📄</span>' +
        '<span class="ds-row__body">' +
          '<span class="ds-row__title">' + esc(r.customer_name || '—') + '</span>' +
          '<span class="ds-row__meta">' +
            esc(r.receipt_no) + ' · ' + esc(timeLabel(r.created_at)) +
          '</span>' +
        '</span>' +
        '<span class="ds-row__tail">' +
          '<span class="ds-qty"><b>' + D.num(r.kegs) + '</b><i>vỏ</i></span>' +
        '</span>' +
      '</div>';
    }).join('');
  }

  async function loadReceipts() {
    var el = $('kr-list');
    try {
      var res = await D.api.kegReceipts(30);
      state.receipts = res.receipts || [];
      if (el) renderReceipts();
    } catch (err) {
      if (el) el.innerHTML = window.DrvShell.empty('⚠️', esc(err.message));
    }
  }

  async function loadCustomers() {
    try {
      var res = await D.api.customers('');
      state.customers = res.customers || [];
    } catch (err) {
      state.customers = [];
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Public API (dùng từ trang chủ)
   * ═══════════════════════════════════════════════════════════════════ */
  window.DrvKegReceipt = {
    /** Mở form tạo phiếu thu vỏ. */
    open: function (preselectCustomerId) {
      loadCustomers().then(function () { openCreateForm(preselectCustomerId); });
    },
    /** Xem lại 1 phiếu đã tạo. */
    view: openReceipt,
    /** Nạp lại danh sách phiếu + khách (dùng sau khi tạo). */
    refresh: function () {
      return Promise.all([loadCustomers(), loadReceipts()]);
    }
  };

  /* ═══════════════════════════════════════════════════════════════════
   * Module độc lập (nếu có trang riêng trong tương lai)
   * ═══════════════════════════════════════════════════════════════════ */
  function initStandalone() {
    var root = document.getElementById('kr-list');
    if (!root) return;

    window.DrvShell.mount({
      key: 'keg-receipts',
      icon: '📄',
      title: 'Phiếu thu vỏ',
      content:
        '<section class="ds-section">' +
          '<button class="ds-btn ds-btn--primary ds-btn--block" id="kr-new" type="button">' +
            '📄 Tạo phiếu thu vỏ</button>' +
        '</section>' +
        '<section class="ds-section">' +
          '<div class="ds-section__head">' +
            '<h2 class="ds-section__title">Phiếu đã lập</h2>' +
            '<span class="ds-section__badge" id="kr-count">0</span>' +
          '</div>' +
          '<div class="ds-list" id="kr-list"></div>' +
        '</section>'
    });

    var newBtn = $('kr-new');
    if (newBtn) newBtn.addEventListener('click', function () { window.DrvKegReceipt.open(); });

    var listEl = $('kr-list');
    if (listEl) {
      listEl.addEventListener('click', function (e) {
        var item = e.target.closest('[data-receipt-id]');
        if (!item) return;
        var id = parseInt(item.getAttribute('data-receipt-id'), 10);
        var r = state.receipts.find(function (x) { return x.id === id; });
        if (r) openReceipt(r);
      });
    }

    loadCustomers().then(loadReceipts);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStandalone);
  } else {
    initStandalone();
  }
})();
