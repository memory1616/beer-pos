/**
 * Driver Portal — TRANG CHỦ (thiết kế lại)
 * ─────────────────────────────────────────────────────────────────────────────
 * Giao diện tối giản, ưu tiên điện thoại:
 *   HEADER   : BIA TƯƠI TÂY NINH · CỔNG TÀI XẾ · tên tài xế · ngày · trạng thái
 *   LỌC      : chuyển tháng ‹ › + dải ngày 1..N trong tháng + tổng cả tháng
 *   THỐNG KÊ : Số đơn · Số lít bia · Vỏ đã thu (theo ngày đang chọn)
 *
 * API: GET /api/driver/home?month=YYYY-MM&date=YYYY-MM-DD
 *    → { date, todayOrders, todayLiters, todayKegs, selectedDate, isToday,
 *        month, monthLabel, daily[], monthTotals, pendingSummary,
 *        pendingProducts[], prevMonth, nextMonth }
 */
(function () {
  'use strict';

  var D = window.Drv;

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
    box: { icon: '📦', unit: 'thùng' },
  };

  var WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

  // Ngày đang chọn + tháng đang xem (null = chưa chọn → dùng mặc định server)
  var state = { month: null, date: null, busy: false };

  async function load() {
    D.setupNav('home');

    var me = null;
    try {
      me = await D.api.me();
    } catch (err) {
      setStatus('error', 'Mất kết nối');
      showHint('Không tải được thông tin tài khoản. Vui lòng kiểm tra mạng.', true);
      return;
    }

    // ── Tài xế ──
    window.DRV_USER = me;
    setText('home-user-name', me.fullName || me.username || '—');
    setText('home-user-username', me.username ? '@' + me.username : '');
    setStatus('ok', 'Đang hoạt động');

    // ── Ngày hiện tại (giờ Việt Nam) ──
    renderDate();

    // ── Thống kê + bộ lọc ──
    await loadStats();
  }

  /** Tải số liệu theo tháng/ngày đang chọn. */
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

      // Vỏ: hiện "đã thu" + ghi chú "còn lưu lượng" (giao đi - thu về)
      var netEl = document.getElementById('home-kegs-net');
      if (netEl) {
        var net = data.todayKegsNet || 0;
        netEl.textContent = net > 0 ? 'còn ' + D.num(net) + ' vỏ' : (net < 0 ? 'thừa ' + D.num(Math.abs(net)) + ' vỏ' : '');
        netEl.hidden = net === 0;
      }

      renderMonthLabel(data);
      renderDayList(data);
      renderMonthSummary(data);
      renderStatsTitle(data);
      renderLoad(data);

      showHint('', false);
    } catch (err) {
      setText('home-orders', '—');
      setText('home-liters', '—');
      setText('home-kegs', '—');
      setStatus('error', 'Lỗi tải dữ liệu');
      showHint(
        err && err.rateLimited
          ? 'Máy chủ đang bận, vui lòng thử lại sau.'
          : 'Không tải được số liệu. Vui lòng thử lại.',
        true
      );
    }
  }

  /** Tiêu đề tháng. */
  function renderMonthLabel(data) {
    setText('home-month-label', data.monthLabel || 'Tháng —');
  }

  /** Tiêu đề khu thống kê: "Thống kê hôm nay" hoặc "Thống kê 15/11/2026". */
  function renderStatsTitle(data) {
    var title = document.getElementById('home-stats-title');
    if (!title) return;
    if (data.isToday) {
      title.textContent = 'Thống kê hôm nay';
    } else {
      var parts = String(data.selectedDate || '').split('-');
      title.textContent =
        'Thống kê ' + (parts[2] || '') + '/' + (parts[1] || '') + '/' + (parts[0] || '');
    }
  }

  /** Dải ngày 1..N của tháng (vuông 8 cột trên desktop, 7 trên mobile). */
  function renderDayList(data) {
    var box = document.getElementById('home-day-list');
    if (!box) return;

    var daily = data.daily || [];
    var selected = data.selectedDate || '';
    var today = data.date || '';

    box.innerHTML = daily
      .map(function (d) {
        var cls = 'drv-home-day';
        if (d.date === selected) cls += ' is-selected';
        if (d.date === today) cls += ' is-today';
        if (d.orders || d.liters || d.kegs) cls += ' has-data';

        var hint = '';
        if (d.orders || d.liters || d.kegs) {
          hint =
            '<span class="drv-home-day__tip">' +
            d.orders + ' đơn · ' + D.num(d.liters) + ' lít · ' + D.num(d.kegs) + ' vỏ thu' +
            '</span>';
        }

        return (
          '<button class="' + cls + '" type="button" role="tab" data-date="' + d.date + '"' +
          ' aria-selected="' + (d.date === selected ? 'true' : 'false') + '">' +
          '<span class="drv-home-day__num">' + d.day + '</span>' +
          hint +
          '</button>'
        );
      })
      .join('');

    // Cuộn tới ngày đang chọn
    var sel = box.querySelector('.is-selected');
    if (sel && sel.scrollIntoView) {
      try {
        sel.scrollIntoView({ block: 'nearest', inline: 'center' });
      } catch (_) {
        /* bỏ qua */
      }
    }
  }

  /** Tổng cả tháng. */
  function renderMonthSummary(data) {
    var t = data.monthTotals || {};
    setText('home-sum-orders', D.num(t.orders || 0));
    setText('home-sum-liters', D.num(t.liters || 0));
    setText('home-sum-kegs', D.num(t.kegs || 0));

    var netEl = document.getElementById('home-sum-kegs-net');
    var netWrap = document.getElementById('home-sum-kegs-net-wrap');
    if (netEl) {
      var net = t.kegsNet || 0;
      netEl.textContent = net > 0 ? D.num(net) + ' còn lưu' : '';
      netEl.hidden = net <= 0;
      if (netWrap) netWrap.hidden = net <= 0;
    }
  }

  /** Danh sách loại hàng cần giao hôm nay (loại + số lượng). */
  function renderLoad(data) {
    var list = document.getElementById('home-load-list');
    var section = document.getElementById('home-load-section');
    var sub = document.getElementById('home-load-sub');
    if (!list) return;

    var products = data.pendingProducts || [];
    var sum = data.pendingSummary || {};

    if (!products.length) {
      if (section) section.classList.add('is-empty');
      if (sub) sub.textContent = 'Hết hàng cần giao';
      list.innerHTML =
        '<div class="drv-home-load__empty">' +
        '<span class="drv-home-load__emptyicon" aria-hidden="true">✅</span>' +
        '<span>Đã giao xong hết hàng hôm nay</span>' +
        '</div>';
      return;
    }

    if (section) section.classList.remove('is-empty');

    // Phụ địa tống để chuyển giao
    var orders = sum.orders || products.length;
    if (sub) {
      sub.textContent =
        orders + ' đơn · ' +
        D.num(sum.deliverKegs || 0) + ' vỏ giao · ' +
        D.num(sum.returnKegs || 0) + ' vỏ thu';
    }

    list.innerHTML = products
      .map(function (p) {
        var meta = PRODUCT_META[p.slug] || PRODUCT_META[p.type] || {};
        var icon = meta.icon || '🧺';
        var unit = p.unit || meta.unit || 'lít';

        return (
          '<div class="drv-home-load__item">' +
            '<span class="drv-home-load__icon" aria-hidden="true">' + icon + '</span>' +
            '<span class="drv-home-load__name">' + escapeHtml(p.name) + '</span>' +
            '<span class="drv-home-load__qty">' +
              '<b>' + D.num(p.qty) + '</b>' +
              '<i>' + escapeHtml(unit) + '</i>' +
            '</span>' +
          '</div>'
        );
      })
      .join('');
  }

  /** Escape HTML. */
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Chuyển tháng. */
  async function changeMonth(delta) {
    if (state.busy) return;
    var today = new Date(Date.now() + 7 * 60 * 60 * 1000);
    var cur =
      state.month ||
      today.getUTCFullYear() + '-' + String(today.getUTCMonth() + 1).padStart(2, '0');

    var parts = cur.split('-').map(Number);
    var d = new Date(parts[0], parts[1] - 1 + delta, 1);
    var next =
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');

    state.busy = true;
    state.month = next;
    state.date = null; // về ngày đầu tháng mới
    await loadStats();
    state.busy = false;
  }

  /** Chọn ngày trong tháng. */
  async function selectDate(dateStr) {
    if (state.busy) return;
    state.busy = true;
    state.date = dateStr;
    await loadStats();
    state.busy = false;
  }

  /** Hiển thị ngày hiện tại theo giờ Việt Nam (UTC+7). */
  function renderDate() {
    var now = new Date(Date.now() + 7 * 60 * 60 * 1000);
    var dd = String(now.getUTCDate()).padStart(2, '0');
    var mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    var yyyy = now.getUTCFullYear();
    var wd = WEEKDAYS[now.getUTCDay()];
    setText('home-date', wd + ', ' + dd + '/' + mm + '/' + yyyy);
  }

  /** Trạng thái tài khoản: ok | error */
  function setStatus(kind, text) {
    var box = document.getElementById('home-status');
    if (!box) return;
    box.classList.toggle('is-error', kind === 'error');
    setText('home-status-text', text);
  }

  function showHint(msg, isError) {
    var el = document.getElementById('home-hint');
    if (!el) return;
    if (!msg) {
      el.textContent = '';
      el.classList.remove('is-visible');
      return;
    }
    el.textContent = msg;
    el.classList.add('is-visible');
    el.classList.toggle('is-error', !!isError);
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  // ── Gắn sự kiện ──
  function init() {
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

    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
