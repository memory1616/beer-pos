/* Bootstrap app: navigation, doi trang, xac thuc API key. */
(function () {
  'use strict';

  const TITLES = {
    dashboard: 'Tổng quan',
    account: 'Kết nối tài khoản',
    groups: 'Nhóm khách hàng',
    queue: 'Hàng đợi',
    history: 'Lịch sử gửi tin',
    settings: 'Cấu hình',
  };

  let current = 'dashboard';

  function showPage(name) {
    current = name;
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.classList.toggle('active', n.dataset.page === name);
    });
    document.getElementById('pageTitle').textContent = TITLES[name] || name;
    document.getElementById('sidebar').classList.remove('open');

    const root = document.getElementById('view-root');
    const renderer = window.GwPages[name];
    if (!renderer) {
      root.innerHTML = '<div class="card">Trang chưa có nội dung</div>';
      return;
    }
    Promise.resolve(renderer(root)).catch((e) => {
      root.innerHTML = `<div class="card"><div class="alert alert-danger">${e.message}</div></div>`;
    });
  }

  async function refreshHealth() {
    try {
      const h = await window.GwApi.health();
      const badge = document.getElementById('gatewayBadge');
      badge.textContent = 'Gateway: ' + (h.status === 'ok' ? 'OK' : h.status);
      badge.className = 'badge ' + (h.status === 'ok' ? 'badge-success' : 'badge-danger');
      document.getElementById('sidebar-provider').textContent =
        'Provider: ' + (h.provider ? h.provider.provider : '—');
      document.getElementById('sidebar-version').textContent = 'v' + h.version;
    } catch (e) {
      const badge = document.getElementById('gatewayBadge');
      badge.textContent = 'Gateway: offline';
      badge.className = 'badge badge-danger';
    }
  }

  async function ensureKey() {
    if (window.GwApi.getKey()) return true;
    const ok = await window.GwUi.modal({
      title: 'Xác thực',
      body: `
        <div class="alert alert-warning">
          Gateway yêu cầu Admin API key cho mọi thao tác quản trị.
          Key lấy từ biến môi trường <span class="mono">ADMIN_API_KEY</span> khi chạy Gateway.
        </div>
        <div class="field">
          <label>Admin API Key</label>
          <input type="password" id="k-input" placeholder="Nhập API key…">
        </div>`,
      okText: 'Kết nối',
      onOk: async (wrap) => {
        const v = wrap.querySelector('#k-input').value.trim();
        if (!v) {
          window.GwUi.toast('Chưa nhập API key', 'error');
          return false;
        }
        window.GwApi.setKey(v);
        try {
          await window.GwApi.dashboard();
          window.GwUi.toast('Đã xác thực');
          return true;
        } catch (e) {
          window.GwApi.setKey('');
          window.GwUi.toast('API key không hợp lệ', 'error');
          return false;
        }
      },
    });
    return !!ok;
  }

  async function boot() {
    document.getElementById('nav').addEventListener('click', (e) => {
      const item = e.target.closest('.nav-item');
      if (item) showPage(item.dataset.page);
    });

    document.getElementById('menuToggle').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('open');
    });

    await refreshHealth();
    setInterval(refreshHealth, 15000);

    if (await ensureKey()) showPage('dashboard');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
