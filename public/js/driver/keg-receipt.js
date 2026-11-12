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
 *
 * Tính năng:
 *   • Tạo phiếu        → openCreateForm()
 *   • XEM phiếu        → openReceipt()   (in / copy nội dung)
 *   • SỬA phiếu        → openEditForm()  (đổi số vỏ / ghi chú)
 *   • XOÁ phiếu        → confirm → API DELETE (hoàn vỏ cho khách)
 */
(function () {
  'use strict';

  var D = window.Drv;

  var state = {
    customers: [],
    q: '',
    receipts: [],
    lastReceipt: null,
    listEl: null,   // container đang hiển thị danh sách phiếu
  };

  /* ═══════════════════════════════════════════════════════════════════
   * Icons (SVG inline — dùng chung style với các module khác)
   * ═══════════════════════════════════════════════════════════════════ */
  var SVG = {
    eye: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    edit: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    trash: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
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
   * Form SỬA phiếu
   * ───────────────────────────────────────────────────────────────────
   * • Không cho đổi khách hàng (đã ghi log giao dịch vỏ theo khách).
   * • Chỉ đổi được SỐ VỎ và GHI CHÚ.
   * • Số vỏ tăng → phải trừ thêm từ tồn vỏ khách đang giữ.
   * • Số vỏ giảm → hoàn lại vỏ cho khách.
   * ═══════════════════════════════════════════════════════════════════ */
  function openEditForm(receipt) {
    if (!receipt || !receipt.id) return;

    var body = D.openSheet(
      '<div class="ds-field">' +
        '<label class="ds-label">Khách hàng</label>' +
        '<div class="ds-input" style="background:var(--ds-surface-3);opacity:.85;">' +
          esc(receipt.customer_name || '—') +
        '</div>' +
        '<div class="ds-muted ds-mt-2" style="font-size:.8rem;" id="kr-e-hint"></div>' +
      '</div>' +

      '<div class="ds-field">' +
        '<label class="ds-label" for="kr-e-kegs">Số vỏ thu về *</label>' +
        '<input class="ds-input" id="kr-e-kegs" type="number" min="1" step="1" ' +
          'value="' + (receipt.kegs || 1) + '">' +
      '</div>' +

      '<div class="ds-field">' +
        '<label class="ds-label" for="kr-e-note">Ghi chú</label>' +
        '<input class="ds-input" id="kr-e-note" type="text" ' +
          'placeholder="Lý do thu vỏ (không bắt buộc)" ' +
          'value="' + esc(receipt.note || '') + '">' +
      '</div>' +

      '<div class="ds-btn-row ds-mt-4">' +
        '<button class="ds-btn ds-btn--ghost" id="kr-e-cancel" type="button">Huỷ</button>' +
        '<button class="ds-btn ds-btn--primary" id="kr-e-save" type="button">💾 Lưu thay đổi</button>' +
      '</div>',
      { title: '✏️ Sửa phiếu ' + (receipt.receipt_no || '') }
    );
    if (!body) return;

    var kegsEl = $('kr-e-kegs');
    var hintEl = $('kr-e-hint');
    var saveBtn = $('kr-e-save');
    var customer = state.customers.find(function (c) { return c.id === receipt.customer_id; });
    var balance = customer ? (customer.keg_balance || 0) : 0;
    var oldKegs = receipt.kegs || 0;

    function refreshHint() {
      var v = parseInt(kegsEl.value, 10);
      if (isNaN(v) || v < 1) {
        hintEl.textContent = 'Số vỏ phải lớn hơn 0.';
        hintEl.style.color = 'var(--ds-danger)';
        saveBtn.disabled = true;
        return;
      }
      var diff = v - oldKegs;
      if (diff > 0) {
        hintEl.textContent = 'Tăng ' + D.num(diff) + ' vỏ → trừ thêm từ tồn vỏ khách đang giữ (' +
          D.num(balance) + ' vỏ).';
        hintEl.style.color = balance >= diff ? 'var(--ds-text-2)' : 'var(--ds-danger)';
        saveBtn.disabled = balance < diff;
      } else if (diff < 0) {
        hintEl.textContent = 'Giảm ' + D.num(-diff) + ' vỏ → hoàn lại ' +
          D.num(-diff) + ' vỏ cho khách.';
        hintEl.style.color = 'var(--ds-text-2)';
        saveBtn.disabled = false;
      } else {
        hintEl.textContent = 'Không đổi số vỏ.';
        hintEl.style.color = 'var(--ds-text-2)';
        saveBtn.disabled = false;
      }
    }
    kegsEl.addEventListener('input', refreshHint);
    refreshHint();

    $('kr-e-cancel').addEventListener('click', function () { D.closeSheet(); });

    saveBtn.addEventListener('click', async function () {
      var kegs = parseInt(kegsEl.value, 10);
      if (!kegs || kegs < 1) { D.toast('Số vỏ phải lớn hơn 0', 'warning'); return; }
      saveBtn.disabled = true;
      try {
        var res = await D.api.updateKegReceipt(receipt.id, {
          kegs: kegs,
          note: $('kr-e-note').value.trim()
        });
        D.closeSheet();
        D.toast('Đã cập nhật phiếu ' + (res.receipt ? res.receipt.receipt_no : ''), 'success');
        await loadReceipts();
        await loadCustomers();
        openReceipt(res.receipt || receipt);
      } catch (err) {
        D.toast(err.message || 'Lỗi khi sửa phiếu', 'error');
        saveBtn.disabled = false;
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
   * XOÁ phiếu (hoàn vỏ cho khách)
   * ═══════════════════════════════════════════════════════════════════ */
  async function deleteReceipt(receipt) {
    if (!receipt || !receipt.id) return;
    var ok = await D.confirm(
      'Xoá phiếu <b>' + esc(receipt.receipt_no || '') + '</b> của khách <b>' +
      esc(receipt.customer_name || '—') + '</b>?<br><br>' +
      '<b>' + D.num(receipt.kegs || 0) + ' vỏ</b> sẽ được hoàn lại cho khách đang giữ.',
      { title: '🗑 Xoá phiếu thu vỏ', okText: 'Xoá phiếu', danger: true }
    );
    if (!ok) return;
    try {
      await D.api.deleteKegReceipt(receipt.id);
      D.toast('Đã xoá phiếu ' + (receipt.receipt_no || ''), 'success');
      await loadReceipts();
      await loadCustomers();
    } catch (err) {
      D.toast(err.message || 'Lỗi khi xoá phiếu', 'error');
    }
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
        '<button class="ds-btn ds-btn--ghost" id="kr-print" type="button">📄 In / Chụp phiếu</button>' +
        '<button class="ds-btn ds-btn--ghost" id="kr-edit" type="button">✏️ Sửa</button>' +
        '<button class="ds-btn ds-btn--danger" id="kr-delete" type="button">🗑 Xoá</button>' +
        '<button class="ds-btn ds-btn--primary" id="kr-copy" type="button">📋 Copy nội dung</button>' +
      '</div>',
      { title: 'Phiếu ' + r.receipt_no }
    );
    if (!body) return;

    $('kr-print').addEventListener('click', function () {
      // Mở MODAL phiếu ngay trong trang (không mở tab mới) — tờ phiếu nền
      // trắng dạng hoá đơn để tài xế CHỤP MÀN HÌNH rồi gửi khách.
      D.closeSheet();
      window.DrvReceipt.open(r);
    });

    $('kr-edit').addEventListener('click', function () {
      D.closeSheet();
      // Nạp lại khách để có tồn vỏ chính xác khi sửa
      loadCustomers().then(function () { openEditForm(r); });
    });

    $('kr-delete').addEventListener('click', function () {
      D.closeSheet();
      deleteReceipt(r);
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
   * Danh sách phiếu (kèm nút Xem / Sửa / Xoá)
   * ═══════════════════════════════════════════════════════════════════ */
  function renderReceipts(el) {
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
        '<span class="ds-rowacts">' +
          '<button type="button" class="ds-rowact ds-rowact--view" data-act="view" ' +
            'data-id="' + r.id + '" title="Xem phiếu" aria-label="Xem phiếu">' + SVG.eye + '</button>' +
          '<button type="button" class="ds-rowact ds-rowact--edit" data-act="edit" ' +
            'data-id="' + r.id + '" title="Sửa phiếu" aria-label="Sửa phiếu">' + SVG.edit + '</button>' +
          '<button type="button" class="ds-rowact ds-rowact--delete" data-act="delete" ' +
            'data-id="' + r.id + '" title="Xoá phiếu" aria-label="Xoá phiếu">' + SVG.trash + '</button>' +
        '</span>' +
      '</div>';
    }).join('');

    // Badge đếm số phiếu (nếu có)
    var badge = $('home-keg-count');
    if (badge) badge.textContent = state.receipts.length;
  }

  async function loadReceipts(el) {
    var target = el || state.listEl || $('kr-list');
    state.listEl = target || null;
    try {
      var res = await D.api.kegReceipts(30);
      state.receipts = res.receipts || [];
      renderReceipts(target);
    } catch (err) {
      if (target) target.innerHTML = window.DrvShell.empty('⚠️', esc(err.message));
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
    /** Sửa 1 phiếu. */
    edit: openEditForm,
    /** Xoá 1 phiếu (có xác nhận). */
    remove: deleteReceipt,
    /** Tìm phiếu theo id trong danh sách đã nạp. */
    find: function (id) {
      var rid = parseInt(id, 10);
      return state.receipts.find(function (x) { return x.id === rid; }) || null;
    },
    /** Nạp lại danh sách phiếu + khách (dùng sau khi tạo/sửa/xoá). */
    refresh: function () {
      return Promise.all([loadCustomers(), loadReceipts()]);
    },
    /** Render danh sách phiếu vào 1 container bất kỳ (dùng ở trang chủ). */
    renderInto: function (containerId) {
      var el = $(containerId);
      if (!el) return Promise.resolve();
      el.className = 'ds-list';
      state.listEl = el;
      return Promise.all([loadCustomers(), loadReceipts(el)]);
    },
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
        var actBtn = e.target.closest('[data-act]');
        if (actBtn) {
          e.stopPropagation();
          var act = actBtn.getAttribute('data-act');
          var aid = parseInt(actBtn.getAttribute('data-id'), 10);
          var ar = state.receipts.find(function (x) { return x.id === aid; });
          if (!ar) return;
          if (act === 'view') openReceipt(ar);
          else if (act === 'edit') loadCustomers().then(function () { openEditForm(ar); });
          else if (act === 'delete') deleteReceipt(ar);
          return;
        }

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
