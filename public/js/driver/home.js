/**
 * Driver Portal — TRANG CHỦ
 * ─────────────────────────────────────────────────────────────────────────────
 * Dùng chung Design System (driver-system.css + shell.js).
 * Mọi trang Driver Portal dùng CÙNG shell: app bar + main + bottom nav.
 *
 * API: GET /api/driver/home?month=YYYY-MM&date=YYYY-MM-DD
 *    → { date, todayOrders, todayLiters, todayKegs, todayKegsNet, selectedDate,
 *        isToday, month, monthLabel, daily[], monthTotals, pendingSummary,
 *        pendingProducts[], prevMonth, nextMonth }
 */
(function () {
  'use strict';

  var D = window.Drv;
  var S = window.DrvShell;

  // Icon + đơn vị theo loại sản phẩm
  var PRODUCT_META = {
    bia_bom_vang: { icon: '🍺', unit: 'vỏ' },
    bia_bom_en: { icon: '🍺', unit: 'vỏ' },
    dbg_sku: { icon: '🍺', unit: 'vỏ' },
    bia_pet_chai_nhua: { icon: '🥤', unit: 'chai' },
    bia_lon_g8: { icon: '🥤', unit: 'chai' },
    box_23_lit: { icon: '📦', unit: 'thùng' },
    keg: { icon: '🍺', unit: 'vỏ' },
    pet: { icon: '🥤', unit: 'chai' },
    box: { icon: '📦', unit: 'thùng' }
  };

  var WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

  var state = { month: null, date: null, busy: false };

  /* ═══════════════════════════════════════════════════════════════════
   * Markup
   * ═══════════════════════════════════════════════════════════════════ */
  function markup() {
    return '' +
      /* ── Thẻ tài xế ── */
      '<section class="ds-me">' +
        '<span class="ds-me__avatar" aria-hidden="true">👤</span>' +
        '<span class="ds-me__body">' +
          '<span class="ds-me__label">Tài xế đang đăng nhập</span>' +
          '<span class="ds-me__name" id="home-user-name">…</span>' +
          '<span class="ds-me__id" id="home-user-username"></span>' +
        '</span>' +
        // Lương dự kiến (chưa tính thưởng/phạt) — ẩn nếu tài xế chưa có hồ sơ lương
        '<span class="ds-me__salary" id="home-salary" hidden>' +
          '<span class="ds-me__salary-label" id="home-salary-label">Lương dự kiến</span>' +
          '<b class="ds-me__salary-value" id="home-salary-amount">—</b>' +
          '<span class="ds-me__salary-note" id="home-salary-note"></span>' +
          '<span class="ds-me__salary-advance" id="home-salary-advance" hidden>' +
            'Đã ứng <b id="home-salary-advance-amount">0</b>' +
            ' · còn nhận <b id="home-salary-net">0</b>' +
          '</span>' +
        '</span>' +
      '</section>' +

      /* ── Bộ lọc ngày trong tháng ── */
      '<section class="ds-calendar ds-mt-4" id="home-calendar">' +
        '<div class="ds-calendar__bar">' +
          '<button class="ds-calendar__nav" id="home-prev-month" type="button" aria-label="Tháng trước">' +
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
                 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="m15 18-6-6 6-6"/></svg>' +
          '</button>' +
          '<div class="ds-calendar__month" id="home-month-label">Tháng —</div>' +
          '<button class="ds-calendar__nav" id="home-next-month" type="button" aria-label="Tháng sau">' +
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
                 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="m9 18 6-6-6-6"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="ds-calendar__days" id="home-day-list" role="tablist" aria-label="Chọn ngày trong tháng"></div>' +
        '<div class="ds-summary" id="home-month-summary">' +
          '<span><b id="home-sum-orders">0</b> đơn</span>' +
          '<span><b id="home-sum-liters">0</b> lít</span>' +
          '<span><b id="home-sum-kegs">0</b> vỏ</span>' +
          '<span id="home-sum-kegs-net-wrap" hidden><b id="home-sum-kegs-net">0</b> còn lưu</span>' +
          '<span class="ds-summary__label">cả tháng</span>' +
        '</div>' +
      '</section>' +

      /* ── KPI ── */
      '<section class="ds-section ds-mt-4">' +
        '<div class="ds-section__head">' +
          '<h2 class="ds-section__title" id="home-stats-title">Thống kê hôm nay</h2>' +
        '</div>' +
        '<div class="ds-stats">' +
          stat(0, 'Số đơn', { id: 'home-orders', icon: ICON_BOX }) +
          stat(0, 'Số lít bia', { id: 'home-liters', icon: ICON_CAN }) +
          stat(0, 'Vỏ đã thu', { id: 'home-kegs', icon: ICON_KEG }) +
        '</div>' +
      '</section>' +

      /* ── Hàng cần giao hôm nay ── */
      '<section class="ds-load ds-mt-4" id="home-load-section">' +
        '<div class="ds-load__head">' +
          '<span class="ds-load__icon" aria-hidden="true">' + ICON_TRUCK + '</span>' +
          '<span class="ds-load__text">' +
            '<span class="ds-load__title">Hàng cần giao hôm nay</span>' +
            '<span class="ds-load__sub" id="home-load-sub">Chuẩn bị hàng lên xe</span>' +
          '</span>' +
        '</div>' +
        '<div class="ds-list" id="home-load-list"></div>' +
      '</section>' +

      /* ── Hành động nhanh: Phiếu thu vỏ ── */
      '<section class="ds-section ds-mt-4" id="home-keg-section">' +
        '<button class="ds-btn ds-btn--primary ds-btn--block ds-btn--lg" ' +
                'id="home-keg-receipt" type="button">' +
          '📄 Tạo phiếu thu vỏ' +
        '</button>' +
        '<p class="ds-section__note ds-mt-2">' +
          'Thu vỏ rỗng khi không giao hàng — lập phiếu để báo cáo với khách. ' +
          'Số vỏ sẽ trừ khỏi vỏ khách đang giữ.' +
        '</p>' +

        /* ── Phiếu đã lập: XEM / SỬA / XOÁ ── */
        '<div class="ds-divider ds-mt-4"></div>' +
        '<div class="ds-section__head ds-mt-3">' +
          '<h2 class="ds-section__title">Phiếu thu vỏ đã lập</h2>' +
          '<span class="ds-section__badge" id="home-keg-count">0</span>' +
        '</div>' +
        '<div class="ds-list" id="home-keg-list"></div>' +
      '</section>' +

      /* ── Gợi ý / lỗi ── */
      '<div class="ds-mt-3" id="home-hint" hidden></div>';
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Icons
   * ═══════════════════════════════════════════════════════════════════ */
  var ICON_BOX =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>' +
    '<path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>';

  var ICON_CAN =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 2v2"/><path d="M6 8h12v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2Z"/>' +
    '<path d="M6 8c0-2 1-3 2-3h8c1 0 2 1 2 3"/><path d="M18 10h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1"/></svg>';

  var ICON_KEG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>' +
    '<path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>';

  var ICON_TRUCK =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/>' +
    '<path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A2 2 0 0 0 17.52 8H14"/>' +
    '<circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>';

  /** Stat card có id để JS cập nhật. */
  function stat(value, label, opts) {
    opts = opts || {};
    return '<div class="ds-stat' + (opts.tone ? ' ds-stat--' + opts.tone : '') + '">' +
      '<span class="ds-stat__icon" aria-hidden="true">' + (opts.icon || '') + '</span>' +
      '<span class="ds-stat__value" id="' + opts.id + '">' + value + '</span>' +
      '<span class="ds-stat__label">' + label + '</span>' +
      '<span class="ds-stat__note ds-stat__note--info" id="home-kegs-net" hidden></span>' +
    '</div>';
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Load
   * ═══════════════════════════════════════════════════════════════════ */
  async function load() {
    var me = null;
    try {
      me = await D.api.me();
    } catch (err) {
      showHint('Không tải được thông tin tài khoản. Vui lòng kiểm tra mạng.', true);
      return;
    }

    window.DRV_USER = me;
    setText('home-user-name', me.fullName || me.username || '—');
    setText('home-user-username', me.username ? '@' + me.username : '');

    // Tên tài xế hiện trên app bar
    var barUser = document.getElementById('drv-user');
    if (barUser) barUser.textContent = me.fullName || me.username || '';

    await loadStats();
  }

  async function loadStats() {
    var url = '/api/driver/home';
    var params = [];
    if (state.month) params.push('month=' + encodeURIComponent(state.month));
    if (state.date) params.push('date=' + encodeURIComponent(state.date));
    if (params.length) url += '?' + params.join('&');

    try {
      var data = await D.api.get(url);

      state.month = data.month || state.month;
      state.date = data.selectedDate || state.date;

      setText('home-orders', D.num(data.todayOrders || 0));
      setText('home-liters', D.num(data.todayLiters || 0));
      setText('home-kegs', D.num(data.todayKegs || 0));

      // Vỏ: "đã thu" + ghi chú số vỏ còn lưu lượng (giao đi − thu về)
      var netEl = document.getElementById('home-kegs-net');
      if (netEl) {
        var net = data.todayKegsNet || 0;
        netEl.textContent =
          net > 0 ? 'còn ' + D.num(net) + ' vỏ' :
          (net < 0 ? 'thừa ' + D.num(Math.abs(net)) + ' vỏ' : '');
        netEl.hidden = net === 0;
      }

      renderMonthLabel(data);
      renderDayList(data);
      renderMonthSummary(data);
      renderStatsTitle(data);
      renderLoad(data);
      renderEstimatedSalary(data);
      showHint('', false);
    } catch (err) {
      setText('home-orders', '—');
      setText('home-liters', '—');
      setText('home-kegs', '—');
      showHint(
        err && err.rateLimited
          ? 'Máy chủ đang bận, vui lòng thử lại sau.'
          : 'Không tải được số liệu. Vui lòng thử lại.',
        true
      );
    }
  }

  function renderMonthLabel(data) {
    setText('home-month-label', data.monthLabel || 'Tháng —');
  }

  function renderStatsTitle(data) {
    var title = document.getElementById('home-stats-title');
    if (!title) return;
    if (data.isToday) {
      title.textContent = 'Thống kê hôm nay';
    } else {
      var parts = String(data.selectedDate || '').split('-');
      title.textContent = 'Thống kê ' + (parts[2] || '') + '/' + (parts[1] || '') + '/' + (parts[0] || '');
    }
  }

  function renderDayList(data) {
    var box = document.getElementById('home-day-list');
    if (!box) return;

    var daily = data.daily || [];
    var selected = data.selectedDate || '';
    var today = data.date || '';

    box.innerHTML = daily.map(function (d) {
      var cls = 'ds-day';
      if (d.date === selected) cls += ' is-selected';
      if (d.date === today) cls += ' is-today';
      if (d.orders || d.liters || d.kegs) cls += ' has-data';

      var hint = '';
      if (d.orders || d.liters || d.kegs) {
        hint = '<span class="ds-day__tip">' +
          d.orders + ' đơn · ' + D.num(d.liters) + ' lít · ' + D.num(d.kegs) + ' vỏ thu</span>';
      }

      return '<button class="' + cls + '" type="button" role="tab" data-date="' + d.date + '"' +
        ' aria-selected="' + (d.date === selected ? 'true' : 'false') + '">' +
        d.day + hint + '</button>';
    }).join('');

    var sel = box.querySelector('.is-selected');
    if (sel && sel.scrollIntoView) {
      try { sel.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (_) {}
    }
  }

  function renderMonthSummary(data) {
    var t = data.monthTotals || {};
    setText('home-sum-orders', D.num(t.orders || 0));
    setText('home-sum-liters', D.num(t.liters || 0));
    setText('home-sum-kegs', D.num(t.kegs || 0));

    var netEl = document.getElementById('home-sum-kegs-net');
    var netWrap = document.getElementById('home-sum-kegs-net-wrap');
    if (netEl) {
      var net = t.kegsNet || 0;
      netEl.textContent = D.num(net);
      netEl.hidden = net <= 0;
      if (netWrap) netWrap.hidden = net <= 0;
    }
  }

  /** Danh sách loại hàng cần giao hôm nay (loại + số lượng). */
  function renderLoad(data) {
    var list = document.getElementById('home-load-list');
    var sub = document.getElementById('home-load-sub');
    if (!list) return;

    var products = data.pendingProducts || [];
    var sum = data.pendingSummary || {};

    if (!products.length) {
      if (sub) sub.textContent = 'Đã giao xong hết hàng hôm nay';
      list.innerHTML = S.empty('✅', 'Không còn hàng cần giao hôm nay');
      return;
    }

    var orders = sum.orders || products.length;
    if (sub) {
      sub.textContent = orders + ' đơn · ' +
        D.num(sum.deliverKegs || 0) + ' vỏ giao · ' +
        D.num(sum.returnKegs || 0) + ' vỏ thu';
    }

    list.innerHTML = products.map(function (p) {
      var meta = PRODUCT_META[p.slug] || PRODUCT_META[p.type] || {};
      var icon = meta.icon || '🧺';
      var unit = p.unit || meta.unit || 'lít';

      return '<div class="ds-row">' +
        '<span class="ds-row__lead" aria-hidden="true">' + icon + '</span>' +
        '<span class="ds-row__body">' +
          '<span class="ds-row__title">' + escapeHtml(p.name) + '</span>' +
        '</span>' +
        '<span class="ds-row__tail">' +
          '<span class="ds-qty"><b>' + D.num(p.qty) + '</b><i>' + escapeHtml(unit) + '</i></span>' +
        '</span>' +
      '</div>';
    }).join('');
  }

  /**
   * Lương dự kiến (chưa tính thưởng/phạt).
   * Công thức: (lương cố định tháng ÷ 26) × số ngày làm thực tế.
   */
  function renderEstimatedSalary(data) {
    var box = document.getElementById('home-salary');
    if (!box) return;

    var s = data.estimatedSalary;
    if (!s || !s.baseSalary) {
      box.hidden = true;
      return;
    }

    box.hidden = false;

    var amountEl = document.getElementById('home-salary-amount');
    if (amountEl) amountEl.textContent = D.money(s.amount || 0);

    var noteEl = document.getElementById('home-salary-note');
    if (noteEl) {
      var parts = [];
      parts.push(s.workDays + '/' + (s.standardWorkDays || 26) + ' ngày');
      parts.push(D.money(s.dailyRate || 0) + '/ngày');
      if (s.startDate) parts.push('vào làm ' + formatShortDate(s.startDate));
      if (!s.isCurrentMonth) parts.push('tháng đã qua');
      noteEl.textContent = parts.join(' · ');
    }

    // Nhãn tháng — luôn là tháng hiện tại
    var labelEl = document.getElementById('home-salary-label');
    if (labelEl) {
      var m = String(s.month || '').slice(0, 7);
      labelEl.textContent = m
        ? 'Lương dự kiến T' + m.slice(5, 7) + '/' + m.slice(0, 4)
        : 'Lương dự kiến';
    }

    // ── Khoản đã ứng (nếu có) ──────────────────────────────────────────
    var advBox = document.getElementById('home-salary-advance');
    if (advBox) {
      var adv = Number(s.advanceTotal) || 0;
      advBox.hidden = adv <= 0;
      if (adv > 0) {
        var advEl = document.getElementById('home-salary-advance-amount');
        if (advEl) advEl.textContent = D.money(adv);
        var netEl = document.getElementById('home-salary-net');
        if (netEl) netEl.textContent = D.money(Math.max(0, (s.netAmount !== undefined ? s.netAmount : s.amount) || 0));
      }
    }
  }

  /** Định dạng ngày ngắn gọn (dd/mm/yyyy) — tránh lệch ngày do UTC */
  function formatShortDate(dateStr) {
    var m = String(dateStr || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    return m[3] + '/' + m[2] + '/' + m[1];
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function changeMonth(delta) {
    if (state.busy) return;
    var today = new Date(Date.now() + 7 * 60 * 60 * 1000);
    var cur = state.month ||
      today.getUTCFullYear() + '-' + String(today.getUTCMonth() + 1).padStart(2, '0');

    var parts = cur.split('-').map(Number);
    var d = new Date(parts[0], parts[1] - 1 + delta, 1);
    var next = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');

    state.busy = true;
    state.month = next;
    state.date = null;
    await loadStats();
    state.busy = false;
  }

  async function selectDate(dateStr) {
    if (state.busy) return;
    state.busy = true;
    state.date = dateStr;
    await loadStats();
    state.busy = false;
  }

  function showHint(msg, isError) {
    var el = document.getElementById('home-hint');
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = '';
      el.className = 'ds-mt-3';
      return;
    }
    el.hidden = false;
    el.textContent = msg;
    el.className = 'ds-mt-3 ds-card ' + (isError ? 'ds-badge--danger' : 'ds-badge--info');
    el.style.color = isError ? 'var(--ds-danger)' : 'var(--ds-info)';
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Init
   * ═══════════════════════════════════════════════════════════════════ */
  function init() {
    // Dựng shell
    S.mount({
      key: 'home',
      icon: '🍺',
      title: 'Trang chủ',
      content: markup()
    });

    var prev = document.getElementById('home-prev-month');
    var next = document.getElementById('home-next-month');
    if (prev) prev.addEventListener('click', function () { changeMonth(-1); });
    if (next) next.addEventListener('click', function () { changeMonth(1); });

    var list = document.getElementById('home-day-list');
    if (list) {
      list.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-date]') : null;
        if (!btn) return;
        selectDate(btn.getAttribute('data-date'));
      });
    }

    // Nút tạo phiếu thu vỏ
    var kegBtn = document.getElementById('home-keg-receipt');
    if (kegBtn) {
      kegBtn.addEventListener('click', function () {
        if (window.DrvKegReceipt) {
          window.DrvKegReceipt.open();
        } else {
          D.toast('Tính năng phiếu thu vỏ chưa sẵn sàng', 'error');
        }
      });
    }

    // Danh sách phiếu thu vỏ đã lập (Xem / Sửa / Xoá)
    var kegList = document.getElementById('home-keg-list');
    if (kegList && window.DrvKegReceipt) {
      window.DrvKegReceipt.renderInto('home-keg-list');

      kegList.addEventListener('click', function (e) {
        var actBtn = e.target.closest('[data-act]');
        if (actBtn) {
          e.stopPropagation();
          var act = actBtn.getAttribute('data-act');
          var aid = parseInt(actBtn.getAttribute('data-id'), 10);
          var receipt = window.DrvKegReceipt.find(aid);
          if (!receipt) return;
          if (act === 'view') window.DrvKegReceipt.view(receipt);
          else if (act === 'edit') window.DrvKegReceipt.edit(receipt);
          else if (act === 'delete') window.DrvKegReceipt.remove(receipt);
          return;
        }

        var item = e.target.closest('[data-receipt-id]');
        if (!item) return;
        var id = parseInt(item.getAttribute('data-receipt-id'), 10);
        var r = window.DrvKegReceipt.find(id);
        if (r) window.DrvKegReceipt.view(r);
      });
    }

    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
