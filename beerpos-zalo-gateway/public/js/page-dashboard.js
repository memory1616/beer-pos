/* Trang Dashboard + Ket noi tai khoan. */
(function () {
  'use strict';

  const { esc, fmtDate, toast, statusBadge } = window.GwUi;

  async function renderDashboard(root) {
    root.innerHTML = '<div class="card"><span class="spinner"></span> Đang tải…</div>';
    const d = await window.GwApi.dashboard();

    const sim =
      d.provider && d.provider.simulated
        ? '<div class="alert alert-warning"><strong>Chế độ MÔ PHỎNG (Mock).</strong> Tin nhắn KHÔNG được gửi tới Zalo thật. Chưa cấu hình nhà cung cấp Zalo được cấp quyền.</div>'
        : '';

    const j = d.jobs || {};
    root.innerHTML = `
      ${sim}
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-label">Nhóm đã liên kết</div>
          <div class="stat-value">${esc(d.groups.active)}</div>
          <div class="stat-hint">Tổng ${esc(d.groups.total)} liên kết</div>
        </div>
        <div class="stat">
          <div class="stat-label">Khách hàng liên kết</div>
          <div class="stat-value blue">${esc(d.groups.customers)}</div>
          <div class="stat-hint">Mỗi khách 1 nhóm duy nhất</div>
        </div>
        <div class="stat">
          <div class="stat-label">Tin đang chờ</div>
          <div class="stat-value orange">${esc(j.queued || 0)}</div>
          <div class="stat-hint">Chờ worker xử lý</div>
        </div>
        <div class="stat">
          <div class="stat-label">Tin đang xử lý</div>
          <div class="stat-value blue">${esc(j.processing || 0)}</div>
          <div class="stat-hint">Worker đang giữ lease</div>
        </div>
        <div class="stat">
          <div class="stat-label">Đã chấp nhận qua Provider</div>
          <div class="stat-value green">${esc(j.sent || 0)}</div>
          <div class="stat-hint">Provider đã nhận, chưa xác nhận giao</div>
        </div>
        <div class="stat">
          <div class="stat-label">Tin thất bại</div>
          <div class="stat-value red">${esc(j.failed || 0)}</div>
          <div class="stat-hint">Cần kiểm tra</div>
        </div>
        <div class="stat">
          <div class="stat-label">Chờ thử lại</div>
          <div class="stat-value orange">${esc(j.retry || 0)}</div>
          <div class="stat-hint">Backoff tự động</div>
        </div>
        <div class="stat">
          <div class="stat-label">Cần kiểm tra</div>
          <div class="stat-value gray">${esc(j.unknown || 0)}</div>
          <div class="stat-hint">Không xác định, không tự retry</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Trạng thái Gateway</div></div>
        <dl class="def-list">
          <dt>Phiên bản</dt><dd>${esc(d.gateway.version)}</dd>
          <dt>Môi trường</dt><dd>${esc(d.gateway.environment)}</dd>
          <dt>Provider</dt><dd>${esc(d.provider.provider)} ${d.provider.simulated ? statusBadge('sent_mock') : ''}</dd>
          <dt>Trạng thái</dt><dd>${statusBadge(d.account.status)}</dd>
          <dt>Chế độ kết nối</dt><dd>${esc(d.account.connectionMode)}</dd>
          <dt>Cập nhật lần cuối</dt><dd>${fmtDate(d.account.lastCheckedAt)}</dd>
          ${d.account.lastError ? `<dt>Lỗi gần nhất</dt><dd style="color:var(--red)">${esc(d.account.lastError)}</dd>` : ''}
        </dl>
      </div>`;
  }

  async function renderAccount(root) {
    root.innerHTML = '<div class="card"><span class="spinner"></span> Đang tải…</div>';
    const d = await window.GwApi.accountStatus();
    const p = d.provider || {};
    const a = d.account || {};

    root.innerHTML = `
      <div class="alert alert-info">
        Chưa cấu hình nhà cung cấp Zalo được cấp quyền. Gateway KHÔNG thực hiện QR login,
        KHÔNG lưu mật khẩu/cookie/session cá nhân. Hiện chỉ dùng <strong>MockProvider</strong> để kiểm thử.
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Kết nối tài khoản</div>
            <div class="card-sub">Phiên bản đầu tiên chỉ quản lý một tài khoản</div>
          </div>
          ${p.simulated ? statusBadge('sent_mock') : statusBadge(a.status)}
        </div>
        <dl class="def-list">
          <dt>Tên tài khoản</dt><dd>${esc(a.displayName)}</dd>
          <dt>Provider đang dùng</dt><dd>${esc(a.provider)}</dd>
          <dt>Chế độ hoạt động</dt><dd>${esc(a.connectionMode)} ${p.simulated ? '(mô phỏng)' : ''}</dd>
          <dt>Trạng thái kết nối</dt><dd>${statusBadge(a.status)}</dd>
          <dt>Thời gian cập nhật</dt><dd>${fmtDate(a.lastCheckedAt)}</dd>
          <dt>Thông tin lỗi</dt><dd>${a.lastError ? esc(a.lastError) : '<span class="muted">Không có</span>'}</dd>
          <dt>Lý do</dt><dd class="muted">${esc(p.reason || '—')}</dd>
        </dl>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Bật / tắt MockProvider</div>
            <div class="card-sub">Chỉ dùng cho kiểm thử. Tin nhắn KHÔNG tới Zalo thật.</div>
          </div>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" data-act="enable-mock">Bật MockProvider</button>
          <button class="btn" data-act="disable">Tắt gửi thông báo</button>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Năng lực Provider</div></div>
        <dl class="def-list">
          <dt>Gửi tin nhắn</dt><dd>${p.capabilities && p.capabilities.sendMessage ? 'Có' : 'Không'}</dd>
          <dt>Xác nhận giao hàng</dt><dd>${p.capabilities && p.capabilities.deliveryConfirmation ? 'Có' : 'Không — chỉ biết đã chấp nhận'}</dd>
        </dl>
      </div>`;

    root.querySelector('[data-act="enable-mock"]').addEventListener('click', async () => {
      try {
        await window.GwApi.setProvider('mock');
        toast('Đã bật MockProvider');
        renderAccount(root);
      } catch (e) {
        toast(e.message, 'error');
      }
    });

    root.querySelector('[data-act="disable"]').addEventListener('click', async () => {
      try {
        await window.GwApi.setProvider('disabled');
        toast('Đã tắt gửi thông báo');
        renderAccount(root);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  window.GwPages = window.GwPages || {};
  window.GwPages.dashboard = renderDashboard;
  window.GwPages.account = renderAccount;
})();
