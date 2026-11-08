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
 *        month, monthLabel, daily[], monthTotals, pendingDeliveries[],
 *        pendingDeliveryCount, prevMonth, nextMonth }
 */
(function () {
  'use strict';

  var D = window.Drv;

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

      renderMonthLabel(data);
      renderDayList(data);
      renderMonthSummary(data);
      renderStatsTitle(data);
      renderPending(data);

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
            d.orders + ' đơn · ' + D.num(d.liters) + ' lít · ' + D.num(d.kegs) + ' vỏ' +
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
  }

  /** Trạng thái giao hàng → nhãn + class. */
  var DELIVERY_STATUS = {
    PENDING: { label: 'Chờ giao', cls: 'is-pending' },
    IN_PROGRESS: { label: 'Đang giao', cls: 'is-progress' },
    DELIVERED: { label: 'Đã giao', cls: 'is-delivered' },
    FAILED: { label: 'Thất bại', cls: 'is-failed' },
    DISCREPANCY: { label: 'Sai lệch', cls: 'is-discrepancy' },
  };

  /** Danh sách "Hàng cần giao hôm nay". */
  function renderPending(data) {
    var list = document.getElementById('home-pending-list');
    var section = document.getElementById('home-pending-section');
    var countEl = document.getElementById('home-pending-count');
    if (!list) return;

    var items = data.pendingDeliveries || [];
    var sum = data.pendingSummary || {};
    var products = data.pendingProducts || [];

    if (countEl) countEl.textContent = D.num(items.length);

    // Ẩn section nếu không có hàng cần giao
    if (section) section.classList.toggle('is-empty', items.length === 0);
    if (!items.length) {
      list.innerHTML =
        '<div class="drv-home-pending__empty">' +
        '<span aria-hidden="true">✅</span> Đã giao xong hết hàng hôm nay' +
        '</div>';
      hidePendingExtras();
      return;
    }

    renderPendingSummary(sum);
    renderPendingProducts(products);

    list.innerHTML = items
      .map(function (d) {
        var st = DELIVERY_STATUS[d.delivery_status] || DELIVERY_STATUS.PENDING;

        var kegs = [];
        if (d.deliver_kegs) kegs.push('📦 ' + D.num(d.deliver_kegs) + ' giao');
        if (d.return_kegs) kegs.push('🔄 ' + D.num(d.return_kegs) + ' thu');

        var meta = [];
        if (d.total_liters) meta.push(D.num(d.total_liters) + ' lít');
        if (kegs.length) meta.push(kegs.join(' · '));
        if (d.customer_phone) meta.push('☎ ' + d.customer_phone);

        return (
          '<a class="drv-home-pending__item ' + st.cls + '" href="/driver/giao-hang">' +
            '<div class="drv-home-pending__main">' +
              '<div class="drv-home-pending__top">' +
                '<span class="drv-home-pending__name">' +
                  escapeHtml(d.customer_name || 'Khách lẻ') +
                '</span>' +
                '<span class="drv-home-pending__status">' + st.label + '</span>' +
              '</div>' +
              '<div class="drv-home-pending__meta">' +
                (meta.length ? escapeHtml(meta.join(' · ')) : '') +
              '</div>' +
              '<div class="drv-home-pending__addr">' +
                escapeHtml(d.customer_address || '') +
              '</div>' +
            '</div>' +
            '<div class="drv-home-pending__side">' +
              '<span class="drv-home-pending__total">' +
                D.num(d.total || 0) + ' ₫' +
              '</span>' +
              '<span class="drv-home-pending__go" aria-hidden="true">›</span>' +
            '</div>' +
          '</a>'
        );
      })
      .join('');
  }

  /** Dải tổng hợp: lít / vỏ giao / vỏ thu / đơn. */
  function renderPendingSummary(sum) {
    var box = document.getElementById('home-pending-summary');
    if (box) box.hidden = false;
    setText('home-pending-liters', D.num(sum.liters || 0));
    setText('home-pending-deliver-kegs', D.num(sum.deliverKegs || 0));
    setText('home-pending-return-kegs', D.num(sum.returnKegs || 0));
    setText('home-pending-orders', D.num(sum.orders || 0));
  }

  /** Breakdown sản phẩm cần giao. */
  function renderPendingProducts(products) {
    var box = document.getElementById('home-pending-products');
    if (!box) return;
    if (!products.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = products
      .map(function (p) {
        var unit = p.type === 'keg' ? 'vỏ' : p.type === 'box' ? 'thùng' : 'lít';
        return (
          '<span class="drv-home-pending__chip">' +
            escapeHtml(p.name) +
            ' <b>' + D.num(p.qty) + '</b> ' + unit +
          '</span>'
        );
      })
      .join('');
  }

  /** Ẩn dải tổng hợp + breakdown khi không có hàng. */
  function hidePendingExtras() {
    var sumBox = document.getElementById('home-pending-summary');
    var prodBox = document.getElementById('home-pending-products');
    if (sumBox) sumBox.hidden = true;
    if (prodBox) {
      prodBox.hidden = true;
      prodBox.innerHTML = '';
    }
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
