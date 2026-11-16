/**
 * JS — Trang Admin "Quản lý khu vực giao hàng"
 * ─────────────────────────────────────────────────────────────────────────────
 * - Tải danh mục khu vực + tài xế + thống kê.
 * - Gán / thay đổi / ngừng phân công tài xế (bảng phân công).
 * - Gán NHIỀU khu vực cho 1 tài xế (checkbox multi-select).
 * - Điều phối đơn chờ + chuyển đơn giữa các tài xế.
 * - Lịch sử phân công.
 */

(function () {
  'use strict';

  var state = {
    regions: [],
    drivers: [],
    stats: [],
    history: [],
    unassigned: [],
    pending: {},   // regionId → driverUsername (đang chỉnh sửa)
  };

  // ── Helpers ─────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  }

  function $(id) { return document.getElementById(id); }

  function fmtNumber(n) {
    var v = Number(n) || 0;
    try { return new Intl.NumberFormat('vi-VN').format(v); } catch (e) { return String(v); }
  }

  function fmtVND(n) {
    var v = Number(n) || 0;
    try { return new Intl.NumberFormat('vi-VN').format(v) + ' đ'; } catch (e) { return v + ' đ'; }
  }

  function fmtDateTime(s) {
    if (!s) return '';
    var d = new Date(String(s).replace(' ', 'T'));
    if (isNaN(d.getTime())) return String(s);
    return d.toLocaleString('vi-VN', { hour12: false });
  }

  function toast(msg, isError) {
    var el = document.createElement('div');
    el.className = 'rg-toast' + (isError ? ' rg-toast--err' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 3200);
  }

  function driverLabel(username) {
    if (!username) return null;
    for (var i = 0; i < state.drivers.length; i++) {
      if (state.drivers[i].username === username) {
        return state.drivers[i].fullName || username;
      }
    }
    return username;
  }

  // ── Load data ──────────────────────────────────────────────────────────
  // Dùng authFetch để gửi Authorization header (bắt buộc với phiên admin).
  function apiFetch(url, opts) {
    if (typeof authFetch === 'function') return authFetch(url, opts);
    return fetch(url, Object.assign({ credentials: 'include' }, opts || {}));
  }

  function loadAll() {
    return Promise.all([
      apiFetch('/api/admin/regions', { cache: 'no-store' }).then(function (r) { return r.json(); }),
      apiFetch('/api/admin/regions/stats', { cache: 'no-store' }).then(function (r) { return r.json(); }),
      apiFetch('/api/admin/regions/history?limit=50', { cache: 'no-store' }).then(function (r) { return r.json(); }),
      apiFetch('/api/admin/regions/dispatch/unassigned', { cache: 'no-store' }).then(function (r) { return r.json(); })
    ]).then(function (res) {
      state.regions = (res[0] && res[0].regions) || [];
      state.drivers = (res[0] && res[0].drivers) || [];
      state.stats = (res[1] && res[1].stats) || [];
      state.history = (res[2] && res[2].history) || [];
      state.unassigned = (res[3] && res[3].sales) || [];
      renderAll();
    }).catch(function (e) {
      toast('Lỗi tải dữ liệu: ' + e.message, true);
    });
  }

  // ── Render: bảng phân công ────────────────────────────────────────────
  function statFor(regionId) {
    for (var i = 0; i < state.stats.length; i++) {
      if (state.stats[i].regionId === regionId) return state.stats[i];
    }
    return null;
  }

  function renderAssignTable() {
    var body = $('rgAssignBody');
    if (!body) return;
    if (!state.regions.length) {
      body.innerHTML = '<tr><td colspan="8" class="rg-empty">Chưa có khu vực nào</td></tr>';
      return;
    }

    var html = state.regions.map(function (r) {
      var st = statFor(r.regionId) || {};
      var current = r.driverUsername || '';
      var options = '<option value="">— Chưa gán —</option>';
      state.drivers.forEach(function (d) {
        // Tài xế đang phụ trách khu vực KHÁC → gán sẽ thu hồi khu vực đó.
        var ownsOther = (d.regionIds || []).some(function (rid) {
          return Number(rid) !== Number(r.regionId);
        });
        var suffix = ownsOther ? ' ⚠️ (đang giữ khu vực khác)' : '';
        options += '<option value="' + esc(d.username) + '"' +
          (current === d.username ? ' selected' : '') + '>' +
          esc(d.fullName || d.username) + (d.active ? '' : ' (đã khoá)') + suffix + '</option>';
      });

      var badge = r.hasDriver
        ? '<span class="rg-badge rg-badge--ok">● Đã phân công</span>'
        : '<span class="rg-badge rg-badge--warn">● Chưa có tài xế</span>';

      return '<tr>' +
        '<td><strong>' + esc(r.regionName) + '</strong></td>' +
        '<td><code style="font-size:11px;color:var(--text-muted)">' + esc(r.regionCode) + '</code></td>' +
        '<td>' + (r.driverUsername
            ? esc(driverLabel(r.driverUsername) || r.driverUsername)
            : '<span style="color:var(--text-muted)">—</span>') + '</td>' +
        '<td>' + fmtNumber(st.customerCount || 0) + '</td>' +
        '<td>' + fmtNumber(st.orderCount || 0) + '</td>' +
        '<td>' + fmtNumber(st.liters || 0) + ' l</td>' +
        '<td>' + badge + '</td>' +
        '<td>' +
          '<select class="rg-select" data-region-select="' + r.regionId + '" ' +
            'style="min-width:150px">' + options + '</select> ' +
          '<button class="rg-btn" data-assign="' + r.regionId + '">Lưu</button> ' +
          (r.hasDriver ? '<button class="rg-btn rg-btn--danger" data-unassign="' + r.regionId + '">Bỏ</button>' : '') +
        '</td>' +
      '</tr>';
    }).join('');

    body.innerHTML = html;
  }

  // ── Render: gán nhiều khu vực cho 1 tài xế ─────────────────────────────
  function renderDriverList() {
    var wrap = $('rgDriverList');
    if (!wrap) return;
    if (!state.drivers.length) {
      wrap.innerHTML = '<div class="rg-empty">Chưa có tài xế nào. Tạo tài xế tại trang Hồ sơ tài xế.</div>';
      return;
    }

    // regionId → driverUsername (đang phụ trách)
    var ownerByRegion = {};
    state.regions.forEach(function (r) {
      if (r.driverUsername) ownerByRegion[r.regionId] = r.driverUsername;
    });

    var html = state.drivers.map(function (d) {
      // Khu vực đang do tài xế KHÁC phụ trách → KHÔNG cho tick (chống chồng chéo).
      var taken = d.takenRegionIds || [];
      var ownerNameById = {};
      state.regions.forEach(function (r) {
        if (r.driverUsername) ownerNameById[r.regionId] = driverLabel(r.driverUsername) || r.driverUsername;
      });

      var boxes = state.regions.map(function (r) {
        var isMine = ownerByRegion[r.regionId] === d.username;
        var isTaken = !isMine && taken.indexOf(Number(r.regionId)) !== -1;

        var checked = isMine ? ' checked' : '';
        var on = isMine ? ' rg-check--on' : '';
        var disabled = isTaken ? ' disabled' : '';
        var cls = 'rg-check' + on + (isTaken ? ' rg-check--taken' : '');
        var title = isTaken
          ? ' title="Khu vực đang do ' + esc(ownerNameById[r.regionId] || 'tài xế khác') + ' phụ trách — bỏ gán khu vực đó trước"'
          : '';
        var hint = isTaken
          ? '<span class="rg-check-hint">🔒 ' + esc(ownerNameById[r.regionId] || 'đã gán') + '</span>'
          : '';

        return '<label class="' + cls + '"' + title + ' data-check-wrap="' + esc(d.username) + '-' + r.regionId + '">' +
          '<input type="checkbox" data-driver="' + esc(d.username) + '" data-region="' + r.regionId + '"' + checked + disabled + '>' +
          '<span>' + esc(r.regionName) + hint + '</span>' +
        '</label>';
      }).join('');

      return '<div class="rg-driver-card">' +
        '<div class="rg-driver-head">' +
          '<span class="rg-driver-name">🚚 ' + esc(d.fullName || d.username) + '</span>' +
          '<span class="rg-driver-meta">' + esc(d.username) + (d.phone ? ' · ' + esc(d.phone) : '') + '</span>' +
          (d.active ? '' : '<span class="rg-badge rg-badge--none">Đã khoá</span>') +
          '<button class="rg-btn" data-save-driver="' + esc(d.username) + '" style="margin-left:auto">💾 Lưu</button>' +
        '</div>' +
        '<div class="rg-region-grid">' + boxes + '</div>' +
      '</div>';
    }).join('');

    wrap.innerHTML = html;
  }

  // ── Render: đơn chờ điều phối ──────────────────────────────────────────
  function renderUnassigned() {
    var body = $('rgUnassignedBody');
    if (!body) return;
    if (!state.unassigned.length) {
      body.innerHTML = '<tr><td colspan="5" class="rg-empty">Không có đơn chờ điều phối 🎉</td></tr>';
      return;
    }

    var html = state.unassigned.map(function (s) {
      var options = '<option value="">— Chọn tài xế —</option>';
      state.drivers.forEach(function (d) {
        options += '<option value="' + esc(d.username) + '">' + esc(d.fullName || d.username) + '</option>';
      });
      return '<tr>' +
        '<td>#' + s.id + ' <span style="color:var(--text-muted);font-size:11px">' + esc(s.sale_time || '') + '</span></td>' +
        '<td>' + esc(s.customer_name || 'Khách lẻ') + '</td>' +
        '<td>' + (s.region_name
            ? '<span class="rg-badge rg-badge--ok">' + esc(s.region_name) + '</span>'
            : '<span class="rg-badge rg-badge--none">Chưa có khu vực</span>') +
          (s.dispatch_reason
            ? '<div style="color:var(--text-muted);font-size:11px;margin-top:3px">⚠️ ' + esc(s.dispatch_reason) + '</div>'
            : '') + '</td>' +
        '<td>' + fmtVND(s.total) + '</td>' +
        '<td><select class="rg-select" data-dispatch="' + s.id + '" style="min-width:150px">' + options + '</select> ' +
          '<button class="rg-btn" data-dispatch-save="' + s.id + '">Gán</button></td>' +
      '</tr>';
    }).join('');

    body.innerHTML = html;
  }

  // ── Render: lịch sử ───────────────────────────────────────────────────
  var ACTION_LABEL = {
    assign: 'Gán tài xế',
    reassign: 'Đổi tài xế',
    unassign: 'Ngừng phân công'
  };

  function renderHistory() {
    var wrap = $('rgHistoryList');
    if (!wrap) return;
    if (!state.history.length) {
      wrap.innerHTML = '<div class="rg-empty">Chưa có thay đổi phân công nào</div>';
      return;
    }

    var html = state.history.map(function (h) {
      var label = ACTION_LABEL[h.action] || h.action;
      var detail = h.action === 'unassign'
        ? esc(h.previous_driver_username || '') + ' → <em>ngừng</em>'
        : esc(h.previous_driver_username || '(chưa có)') + ' → <strong>' + esc(h.new_driver_username || '') + '</strong>';
      return '<div class="rg-history-row">' +
        '<span class="rg-history-time">' + esc(fmtDateTime(h.created_at)) + '</span>' +
        '<span class="rg-badge rg-badge--ok">' + esc(label) + '</span>' +
        '<span>' + esc(h.region_name || '') + '</span>' +
        '<span style="color:var(--text-muted)">' + detail + '</span>' +
        (h.actor_username ? '<span style="color:var(--text-muted);font-size:11px">bởi ' + esc(h.actor_username) + '</span>' : '') +
      '</div>';
    }).join('');

    wrap.innerHTML = html;
  }

  function renderAll() {
    renderAssignTable();
    renderDriverList();
    renderUnassigned();
    renderHistory();
  }

  // ── Actions ───────────────────────────────────────────────────────────
  function assignRegion(regionId, driverUsername, confirmTakeover) {
    return apiFetch('/api/admin/regions/' + regionId + '/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        driverUsername: driverUsername || null,
        confirmTakeover: !!confirmTakeover
      })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) {
          // Khu vực đang có tài xế khác → yêu cầu Admin xác nhận thu hồi.
          if (res.body && res.body.requiresConfirm) {
            var regionName = '';
            state.regions.forEach(function (r) {
              if (String(r.regionId) === String(regionId)) regionName = r.regionName;
            });
            var ok = confirm(
              '⚠️ ' + (res.body.error || 'Khu vực đang có tài xế khác phụ trách.') +
              '\n\nXác nhận chuyển khu vực "' + regionName + '" sang tài xế mới?'
            );
            if (ok) return assignRegion(regionId, driverUsername, true);
            toast('Đã huỷ — khu vực giữ nguyên tài xế hiện tại', true);
            return null;
          }
          throw new Error(res.body.error || 'Không phân công được');
        }
        var msg = res.body.changed ? 'Đã cập nhật phân công' : 'Phân công không thay đổi';
        var n = res.body.reassignedSales || 0;
        if (n > 0) msg += ' · ' + n + ' đơn chuyển tài xế';
        var p = res.body.preservedSales || 0;
        if (p > 0) msg += ' · ' + p + ' đơn đã hoàn tất giữ nguyên';
        toast(msg);
        return loadAll();
      }).catch(function (e) { toast(e.message, true); });
  }

  function saveDriverRegions(username) {
    var checked = [];
    var all = document.querySelectorAll('input[data-driver="' + username.replace(/"/g, '\\"') + '"]');
    all.forEach(function (cb) { if (cb.checked) checked.push(parseInt(cb.dataset.region, 10)); });

    // Tập khu vực HIỆN TẠI của tài xế (để biết cần bỏ phân công ở đâu)
    var current = [];
    state.regions.forEach(function (r) {
      if (r.driverUsername === username) current.push(r.regionId);
    });

    var toAdd = checked.filter(function (id) { return current.indexOf(id) === -1; });
    var toRemove = current.filter(function (id) { return checked.indexOf(id) === -1; });

    if (!toAdd.length && !toRemove.length) {
      toast('Không có thay đổi');
      return Promise.resolve();
    }

    // ⚠️ Thứ tự quan trọng: BỎ gán trước, rồi GÁN mới.
    // Nếu gán trước, khu vực đang thuộc tài xế khác sẽ bị chặn (chống chồng chéo)
    // và việc bỏ gán sau sẽ vô nghĩa.
    var ops = [];
    toRemove.forEach(function (id) {
      ops.push(apiFetch('/api/admin/regions/' + id + '/assign', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driverUsername: null })
      }));
    });

    // Gán mới — nếu khu vực còn tài xế khác thì cần Admin xác nhận thu hồi.
    var pending = Promise.resolve();
    toAdd.forEach(function (id) {
      pending = pending.then(function () {
        return apiFetch('/api/admin/regions/' + id + '/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ driverUsername: username, confirmTakeover: true })
        }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
          .then(function (res) {
            if (!res.ok) throw new Error(res.body.error || 'Không gán được');
          });
      });
    });

    return ops.reduce(function (chain, p) {
      return chain.then(function () { return p; });
    }, Promise.resolve())
      .then(function () { return pending; })
      .then(function () { toast('Đã lưu phân công khu vực'); return loadAll(); })
      .catch(function (e) { toast('Lỗi lưu phân công: ' + e.message, true); return loadAll(); });
  }

  function dispatchSale(saleId, driverUsername) {
    if (!driverUsername) { toast('Vui lòng chọn tài xế', true); return; }
    return apiFetch('/api/admin/regions/dispatch/' + saleId + '/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverUsername: driverUsername })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || 'Không gán được');
        toast('Đã gán tài xế cho đơn #' + saleId);
        return loadAll();
      }).catch(function (e) { toast(e.message, true); });
  }

  // ── Events ────────────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var t = e.target;

    var assignBtn = t.closest && t.closest('[data-assign]');
    if (assignBtn) {
      var rid = assignBtn.getAttribute('data-assign');
      var sel = document.querySelector('select[data-region-select="' + rid + '"]');
      if (sel) assignRegion(rid, sel.value);
      return;
    }

    var unassignBtn = t.closest && t.closest('[data-unassign]');
    if (unassignBtn) {
      var urid = unassignBtn.getAttribute('data-unassign');
      if (confirm('Ngừng phân công tài xế cho khu vực này?')) assignRegion(urid, null);
      return;
    }

    var saveDriverBtn = t.closest && t.closest('[data-save-driver]');
    if (saveDriverBtn) {
      saveDriverRegions(saveDriverBtn.getAttribute('data-save-driver'));
      return;
    }

    var dispatchBtn = t.closest && t.closest('[data-dispatch-save]');
    if (dispatchBtn) {
      var sid = dispatchBtn.getAttribute('data-dispatch-save');
      var dsel = document.querySelector('select[data-dispatch="' + sid + '"]');
      if (dsel) dispatchSale(sid, dsel.value);
      return;
    }
  });

  // Toggle style khi tick checkbox khu vực
  document.addEventListener('change', function (e) {
    var cb = e.target;
    if (cb && cb.matches && cb.matches('input[data-region]')) {
      var wrap = cb.closest('.rg-check');
      if (wrap) wrap.classList.toggle('rg-check--on', !!cb.checked);
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    loadAll();
  });
})();
