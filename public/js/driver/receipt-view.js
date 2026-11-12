/**
 * Driver Portal — PHIẾU THU VỎ (dùng chung)
 * ─────────────────────────────────────────────────────────────────────────────
 * Cung cấp:
 *   window.DrvReceipt.paperHtml(receipt)  → markup tờ phiếu dạng hoá đơn
 *   window.DrvReceipt.text(receipt)       → nội dung text để copy / chia sẻ
 *   window.DrvReceipt.open(receipt)       → mở MODAL phiếu ngay trên trang
 *
 * Trang /driver/phieu-thu-vo (receipt-print.js) dùng lại module này để
 * render tờ phiếu dạng trang, nên markup chỉ có 1 nguồn duy nhất.
 */

(function () {
  'use strict';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  function num(n) {
    return new Intl.NumberFormat('vi-VN').format(Number(n) || 0);
  }

  function parseDate(iso) {
    if (!iso) return null;
    var d = new Date(String(iso).replace(' ', 'T'));
    return isNaN(d.getTime()) ? null : d;
  }

  function timeLabel(iso) {
    var d = parseDate(iso);
    if (!d) return iso ? String(iso) : '—';
    return d.toLocaleString('vi-VN', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function dateLabel(iso) {
    var d = parseDate(iso);
    if (!d) return iso ? String(iso) : '—';
    return d.toLocaleDateString('vi-VN', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Markup tờ phiếu — giống hoá đơn
   * ═══════════════════════════════════════════════════════════════════ */
  function paperHtml(r) {
    if (!r) return '';
    return '' +
      '<article class="rp-paper" id="rp-paper">' +

        '<header class="rp-head">' +
          '<div class="rp-brand">' +
            '<div class="rp-brand__logo">🍺</div>' +
            '<div>' +
              '<div class="rp-brand__name">BIA TƯƠI TÂY NINH</div>' +
              '<div class="rp-brand__sub">Cổng Tài xế · Phiếu giao nhận</div>' +
            '</div>' +
          '</div>' +
          '<h1 class="rp-title">PHIẾU THU VỎ</h1>' +
          '<div class="rp-no">Số phiếu: <b>' + esc(r.receipt_no) + '</b></div>' +
        '</header>' +

        '<section class="rp-block">' +
          '<div class="rp-block__label">THÔNG TIN KHÁCH HÀNG</div>' +
          '<dl class="rp-grid">' +
            '<dt>Khách hàng</dt><dd class="rp-strong">' + esc(r.customer_name || '—') + '</dd>' +
            (r.customer_phone
              ? '<dt>Số điện thoại</dt><dd>' + esc(r.customer_phone) + '</dd>' : '') +
            (r.customer_address
              ? '<dt>Địa chỉ</dt><dd>' + esc(r.customer_address) + '</dd>' : '') +
          '</dl>' +
        '</section>' +

        '<section class="rp-block">' +
          '<div class="rp-block__label">THÔNG TIN PHIẾU</div>' +
          '<dl class="rp-grid">' +
            '<dt>Ngày lập phiếu</dt><dd>' + esc(dateLabel(r.created_at)) + '</dd>' +
            '<dt>Thời gian</dt><dd>' + esc(timeLabel(r.created_at)) + '</dd>' +
            '<dt>Tài xế</dt><dd>' + esc(r.driver_username) + '</dd>' +
          '</dl>' +
        '</section>' +

        '<section class="rp-amount">' +
          '<span>Số vỏ thu về</span>' +
          '<b>' + num(r.kegs) + ' <i>vỏ</i></b>' +
        '</section>' +

        '<section class="rp-block">' +
          '<div class="rp-block__label">TỒN VỎ KHÁCH ĐANG GIỮ</div>' +
          '<div class="rp-balance">' +
            '<div class="rp-balance__item">' +
              '<span>Trước khi thu</span><b>' + num(r.balance_before) + '</b>' +
            '</div>' +
            '<div class="rp-balance__arrow">→</div>' +
            '<div class="rp-balance__item">' +
              '<span>Sau khi thu</span><b>' + num(r.balance_after) + '</b>' +
            '</div>' +
          '</div>' +
        '</section>' +

        (r.note
          ? '<section class="rp-note">📝 ' + esc(r.note) + '</section>'
          : '') +

        '<section class="rp-sign">' +
          '<div class="rp-sign__col">' +
            '<div class="rp-sign__label">Tài xế</div>' +
            '<div class="rp-sign__line"></div>' +
            '<div class="rp-sign__name">' + esc(r.driver_username) + '</div>' +
          '</div>' +
          '<div class="rp-sign__col">' +
            '<div class="rp-sign__label">Khách hàng</div>' +
            '<div class="rp-sign__line"></div>' +
            '<div class="rp-sign__name">Khách hàng</div>' +
          '</div>' +
        '</section>' +

        '<footer class="rp-foot">' +
          'Phiếu được lập tự động từ Cổng Tài xế — Bia Tươi Tây Ninh' +
        '</footer>' +
      '</article>';
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Nội dung text (copy / chia sẻ)
   * ═══════════════════════════════════════════════════════════════════ */
  function text(r) {
    if (!r) return '';
    return (
      'PHIẾU THU VỎ — BIA TƯƠI TÂY NINH\n' +
      'Số phiếu: ' + r.receipt_no + '\n' +
      'Khách hàng: ' + (r.customer_name || '—') +
      (r.customer_phone ? ' (' + r.customer_phone + ')' : '') +
      (r.customer_address ? '\nĐịa chỉ: ' + r.customer_address : '') + '\n' +
      'Ngày: ' + dateLabel(r.created_at) + ' — ' + timeLabel(r.created_at) + '\n' +
      'Tài xế: ' + r.driver_username + '\n' +
      'Số vỏ thu về: ' + num(r.kegs) + ' vỏ\n' +
      'Vỏ khách còn giữ: ' + num(r.balance_before) + ' → ' + num(r.balance_after) + ' vỏ' +
      (r.note ? '\nGhi chú: ' + r.note : '') +
      '\n\n— Tài xế: ____________    Khách hàng: ____________'
    );
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Modal phiếu — mở NGAY TRONG TRANG hiện tại (không mở tab mới)
   * ═══════════════════════════════════════════════════════════════════ */
  function close() {
    var m = document.getElementById('rp-modal');
    if (m) m.remove();
    document.body.style.overflow = '';
    document.body.classList.remove('rp-modal-open');
  }

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t);
    }
    var ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  function toast(msg, type) {
    if (window.Drv && typeof window.Drv.toast === 'function') {
      window.Drv.toast(msg, type || 'success');
      return;
    }
    if (typeof window.toast === 'function') {
      window.toast(msg, type);
    }
  }

  function open(r) {
    if (!r) return;
    close();

    var wrap = document.createElement('div');
    wrap.className = 'rp-modal';
    wrap.id = 'rp-modal';
    wrap.innerHTML =
      '<div class="rp-modal__panel" role="dialog" aria-modal="true" aria-label="Phiếu thu vỏ">' +
        '<div class="rp-modal__top">' +
          '<span class="rp-modal__title">Phiếu ' + esc(r.receipt_no || '') + '</span>' +
          '<button type="button" class="rp-modal__close" id="rp-modal-close" aria-label="Đóng">&times;</button>' +
        '</div>' +
        '<div class="rp-modal__scroll">' +
          '<div class="rp-modal__hint">📸 Chụp màn hình phần phiếu bên dưới để gửi khách</div>' +
          paperHtml(r) +
        '</div>' +
        '<div class="rp-modal__bar">' +
          '<button type="button" class="rp-tbtn" id="rp-copy">📋 Copy</button>' +
          '<button type="button" class="rp-tbtn" id="rp-share">📤 Chia sẻ</button>' +
          '<button type="button" class="rp-tbtn" id="rp-print">🖨️ In</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(wrap);
    document.body.style.overflow = 'hidden';
    document.body.classList.add('rp-modal-open');

    // Chạm nền ngoài → đóng
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap) close();
    });

    document.getElementById('rp-modal-close').addEventListener('click', close);

    document.getElementById('rp-copy').addEventListener('click', function () {
      copyText(text(r)).then(function () {
        toast('Đã copy nội dung phiếu', 'success');
      }).catch(function () {
        toast('Không copy được — hãy chụp ảnh phiếu', 'warning');
      });
    });

    document.getElementById('rp-share').addEventListener('click', function () {
      var title = 'Phiếu thu vỏ ' + (r.receipt_no || '') + ' — Bia Tươi Tây Ninh';
      var body = text(r);
      if (navigator.share) {
        navigator.share({ title: title, text: body }).catch(function () { /* huỷ */ });
      } else {
        copyText(body).then(function () {
          toast('Máy không hỗ trợ chia sẻ — đã copy nội dung phiếu', 'success');
        });
      }
    });

    document.getElementById('rp-print').addEventListener('click', function () {
      window.print();
    });

    // Đóng bằng phím Esc
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', onEsc);
      }
    });

    return wrap;
  }

  window.DrvReceipt = {
    paperHtml: paperHtml,
    text: text,
    open: open,
    close: close,
    esc: esc,
    num: num,
    timeLabel: timeLabel,
    dateLabel: dateLabel
  };
})();
