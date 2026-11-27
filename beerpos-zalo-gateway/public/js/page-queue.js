/* Trang Hang doi + Lich su gui tin. */
(function () {
  'use strict';

  const { esc, fmtDate, toast, statusBadge, modal, confirmDialog } = window.GwUi;

  // ── Hang doi ───────────────────────────────────────────────────────────────
  const qState = { status: '', customerId: '', paymentId: '', page: 1, limit: 25 };

  const QUEUE_TABS = [
    { key: '', label: 'Tất cả' },
    { key: 'queued', label: 'Đang chờ' },
    { key: 'processing', label: 'Đang xử lý' },
    { key: 'retry', label: 'Cần thử lại' },
    { key: 'failed', label: 'Thất bại' },
    { key: 'unknown', label: 'Không xác định' },
  ];

  async function renderQueue(root) {
    root.innerHTML = '<div class="card"><span class="spinner"></span> Đang tải…</div>';
    const d = await window.GwApi.history({
      status: qState.status,
      customerId: qState.customerId,
      paymentId: qState.paymentId,
      page: qState.page,
      limit: qState.limit,
    });

    const rows = d.items
      .map(
        (j) => `
      <tr>
        <td class="mono">${esc(j.id)}</td>
        <td class="mono">${esc(j.paymentId || '—')}</td>
        <td><strong>${esc(j.customerName || '—')}</strong><div class="muted mono">${esc(
          j.customerId
        )}</div></td>
        <td class="mono">${esc(j.groupId)}</td>
        <td>${statusBadge(j.status)}</td>
        <td class="nowrap">${esc(j.attempts)}/${esc(j.maxAttempts)}</td>
        <td class="muted" style="font-size:12px">${fmtDate(j.createdAt)}</td>
        <td class="nowrap">
          <button class="btn btn-sm" data-act="view" data-id="${j.id}">Chi tiết</button>
          ${
            ['failed', 'no_group', 'cancelled'].includes(j.status)
              ? `<button class="btn btn-sm" data-act="retry" data-id="${j.id}">Thử lại</button>`
              : ''
          }
          ${['queued', 'retry'].includes(j.status)
            ? `<button class="btn btn-sm btn-danger" data-act="cancel" data-id="${j.id}">Huỷ</button>`
            : ''}
        </td>
      </tr>`
      )
      .join('');

    const totalPages = Math.max(Math.ceil(d.total / d.limit), 1);

    root.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Hàng đợi thông báo</div>
            <div class="card-sub">Tin đang chờ, đang xử lý, cần thử lại, thất bại và không xác định</div>
          </div>
        </div>

        <div class="tabs">
          ${QUEUE_TABS.map(
            (t) =>
              `<button class="tab ${qState.status === t.key ? 'active' : ''}" data-status="${t.key}">${esc(
                t.label
              )}</button>`
          ).join('')}
        </div>

        <div class="filters">
          <div class="field">
            <label>Customer ID</label>
            <input type="text" id="q-customer" value="${esc(qState.customerId)}" placeholder="KH001">
          </div>
          <div class="field">
            <label>Payment ID</label>
            <input type="text" id="q-payment" value="${esc(qState.paymentId)}" placeholder="PAY001">
          </div>
          <button class="btn" data-act="filter">Tìm</button>
        </div>

        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Job</th><th>Payment ID</th><th>Khách hàng</th><th>Group ID</th>
              <th>Trạng thái</th><th>Thử</th><th>Tạo lúc</th><th>Thao tác</th>
            </tr></thead>
            <tbody>${rows || '<tr><td colspan="8" class="empty">Hàng đợi trống</td></tr>'}</tbody>
          </table>
        </div>

        <div class="pager">
          <div class="pager-info">Tổng ${esc(d.total)} — trang ${esc(d.page)}/${esc(totalPages)}</div>
          <div class="btn-row">
            <button class="btn btn-sm" data-act="prev" ${d.page <= 1 ? 'disabled' : ''}>‹ Trước</button>
            <button class="btn btn-sm" data-act="next" ${d.page >= totalPages ? 'disabled' : ''}>Sau ›</button>
          </div>
        </div>
      </div>`;

    bindQueue(root);
  }

  function bindQueue(root) {
    root.querySelectorAll('[data-status]').forEach((t) =>
      t.addEventListener('click', () => {
        qState.status = t.dataset.status;
        qState.page = 1;
        renderQueue(root);
      })
    );

    const apply = () => {
      qState.customerId = root.querySelector('#q-customer').value.trim();
      qState.paymentId = root.querySelector('#q-payment').value.trim();
      qState.page = 1;
      renderQueue(root);
    };
    root.querySelector('[data-act="filter"]').addEventListener('click', apply);
    root.querySelector('#q-customer').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') apply();
    });
    root.querySelector('#q-payment').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') apply();
    });

    root.querySelectorAll('[data-act="view"]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          const d = await window.GwApi.jobDetail(b.dataset.id);
          const j = d.job;
          const attempts = (d.attempts || [])
            .map(
              (a) => `<tr>
                <td>${esc(a.id)}</td><td>${esc(a.provider)}</td>
                <td>${statusBadge(a.status)}</td>
                <td class="muted">${esc(a.errorMessage || '—')}</td>
                <td class="muted" style="font-size:12px">${fmtDate(a.startedAt)}</td>
              </tr>`
            )
            .join('');

          await modal({
            title: `Chi tiết job #${j.id}`,
            large: true,
            body: `
              <dl class="def-list">
                <dt>Message ID</dt><dd class="mono">${esc(j.id)}</dd>
                <dt>Payment ID</dt><dd class="mono">${esc(j.paymentId || '—')}</dd>
                <dt>Customer ID</dt><dd class="mono">${esc(j.customerId)}</dd>
                <dt>Group ID</dt><dd class="mono">${esc(j.groupId)}</dd>
                <dt>Nội dung</dt><dd>${esc(j.messageContent)}</dd>
                <dt>Thời gian tạo</dt><dd>${fmtDate(j.createdAt)}</dd>
                <dt>Thời gian xử lý</dt><dd>${fmtDate(j.processedAt)}</dd>
                <dt>Số lần thử</dt><dd>${esc(j.attempts)} / ${esc(j.maxAttempts)}</dd>
                <dt>Provider</dt><dd>${esc(j.provider)}</dd>
                <dt>Trạng thái</dt><dd>${statusBadge(j.status)}</dd>
                <dt>Kết quả provider</dt><dd class="mono" style="font-size:11.5px">${esc(
                  j.providerResponse ? JSON.stringify(j.providerResponse) : '—'
                )}</dd>
                <dt>Lỗi gần nhất</dt><dd style="color:${j.lastError ? 'var(--red)' : 'inherit'}">${esc(
                  j.lastError || '—'
                )}</dd>
              </dl>
              <div class="card-title mt-16" style="margin-bottom:8px">Các lần thử gửi</div>
              <div class="table-wrap"><table>
                <thead><tr><th>#</th><th>Provider</th><th>Trạng thái</th><th>Lỗi</th><th>Bắt đầu</th></tr></thead>
                <tbody>${attempts || '<tr><td colspan="5" class="empty">Chưa có lần thử nào</td></tr>'}</tbody>
              </table></div>`,
            okText: 'Đóng',
            cancelText: 'Đóng',
          });
        } catch (e) {
          toast(e.message, 'error');
        }
      })
    );

    root.querySelectorAll('[data-act="retry"]').forEach((b) =>
      b.addEventListener('click', async () => {
        const ok = await confirmDialog(
          'Thử lại',
          'Job sẽ được đưa lại hàng đợi. Tin nhắn có thể được gửi lại lần nữa.',
          'Thử lại'
        );
        if (!ok) return;
        try {
          await window.GwApi.retryJob(b.dataset.id);
          toast('Đã đưa job về hàng đợi');
          renderQueue(root);
        } catch (e) {
          toast(e.message, 'error');
        }
      })
    );

    root.querySelectorAll('[data-act="cancel"]').forEach((b) =>
      b.addEventListener('click', async () => {
        const ok = await confirmDialog('Huỷ tin', 'Tin đang chờ sẽ không được gửi.', 'Huỷ tin');
        if (!ok) return;
        try {
          await window.GwApi.cancelJob(b.dataset.id);
          toast('Đã huỷ tin');
          renderQueue(root);
        } catch (e) {
          toast(e.message, 'error');
        }
      })
    );

    root.querySelector('[data-act="prev"]').addEventListener('click', () => {
      qState.page = Math.max(1, qState.page - 1);
      renderQueue(root);
    });
    root.querySelector('[data-act="next"]').addEventListener('click', () => {
      qState.page += 1;
      renderQueue(root);
    });
  }

  // ── Lich su ────────────────────────────────────────────────────────────────
  const hState = { status: '', customerId: '', from: '', to: '', page: 1, limit: 25 };

  async function renderHistory(root) {
    root.innerHTML = '<div class="card"><span class="spinner"></span> Đang tải…</div>';
    const d = await window.GwApi.history({
      status: hState.status,
      customerId: hState.customerId,
      from: hState.from,
      to: hState.to,
      page: hState.page,
      limit: hState.limit,
    });

    const rows = d.items
      .map(
        (j) => `
      <tr>
        <td class="muted" style="font-size:12px">${fmtDate(j.createdAt)}</td>
        <td><strong>${esc(j.customerName || '—')}</strong><div class="muted mono">${esc(
          j.customerId
        )}</div></td>
        <td class="truncate">${esc(j.messageContent)}</td>
        <td>${statusBadge(j.status)}</td>
        <td class="muted" style="font-size:12px">${esc(j.lastError || '—')}</td>
      </tr>`
      )
      .join('');

    const totalPages = Math.max(Math.ceil(d.total / d.limit), 1);

    root.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Lịch sử gửi tin</div>
            <div class="card-sub">Mỗi lần thử gửi đều được ghi lại</div>
          </div>
        </div>

        <div class="filters">
          <div class="field">
            <label>Trạng thái</label>
            <select id="h-status">
              <option value="" ${hState.status === '' ? 'selected' : ''}>Tất cả</option>
              <option value="queued" ${hState.status === 'queued' ? 'selected' : ''}>Đang chờ</option>
              <option value="processing" ${hState.status === 'processing' ? 'selected' : ''}>Đang xử lý</option>
              <option value="sent" ${hState.status === 'sent' ? 'selected' : ''}>Thành công qua Provider</option>
              <option value="failed" ${hState.status === 'failed' ? 'selected' : ''}>Thất bại</option>
              <option value="unknown" ${hState.status === 'unknown' ? 'selected' : ''}>Không xác định</option>
            </select>
          </div>
          <div class="field">
            <label>Khách hàng (Customer ID)</label>
            <input type="text" id="h-customer" value="${esc(hState.customerId)}">
          </div>
          <div class="field">
            <label>Từ ngày</label>
            <input type="text" id="h-from" value="${esc(hState.from)}" placeholder="YYYY-MM-DD">
          </div>
          <div class="field">
            <label>Đến ngày</label>
            <input type="text" id="h-to" value="${esc(hState.to)}" placeholder="YYYY-MM-DD">
          </div>
          <button class="btn" data-act="filter">Lọc</button>
        </div>

        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Thời gian</th><th>Khách hàng</th><th>Nội dung</th><th>Trạng thái</th><th>Lỗi gần nhất</th>
            </tr></thead>
            <tbody>${rows || '<tr><td colspan="5" class="empty">Chưa có lịch sử</td></tr>'}</tbody>
          </table>
        </div>

        <div class="pager">
          <div class="pager-info">Tổng ${esc(d.total)} — trang ${esc(d.page)}/${esc(totalPages)}</div>
          <div class="btn-row">
            <button class="btn btn-sm" data-act="prev" ${d.page <= 1 ? 'disabled' : ''}>‹ Trước</button>
            <button class="btn btn-sm" data-act="next" ${d.page >= totalPages ? 'disabled' : ''}>Sau ›</button>
          </div>
        </div>
      </div>`;

    root.querySelector('[data-act="filter"]').addEventListener('click', () => {
      hState.status = root.querySelector('#h-status').value;
      hState.customerId = root.querySelector('#h-customer').value.trim();
      hState.from = root.querySelector('#h-from').value.trim();
      hState.to = root.querySelector('#h-to').value.trim();
      hState.page = 1;
      renderHistory(root);
    });
    root.querySelector('[data-act="prev"]').addEventListener('click', () => {
      hState.page = Math.max(1, hState.page - 1);
      renderHistory(root);
    });
    root.querySelector('[data-act="next"]').addEventListener('click', () => {
      hState.page += 1;
      renderHistory(root);
    });
  }

  window.GwPages = window.GwPages || {};
  window.GwPages.queue = renderQueue;
  window.GwPages.history = renderHistory;
})();
