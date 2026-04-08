// ============================================================
// backup_service.js — Hệ thống sao lưu tự động
// Chức năng:
//   - Xuất JSON đầy đủ (sales, products, customers, expenses)
//   - Tải file sao lưu xuống máy
//   - Tự động sao lưu 1 lần/ngày khi ứng dụng khởi động
// Sử dụng:
//   window.__backup.exportJSON()        — Xuất file backup thủ công
//   window.__backup.autoBackupDaily()  — Kích hoạt auto backup
// ============================================================

(function () {
  'use strict';

  var BACKUP_KEY  = '_lastBackupDate';
  var BACKUP_TAG  = '_backupVersion';
  var BACKUP_VER  = '1.0';

  // ── Đợi DB ───────────────────────────────────────────────
  function waitForDB() {
    return new Promise(function (resolve, reject) {
      if (!window.db) { reject(new Error('window.db chưa tải')); return; }
      if (window.dbReady) window.dbReady.then(resolve).catch(reject);
      else resolve();
    });
  }

  // ── Lấy thời gian hiện tại (UTC+7) ───────────────────────
  function getVietnamNow() {
    return new Date(new Date().getTime() + 7 * 3600000);
  }

  function getDateStr(d) {
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  // ── Định dạng thời gian ────────────────────────────────────
  function fmtTime(d) {
    return d.getHours().toString().padStart(2,'0') + ':' +
           d.getMinutes().toString().padStart(2,'0') + ':' +
           d.getSeconds().toString().padStart(2,'0');
  }

  // ══════════════════════════════════════════════════════════
  // PART 6a: exportJSON — xuất toàn bộ dữ liệu ra file
  // ══════════════════════════════════════════════════════════
  window.__backup = {

    /**
     * Xuất toàn bộ dữ liệu ra file JSON
     * @param {Object} options
     * @param {boolean} options.includeSales    — Bao gồm sales (mặc định true)
     * @param {boolean} options.includeProducts  — Bao gồm products (mặc định true)
     * @param {boolean} options.includeCustomers — Bao gồm customers (mặc định true)
     * @param {boolean} options.includeExpenses  — Bao gồm expenses (mặc định true)
     * @returns {Promise<Object>} Dữ liệu đã xuất
     */
    exportJSON: async function (options) {
      options = options || {};
      var includeSales    = options.includeSales    !== false;
      var includeProducts = options.includeProducts !== false;
      var includeCustomers = options.includeCustomers !== false;
      var includeExpenses = options.includeExpenses !== false;

      await waitForDB();
      var db = window.db;
      var vn = getVietnamNow();

      console.log('[BACKUP] Bắt đầu xuất dữ liệu...');

      var backup = {
        _meta: {
          version:    BACKUP_VER,
          app:        'BeerPOS',
          created_at: vn.toISOString(),
          created_at_vn: getDateStr(vn) + ' ' + fmtTime(vn) + ' (GMT+7)',
          db_version: window.DB_VERSION || 'unknown'
        },
        sales:     [],
        sale_items: [],
        products:   [],
        customers: [],
        expenses:  []
      };

      // ── Đọc từng bảng ───────────────────────────────────
      if (includeSales) {
        try {
          backup.sales = await db.sales.toArray();
          console.log('[BACKUP] Đã đọc ' + backup.sales.length + ' đơn hàng');
        } catch (e) {
          console.warn('[BACKUP] Lỗi đọc sales:', e.message);
        }
      }

      if (includeProducts) {
        try {
          backup.products = await db.products.toArray();
          console.log('[BACKUP] Đã đọc ' + backup.products.length + ' sản phẩm');
        } catch (e) {
          console.warn('[BACKUP] Lỗi đọc products:', e.message);
        }
      }

      if (includeCustomers) {
        try {
          backup.customers = await db.customers.toArray();
          console.log('[BACKUP] Đã đọc ' + backup.customers.length + ' khách hàng');
        } catch (e) {
          console.warn('[BACKUP] Lỗi đọc customers:', e.message);
        }
      }

      if (includeExpenses) {
        try {
          backup.expenses = await db.expenses.toArray();
          console.log('[BACKUP] Đã đọc ' + backup.expenses.length + ' chi phí');
        } catch (e) {
          console.warn('[BACKUP] Lỗi đọc expenses:', e.message);
        }
      }

      // sale_items: đọc theo sale_ids để giới hạn
      if (includeSales && backup.sales.length > 0) {
        try {
          var saleIds = backup.sales.map(function (s) { return s.id; });
          backup.sale_items = await db.sale_items
            .where('sale_id').anyOf(saleIds).toArray();
          console.log('[BACKUP] Đã đọc ' + backup.sale_items.length + ' mặt hàng chi tiết');
        } catch (e) {
          console.warn('[BACKUP] Lỗi đọc sale_items:', e.message);
        }
      }

      // ── Tạo file và tải xuống ──────────────────────────
      var jsonStr = JSON.stringify(backup, null, 2);
      var blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
      var url  = URL.createObjectURL(blob);

      var ts  = getDateStr(vn).replace(/-/g, '') + '-' +
                 fmtTime(vn).replace(/:/g, '');
      var filename = 'beerpos-backup-' + ts + '.json';

      var link = document.createElement('a');
      link.href     = url;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      console.log('[BACKUP] ✅ Đã tải: ' + filename +
        ' | ' + Math.round(jsonStr.length / 1024) + ' KB');

      // Cập nhật thời gian backup gần nhất
      localStorage.setItem(BACKUP_KEY, getDateStr(vn));

      return backup;
    },

    // ══════════════════════════════════════════════════════════
    // PART 6b: autoBackupDaily — tự động sao lưu 1 lần/ngày
    // ══════════════════════════════════════════════════════════
    autoBackupDaily: async function () {
      var vn = getVietnamNow();
      var today = getDateStr(vn);
      var lastBackup = localStorage.getItem(BACKUP_KEY) || '';

      if (lastBackup === today) {
        console.log('[BACKUP] Đã backup hôm nay (' + today + ') — bỏ qua');
        return { status: 'skipped', reason: 'Đã backup hôm nay', date: today };
      }

      console.log('[BACKUP] Tự động backup ngày ' + today + '...');
      try {
        await window.__backup.exportJSON();
        console.log('[BACKUP] ✅ Auto backup thành công!');
        return { status: 'success', date: today };
      } catch (e) {
        console.error('[BACKUP] ❌ Auto backup thất bại:', e.message);
        return { status: 'error', error: e.message };
      }
    },

    // ══════════════════════════════════════════════════════════
    // Import từ file backup (khôi phục)
    // ══════════════════════════════════════════════════════════
    importJSON: async function (file) {
      await waitForDB();
      var db = window.db;

      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function (e) {
          try {
            var data = JSON.parse(e.target.result);
            console.log('[BACKUP] Bắt đầu khôi phục từ file...', data._meta);
          } catch (parseErr) {
            reject(new Error('File không hợp lệ: ' + parseErr.message));
            return;
          }

          (async function () {
            var counts = { sales: 0, sale_items: 0, products: 0, customers: 0, expenses: 0 };

            try {
              // Products trước (vì sale_items có thể reference)
              if (data.products && data.products.length > 0) {
                for (var i = 0; i < data.products.length; i++) {
                  var p = data.products[i];
                  try {
                    var exist = await db.products.get(p.id);
                    if (!exist) await db.products.add({ ...p, synced: 0 });
                    counts.products++;
                  } catch (_) {}
                }
              }

              // Customers
              if (data.customers && data.customers.length > 0) {
                for (var j = 0; j < data.customers.length; j++) {
                  var c = data.customers[j];
                  try {
                    var existC = await db.customers.get(c.id);
                    if (!existC) await db.customers.add({ ...c, synced: 0 });
                    counts.customers++;
                  } catch (_) {}
                }
              }

              // Sales (backup có thể bị trùng — chỉ thêm nếu chưa có)
              if (data.sales && data.sales.length > 0) {
                for (var k = 0; k < data.sales.length; k++) {
                  var s = data.sales[k];
                  try {
                    var existS = await db.sales.get(s.id);
                    if (!existS) {
                      await db.sales.add({ ...s, synced: 0 });
                      counts.sales++;
                    }
                  } catch (_) {}
                }
              }

              // Sale_items
              if (data.sale_items && data.sale_items.length > 0) {
                for (var l = 0; l < data.sale_items.length; l++) {
                  var si = data.sale_items[l];
                  try {
                    var existSI = await db.sale_items.get(si.id);
                    if (!existSI) await db.sale_items.add({ ...si, synced: 0 });
                    counts.sale_items++;
                  } catch (_) {}
                }
              }

              // Expenses
              if (data.expenses && data.expenses.length > 0) {
                for (var m = 0; m < data.expenses.length; m++) {
                  var ex = data.expenses[m];
                  try {
                    var existEX = await db.expenses.get(ex.id);
                    if (!existEX) await db.expenses.add({ ...ex, synced: 0 });
                    counts.expenses++;
                  } catch (_) {}
                }
              }

              console.log('[BACKUP] ✅ Khôi phục hoàn tất:', counts);
              resolve({ status: 'success', counts: counts });
            } catch (err) {
              reject(err);
            }
          })();
        };
        reader.onerror = function () {
          reject(new Error('Không thể đọc file'));
        };
        reader.readAsText(file);
      });
    },

    // ── Kiểm tra trạng thái backup ──────────────────────────
    getBackupStatus: function () {
      var last = localStorage.getItem(BACKUP_KEY) || 'chưa bao giờ';
      var vn = getVietnamNow();
      return {
        last_backup_date: last,
        today: getDateStr(vn),
        is_today: last === getDateStr(vn)
      };
    }
  };

  console.log('[BACKUP] Đã tải — window.__backup.exportJSON() | window.__backup.autoBackupDaily()');
})();
