/* Trang Quan ly nhom khach hang. */
(function () {
  'use strict';

  const { esc, fmtDate, toast, statusBadge, modal, confirmDialog } = window.GwUi;

  const state = { page: 1, limit: 25, search: '', status: 'all' };

  function formHtml(g) {
    const v = g || {};
    return `
      <div class="field">
        <label>Customer ID <span class="req">*</span></label>
        <input type="text" id="f-customerId" value="${esc(v.customerId || '')}" placeholder="KH001">
      </div>
      <div class="field">
        <label>Tên khách hàng</label>
        <input type="text" id="f-customerName" value="${esc(v.customerName || '')}" placeholder="Quán A">
      </div>
      <div class="field">
        <label>Group ID <span class="req">*</span></label>
        <input type="text" id="f-groupId" value="${esc(v.groupId || '')}" placeholder="GROUP001">
      </div>
      <div class="field">
        <label>Tên nhóm</label>
        <input type="text" id="f-groupName" value="${esc(v.groupName || '')}" placeholder="Nhóm Quán A">
      </div>
      <div class="field">
        <label>Ghi chú</label>
        <input type="text" id="f-note" value="${esc(v.note || '')}">
      </div>
      ${
        v.id
          ? `<div class="field"><label>Trạng thái</label>
             <select id="f-isActive">
               <option value="1" ${v.isActive ? 'selected' : ''}>Đang liên kết</option>
               <option value="0" ${!v.isActive ? 'selected' : ''}>Ngừng hoạt động</option>
             </select></div>`
          : ''
      }`;
  }

  async function openForm(root, group) {
    const isEdit = !!group;
    const ok = await modal({
      title: isEdit ? 'Sửa liên kết' : 'Thêm liên kết',
      body: `<div class="form-grid">${formHtml(group)}</div>
             <p class="muted" style="font-size:12px;margin-top:4px">
               Quy tắc: 1 Customer ID chỉ có 1 Group ID. 1 Group ID chỉ thuộc 1 Customer ID.
             </p>`,
      okText: isEdit ? 'Lưu thay đổi' : 'Thêm liên kết',
      onOk: async (wrap) => {
        const body = {
          customerId: wrap.querySelector('#f-customerId').value.trim(),
          customerName: wrap.querySelector('#f-customerName').value.trim(),
          groupId: wrap.querySelector('#f-groupId').value.trim(),
          groupName: wrap.querySelector('#f-groupName').value.trim(),
          note: wrap.querySelector('#f-note').value.trim(),
        };
        if (isEdit) {
          const sel = wrap.querySelector('#f-isActive');
          if (sel) body.isActive = sel.value === '1';
        }
        try {
          if (isEdit) await window.GwApi.updateGroup(group.id, body);
          else await window.GwApi.createGroup(body);
          toast(isEdit ? 'Đã cập nhật liên kết' : 'Đã thêm liên kết');
          render(root);
          return true;
        } catch (e) {
          toast(e.message, 'error');
          return false;
        }
      },
    });
    return ok;
  }

  async function render(root) {
    root.innerHTML = '<div class="card"><span class="spinner"></span> Đang tải…</div>';
    const d = await window.GwApi.listGroups({
      search: state.search,
      status: state.status,
      page: state.page,
      limit: state.limit,
    });

    const rows = d.items
      .map(
        (g) => `
      <tr>
        <td><strong>${esc(g.customerName || '—')}</strong><div class="muted mono">${esc(g.customerId)}</div></td>
        <td class="mono">${esc(g.groupId)}</td>
        <td>${esc(g.groupName || '—')}</td>
        <td>${statusBadge(g.isActive ? 'active' : 'inactive')}</td>
        <td class="muted" style="font-size:12px">${fmtDate(g.updatedAt)}</td>
        <td class="nowrap">
          <button class="btn btn-sm" data-act="edit" data-id="${g.id}">Sửa</button>
          ${
            g.isActive
              ? `<button class="btn btn-sm" data-act="deactivate" data-id="${g.id}">Ngừng</button>`
              : ''
          }
          <button class="btn btn-sm btn-danger" data-act="delete" data-id="${g.id}">Xoá</button>
        </td>
      </tr>`
      )
      .join('');

    const totalPages = Math.max(Math.ceil(d.total / d.limit), 1);

    root.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Nhóm khách hàng</div>
            <div class="card-sub">Mỗi khách hàng liên kết đúng 1 nhóm Zalo</div>
          </div>
          <div class="btn-row">
            <button class="btn" data-act="import">Import CSV</button>
            <a class="btn" href="${window.GwApi.templateUrl}" download>Tải file mẫu CSV</a>
            <button class="btn btn-primary" data-act="add">Thêm liên kết</button>
          </div>
        </div>

        <div class="filters">
          <div class="field">
            <label>Tìm khách hàng / Group ID</label>
            <input type="text" id="f-search" value="${esc(state.search)}" placeholder="Nhập để lọc…">
          </div>
          <div class="field">
            <label>Trạng thái</label>
            <select id="f-status">
              <option value="all" ${state.status === 'all' ? 'selected' : ''}>Tất cả</option>
              <option value="active" ${state.status === 'active' ? 'selected' : ''}>Đang liên kết</option>
              <option value="inactive" ${state.status === 'inactive' ? 'selected' : ''}>Ngừng hoạt động</option>
            </select>
          </div>
          <button class="btn" data-act="filter">Lọc</button>
        </div>

        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Khách hàng</th><th>Group ID</th><th>Tên nhóm</th>
              <th>Trạng thái</th><th>Cập nhật</th><th>Thao tác</th>
            </tr></thead>
            <tbody>${rows || '<tr><td colspan="6" class="empty">Chưa có liên kết nào</td></tr>'}</tbody>
          </table>
        </div>

        <div class="pager">
          <div class="pager-info">Tổng ${esc(d.total)} liên kết — trang ${esc(d.page)}/${esc(totalPages)}</div>
          <div class="btn-row">
            <button class="btn btn-sm" data-act="prev" ${d.page <= 1 ? 'disabled' : ''}>‹ Trước</button>
            <button class="btn btn-sm" data-act="next" ${d.page >= totalPages ? 'disabled' : ''}>Sau ›</button>
          </div>
        </div>
      </div>`;

    bind(root);
  }

  function bind(root) {
    const search = root.querySelector('#f-search');
    const status = root.querySelector('#f-status');

    root.querySelector('[data-act="filter"]').addEventListener('click', () => {
      state.search = search.value.trim();
      state.status = status.value;
      state.page = 1;
      render(root);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        state.search = search.value.trim();
        state.page = 1;
        render(root);
      }
    });
    status.addEventListener('change', () => {
      state.status = status.value;
      state.page = 1;
      render(root);
    });

    root.querySelector('[data-act="add"]').addEventListener('click', () => openForm(root, null));
    root.querySelector('[data-act="import"]').addEventListener('click', () => window.GwImport.open(root, render));

    root.querySelectorAll('[data-act="edit"]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          const d = await window.GwApi.listGroups({ search: '', status: 'all', page: 1, limit: 200 });
          const g = d.items.find((x) => String(x.id) === b.dataset.id);
          if (g) openForm(root, g);
        } catch (e) {
          toast(e.message, 'error');
        }
      })
    );

    root.querySelectorAll('[data-act="deactivate"]').forEach((b) =>
      b.addEventListener('click', async () => {
        const ok = await confirmDialog(
          'Ngừng hoạt động',
          'Khách hàng này sẽ không nhận thông báo mới. Lịch sử gửi tin được giữ nguyên.',
          'Ngừng hoạt động'
        );
        if (!ok) return;
        try {
          await window.GwApi.deleteGroup(b.dataset.id);
          toast('Đã ngừng hoạt động');
          render(root);
        } catch (e) {
          toast(e.message, 'error');
        }
      })
    );

    root.querySelectorAll('[data-act="delete"]').forEach((b) =>
      b.addEventListener('click', async () => {
        const ok = await confirmDialog(
          'Xoá liên kết',
          'Liên kết sẽ chuyển sang trạng thái ngừng hoạt động. LỊCH SỬ GỬI TIN ĐƯỢC GIỮ NGUYÊN.',
          'Ngừng hoạt động'
        );
        if (!ok) return;
        try {
          await window.GwApi.deleteGroup(b.dataset.id);
          toast('Đã ngừng hoạt động liên kết');
          render(root);
        } catch (e) {
          toast(e.message, 'error');
        }
      })
    );

    root.querySelector('[data-act="prev"]').addEventListener('click', () => {
      state.page = Math.max(1, state.page - 1);
      render(root);
    });
    root.querySelector('[data-act="next"]').addEventListener('click', () => {
      state.page += 1;
      render(root);
    });
  }

  window.GwPages = window.GwPages || {};
  window.GwPages.groups = render;
})();
