/**
 * Driver Portal — TRANG CHỦ (thiết kế lại)
 * ─────────────────────────────────────────────────────────────────────────────
 * Giao diện tối giản, ưu tiên điện thoại:
 *   HEADER  : BIA TƯƠI TÂY NINH · CỔNG TÀI XẾ · tên tài xế · ngày · trạng thái
 *   THỐNG KÊ: Số đơn hôm nay · Số lít hôm nay · Tổng vỏ đã thu hôm nay
 *
 * API: GET /api/driver/home → { date, todayOrders, todayLiters, todayKegs }
 */
(function () {
  'use strict';

  var D = window.Drv;

  var WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

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

    // ── Thống kê hôm nay ──
    try {
      var data = await D.api.get('/api/driver/home');
      setText('home-orders', D.num(data.todayOrders || 0));
      setText('home-liters', D.num(data.todayLiters || 0));
      setText('home-kegs', D.num(data.todayKegs || 0));
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

  load();
})();
