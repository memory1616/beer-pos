/* Helpers UI: escape, format, toast, modal. */
(function () {
  'use strict';

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtDate(v) {
    if (!v) return '—';
    const d = new Date(String(v).replace(' ', 'T'));
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function toast(msg, type) {
    const host = document.getElementById('toast-host');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (type === 'error' ? 'toast-error' : 'toast-success');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 220);
    }, 3200);
  }

  function statusBadge(status) {
    const map = {
      queued: ['badge-info', 'Đang chờ'],
      processing: ['badge-info', 'Đang xử lý'],
      sent: ['badge-success', 'Đã chấp nhận'],
      retry: ['badge-warning', 'Chờ thử lại'],
      failed: ['badge-danger', 'Thất bại'],
      unknown: ['badge-warning', 'Không xác định'],
      no_group: ['badge-neutral', 'Chưa có nhóm'],
      cancelled: ['badge-neutral', 'Đã hủy'],
      active: ['badge-success', 'Đã liên kết'],
      inactive: ['badge-neutral', 'Ngừng hoạt động'],
      sent_mock: ['badge-mock', 'MOCK'],
    };
    const found = map[status] || ['badge-neutral', status || '—'];
    return `<span class="badge ${found[0]}">${esc(found[1])}</span>`;
  }

  /** Mo modal. Tra Promise resolve khi bam nut xac nhan. */
  function modal(opts) {
    const host = document.getElementById('modal-host');
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-backdrop';
      wrap.innerHTML = `
        <div class="modal ${opts.large ? 'modal-lg' : ''}">
          <div class="modal-header">
            <div class="modal-title">${esc(opts.title || '')}</div>
            <button class="modal-close" data-act="cancel">&times;</button>
          </div>
          <div class="modal-body">${opts.body || ''}</div>
          <div class="modal-footer">
            <button class="btn" data-act="cancel">${esc(opts.cancelText || 'Đóng')}</button>
            <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">
              ${esc(opts.okText || 'Xác nhận')}
            </button>
          </div>
        </div>`;
      host.appendChild(wrap);

      const close = (val) => {
        wrap.remove();
        resolve(val);
      };
      wrap.querySelectorAll('[data-act="cancel"]').forEach((b) =>
        b.addEventListener('click', () => close(null))
      );
      wrap.querySelector('[data-act="ok"]').addEventListener('click', () => {
        if (opts.onOk) {
          const r = opts.onOk(wrap);
          if (r && typeof r.then === 'function') {
            r.then((v) => { if (v !== false) close(v); });
            return;
          }
        }
        close(true);
      });
      wrap.addEventListener('click', (e) => {
        if (e.target === wrap) close(null);
      });
    });
  }

  function confirmDialog(title, message, okText) {
    return modal({
      title,
      body: `<p style="font-size:13.5px">${esc(message)}</p>`,
      okText: okText || 'Xác nhận',
      danger: true,
    });
  }

  window.GwUi = { esc, fmtDate, toast, statusBadge, modal, confirmDialog };
})();
