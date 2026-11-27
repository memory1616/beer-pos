/* Import CSV: chon file -> xem truoc -> xac nhan. */
(function () {
  'use strict';

  const { esc, toast, modal } = window.GwUi;

  async function open(root, refresh) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="field">
        <label>Chọn file CSV</label>
        <input type="file" id="csv-file" accept=".csv,text/csv">
      </div>
      <p class="muted" style="font-size:12px">
        Cột bắt buộc: <span class="mono">customerId</span>, <span class="mono">groupId</span>.
        Cột tuỳ chọn: <span class="mono">customerName</span>, <span class="mono">groupName</span>, <span class="mono">note</span>.
      </p>
      <div id="csv-preview"></div>`;

    const ok = await modal({
      title: 'Import danh sách nhóm',
      body: wrap.innerHTML,
      okText: 'Xem trước',
      cancelText: 'Huỷ',
      onOk: async (m) => {
        const input = m.querySelector('#csv-file');
        if (!input || !input.files || !input.files[0]) {
          toast('Chưa chọn file CSV', 'error');
          return false;
        }
        const text = await input.files[0].text();
        const res = await window.GwApi.previewImport(text);
        renderPreview(m.querySelector('#csv-preview'), res, text);
        // Đổi nút xác nhận sang "Import thật".
        const btn = m.querySelector('[data-act="ok"]');
        btn.textContent = 'Xác nhận import';
        btn.dataset.csv = text;
        btn.dataset.ready = '1';
        return false;
      },
    });

    // Nút xac nhan import that (2 lan bam).
    const host = document.getElementById('modal-host');
    const btn = host.querySelector('[data-act="ok"]');
    if (!btn) return;
    const originalHandler = btn.onclick;
    btn.onclick = null;
    btn.addEventListener('click', async () => {
      if (btn.dataset.ready !== '1') return;
      const text = btn.dataset.csv;
      const confirmed = await window.GwUi.confirmDialog(
        'Xác nhận import',
        'Dữ liệu hợp lệ sẽ được ghi. Dòng lỗi bị bỏ qua. Import chạy trong 1 transaction.',
        'Import'
      );
      if (!confirmed) return;
      try {
        const res = await window.GwApi.importCsv(text, false);
        toast(`Import xong: ${res.inserted} thành công, ${res.invalid} bỏ qua`);
        host.innerHTML = '';
        if (refresh) refresh();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    if (originalHandler) btn.onclick = originalHandler;
  }

  function renderPreview(host, res, text) {
    if (!host) return;
    const errs = res.errors || [];
    host.innerHTML = `
      <div class="alert ${errs.length ? 'alert-warning' : 'alert-success'}" style="margin-top:14px">
        Tổng ${esc(res.total)} dòng — hợp lệ <strong>${esc(res.valid)}</strong> —
        lỗi <strong>${esc(res.invalid)}</strong>
      </div>
      ${
        errs.length
          ? `<div class="table-wrap" style="max-height:220px;overflow-y:auto">
             <table><thead><tr><th>Dòng</th><th>Customer ID</th><th>Lỗi</th></tr></thead>
             <tbody>${errs
               .map(
                 (e) =>
                   `<tr><td>${esc(e.line || '—')}</td><td class="mono">${esc(
                     e.customerId || '—'
                   )}</td><td>${esc(e.message || e.error || '')}</td></tr>`
               )
               .join('')}</tbody></table></div>`
          : ''
      }`;
  }

  window.GwImport = { open };
})();
