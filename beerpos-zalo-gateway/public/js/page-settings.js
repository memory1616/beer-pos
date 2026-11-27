/* Trang Cau hinh + Audit log. */
(function () {
  'use strict';

  const { esc, fmtDate, toast } = window.GwUi;

  const EDITABLE = [
    'provider',
    'worker_enabled',
    'worker_interval_ms',
    'worker_max_attempts',
    'retry_delays_ms',
    'max_message_length',
    'title',
  ];

  async function renderSettings(root) {
    root.innerHTML = '<div class="card"><span class="spinner"></span> Đang tải…</div>';
    const d = await window.GwApi.settings();
    const s = d.settings || {};

    const rows = EDITABLE.map(
      (k) => `
      <tr>
        <td class="mono">${esc(k)}</td>
        <td><input type="text" data-setting="${esc(k)}" value="${esc(s[k] === undefined ? '' : s[k])}"></td>
        <td class="nowrap"><button class="btn btn-sm" data-act="save" data-key="${esc(k)}">Lưu</button></td>
      </tr>`
    ).join('');

    root.innerHTML = `
      <div class="alert alert-info">
        API key KHÔNG lưu trong database — nằm trong biến môi trường
        (<span class="mono">ADMIN_API_KEY</span>, <span class="mono">INTEGRATION_API_KEY</span>).
        Rotate key bằng cách đổi biến môi trường rồi khởi động lại Gateway.
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Cấu hình Gateway</div>
            <div class="card-sub">Chỉ cấu hình không nhạy cảm</div>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Key</th><th>Giá trị</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Nhật ký thao tác (Audit)</div></div>
        <div id="audit-holder"><span class="spinner"></span></div>
      </div>`;

    root.querySelectorAll('[data-act="save"]').forEach((b) =>
      b.addEventListener('click', async () => {
        const key = b.dataset.key;
        const input = root.querySelector(`[data-setting="${key}"]`);
        try {
          await window.GwApi.updateSetting(key, input.value);
          toast(`Đã lưu ${key}`);
        } catch (e) {
          toast(e.message, 'error');
        }
      })
    );

    loadAudit(root.querySelector('#audit-holder'));
  }

  async function loadAudit(host) {
    if (!host) return;
    try {
      const d = await window.GwApi.auditLogs({ limit: 100 });
      const rows = d.items
        .map(
          (a) => `
        <tr>
          <td class="muted" style="font-size:12px">${fmtDate(a.created_at)}</td>
          <td class="mono">${esc(a.action)}</td>
          <td>${esc(a.entity_type || '—')}</td>
          <td class="mono">${esc(a.entity_id || '—')}</td>
          <td class="muted mono truncate" style="font-size:11.5px">${esc(a.details || '—')}</td>
        </tr>`
        )
        .join('');
      host.innerHTML = `
        <div class="table-wrap" style="max-height:420px;overflow-y:auto">
          <table>
            <thead><tr><th>Thời gian</th><th>Hành động</th><th>Loại</th><th>Đối tượng</th><th>Chi tiết</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5" class="empty">Chưa có nhật ký</td></tr>'}</tbody>
          </table>
        </div>`;
    } catch (e) {
      host.innerHTML = `<div class="alert alert-danger">${esc(e.message)}</div>`;
    }
  }

  window.GwPages = window.GwPages || {};
  window.GwPages.settings = renderSettings;
})();
