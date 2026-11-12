/**
 * Driver Portal — PHIẾU THU VỎ (trang chụp màn hình / in)
 * ─────────────────────────────────────────────────────────────────────────────
 * Trang riêng hiển thị PHIẾU THU VỎ dạng "hoá đơn" — nền trắng, dễ chụp
 * màn hình và gửi khách hàng (Zalo/SMS), hoặc in ra giấy.
 *
 * URL: /driver/phieu-thu-vo?id=<receiptId>
 */

(function () {
  'use strict';

  var D = window.Drv;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  function num(n) {
    return new Intl.NumberFormat('vi-VN').format(Number(n) || 0);
  }

  function timeLabel(iso) {
    if (!iso) return '—';
    var d = new Date(String(iso).replace(' ', 'T'));
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('vi-VN', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function dateLabel(iso) {
    if (!iso) return '—';
    var d = new Date(String(iso).replace(' ', 'T'));
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('vi-VN', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
   * Markup phiếu — giống hoá đơn: tiêu đề, thông tin, số vỏ, chữ ký
   * ═══════════════════════════════════════════════════════════════════ */
  function receiptHtml(r) {
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

  function toolbarHtml() {
    return '' +
      '<div class="rp-hint" id="rp-hint">' +
        '<span class="rp-hint__icon">📸</span>' +
        '<span class="rp-hint__text">Chụp màn hình phần phiếu bên dưới để gửi khách</span>' +
        '<button type="button" class="rp-hint__close" id="rp-hint-close" aria-label="Đóng">×</button>' +
      '</div>' +
      '<div class="rp-toolbar" id="rp-toolbar">' +
        '<button type="button" class="rp-tbtn" id="rp-back" aria-label="Quay lại">←</button>' +
        '<button type="button" class="rp-tbtn rp-tbtn--wide" id="rp-copy">📋 Copy</button>' +
        '<button type="button" class="rp-tbtn rp-tbtn--wide" id="rp-share">📤 Chia sẻ</button>' +
        '<button type="button" class="rp-tbtn rp-tbtn--wide" id="rp-print">🖨️ In</button>' +
      '</div>';
  }

  function receiptText(r) {
    return (
      'PHIẾU THU VỎ — BIA TƯƠI TÂY NINH\n' +
      'Số phiếu: ' + r.receipt_no + '\n' +
      'Khách hàng: ' + (r.customer_name || '—') +
      (r.customer_phone ? ' (' + r.customer_phone + ')' : '') +
      (r.customer_address ? '\nĐịa chỉ: ' + r.customer_address : '') + '\n' +
      'Ngày: ' + dateLabel(r.created_at) + ' — ' + timeLabel(r.created_at) + '\n' +
      'Tài xế: ' + r.driver_username + '\n' +
      'Số vỏ thu về: ' + r.kegs + ' vỏ\n' +
      'Vỏ khách còn giữ: ' + r.balance_before + ' → ' + r.balance_after + ' vỏ' +
      (r.note ? '\nGhi chú: ' + r.note : '')
    );
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  async function init() {
    var app = document.getElementById('app');
    var id = parseInt(new URLSearchParams(location.search).get('id') || '', 10);

    if (!id || isNaN(id)) {
      app.innerHTML = '<div class="rp-loading">❌ Không tìm thấy phiếu.</div>';
      return;
    }

    var receipt;
    try {
      var res = await D.api.kegReceipt(id);
      receipt = res.receipt;
    } catch (err) {
      app.innerHTML = '<div class="rp-loading">❌ ' + esc(err.message || 'Lỗi tải phiếu') + '</div>';
      return;
    }
    if (!receipt) {
      app.innerHTML = '<div class="rp-loading">❌ Không tìm thấy phiếu.</div>';
      return;
    }

    document.title = 'Phiếu ' + receipt.receipt_no + ' — Bia Tươi Tây Ninh';
    app.innerHTML = receiptHtml(receipt) + toolbarHtml();

    document.getElementById('rp-back').addEventListener('click', function () {
      if (history.length > 1) history.back();
      else location.href = '/driver';
    });

    document.getElementById('rp-print').addEventListener('click', function () {
      window.print();
    });

    // Chia sẻ: Web Share API (điện thoại) → gửi ảnh/text cho khách
    document.getElementById('rp-share').addEventListener('click', function () {
      var title = 'Phiếu thu vỏ ' + receipt.receipt_no + ' — Bia Tươi Tây Ninh';
      var text = receiptText(receipt);
      if (navigator.share) {
        navigator.share({ title: title, text: text }).catch(function () { /* user huỷ */ });
      } else {
        copyText(text).then(function () {
          D.toast('Máy không hỗ trợ chia sẻ — đã copy nội dung phiếu', 'success');
        });
      }
    });

    // Đóng gợi ý chụp màn hình
    var hintClose = document.getElementById('rp-hint-close');
    if (hintClose) {
      hintClose.addEventListener('click', function () {
        var h = document.getElementById('rp-hint');
        if (h) h.remove();
      });
    }

    document.getElementById('rp-copy').addEventListener('click', function () {
      copyText(receiptText(receipt)).then(function () {
        D.toast('Đã copy nội dung phiếu', 'success');
      }).catch(function () {
        D.toast('Không copy được — hãy chụp ảnh phiếu', 'warning');
      });
    });

    // Tự ẩn thanh công cụ khi in
    window.addEventListener('beforeprint', function () {
      var tb = document.getElementById('rp-toolbar');
      if (tb) tb.style.display = 'none';
    });
    window.addEventListener('afterprint', function () {
      var tb = document.getElementById('rp-toolbar');
      if (tb) tb.style.display = '';
    });

    // Ẩn thanh công cụ khi cuộn xuống (tài xế chụp màn hình → không vướng nút)
    var lastY = 0;
    window.addEventListener('scroll', function () {
      var tb = document.getElementById('rp-toolbar');
      if (!tb) return;
      var y = window.scrollY;
      if (y > lastY && y > 120) tb.classList.add('is-hidden');
      else tb.classList.remove('is-hidden');
      lastY = y;
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
