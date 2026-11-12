/**
 * Driver Portal — PHIẾU THU VỎ (trang riêng để in / chia sẻ)
 * ─────────────────────────────────────────────────────────────────────────────
 * URL: /driver/phieu-thu-vo?id=<receiptId>
 *
 * Ghi chú: nút "In / Chụp phiếu" trong Cổng Tài xế giờ mở MODAL ngay trong
 * trang (xem keg-receipt.js). Trang này giữ lại làm bản "dùng riêng" —
 * mở được trực tiếp từ link, in ra giấy, hoặc chia sẻ link.
 */

(function () {
  'use strict';

  var D = window.Drv;
  var R = window.DrvReceipt;

  function esc(s) {
    return R.esc(s);
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
    app.innerHTML = R.paperHtml(receipt) + toolbarHtml();

    document.getElementById('rp-back').addEventListener('click', function () {
      if (history.length > 1) history.back();
      else location.href = '/driver';
    });

    document.getElementById('rp-print').addEventListener('click', function () {
      window.print();
    });

    document.getElementById('rp-share').addEventListener('click', function () {
      var title = 'Phiếu thu vỏ ' + receipt.receipt_no + ' — Bia Tươi Tây Ninh';
      var body = R.text(receipt);
      if (navigator.share) {
        navigator.share({ title: title, text: body }).catch(function () { /* huỷ */ });
      } else {
        copyText(body).then(function () {
          D.toast('Máy không hỗ trợ chia sẻ — đã copy nội dung phiếu', 'success');
        });
      }
    });

    document.getElementById('rp-copy').addEventListener('click', function () {
      copyText(R.text(receipt)).then(function () {
        D.toast('Đã copy nội dung phiếu', 'success');
      }).catch(function () {
        D.toast('Không copy được — hãy chụp ảnh phiếu', 'warning');
      });
    });

    var hintClose = document.getElementById('rp-hint-close');
    if (hintClose) {
      hintClose.addEventListener('click', function () {
        var h = document.getElementById('rp-hint');
        if (h) h.remove();
      });
    }

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
