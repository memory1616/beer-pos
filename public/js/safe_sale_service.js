// ============================================================
// safe_sale_service.js — Tạo đơn hàng an toàn có đầy đủ snapshot
// Nguyên tắc:
//   - Mỗi item LƯU ĐẦY ĐỦ snapshot của sản phẩm tại thời điểm bán
//   - KHÔNG bao giờ phụ thuộc vào bảng products sau khi lưu
//   - Luôn tính profit từ snapshot, không tính lại từ products
// Sử dụng:
//   window.__safeSale.createSale({ customerId, items, deliverKegs, returnKegs })
// ============================================================

(function () {
  'use strict';

  function waitForDB() {
    return new Promise(function (resolve, reject) {
      if (!window.db) { reject(new Error('window.db chưa tải')); return; }
      if (window.dbReady) window.dbReady.then(resolve).catch(reject);
      else resolve();
    });
  }

  function fmtVND(n) {
    return new Intl.NumberFormat('vi-VN').format(n || 0) + ' đ';
  }

  // ── Lấy thông tin sản phẩm tại thời điểm bán (để snapshot) ──
  async function getProductSnapshot(productId) {
    var db = window.db;
    if (!db || !db.products) return null;
    try {
      var product = await db.products.get(Number(productId));
      if (!product) return null;
      return {
        name:       product.name       || ('SP #' + productId),
        cost_price: Number(product.cost_price) || 0,
        sell_price: Number(product.sell_price) || 0,
        product_id: product.id,
        slug:       product.slug       || null
      };
    } catch (e) {
      console.warn('[SAFE_SALE] Lỗi đọc product ' + productId + ':', e.message);
      return null;
    }
  }

  // ── Lấy thông tin khách hàng tại thời điểm bán ──────────────
  async function getCustomerSnapshot(customerId) {
    var db = window.db;
    if (!db || !db.customers || !customerId) return null;
    try {
      var customer = await db.customers.get(Number(customerId));
      return customer || null;
    } catch (e) {
      return null;
    }
  }

  // ── Tạo một snapshot item hoàn chỉnh ───────────────────────
  async function snapshotItem(rawItem, productInfo) {
    var sellPrice = Number(rawItem.price) || Number(rawItem.sell_price) || 0;
    var quantity  = Math.max(0, Math.round(Number(rawItem.quantity) || 0));
    var costPrice = Number(rawItem.cost_price)
      || (productInfo ? Number(productInfo.cost_price) : 0)
      || Math.round(sellPrice * 0.7);  // fallback: ước tính

    var profit = (sellPrice - costPrice) * quantity;
    var estimated = (rawItem.cost_price == null && !productInfo);

    return {
      // Liên kết
      sale_id:     null, // sẽ gán sau
      product_id:  Number(rawItem.productId) || Number(rawItem.product_id) || null,

      // SNAPSHOT đầy đủ (chống mất dữ liệu)
      product_name: rawItem.product_name
        || (productInfo ? productInfo.name : ('SP #' + (rawItem.productId || rawItem.product_id || '?'))),

      product_slug: rawItem.product_slug
        || (productInfo ? productInfo.slug : null),

      // Giá tại thời điểm bán
      price:        sellPrice,      // giá bán
      cost_price:   costPrice,      // giá vốn tại thời điểm bán

      // Số lượng
      quantity:     quantity,

      // Lợi nhuận = (giá bán - giá vốn) × số lượng
      profit:       profit,

      // Cờ ước tính (chỉ true khi cost_price không có thật)
      profit_estimated: estimated,

      synced: 0
    };
  }

  // ── PART 2: Tạo đơn hàng an toàn ───────────────────────────
  window.__safeSale = {

    /**
     * Tạo một đơn hàng mới với snapshot đầy đủ
     * @param {Object} data
     * @param {number|null} data.customerId    — ID khách hàng (null = khách lẻ)
     * @param {Array}  data.items               — danh sách item từ form
     * @param {number} data.deliverKegs        — số vỏ giao
     * @param {number} data.returnKegs         — số vỏ thu về
     * @returns {Promise<{success, saleId, total, profit}>}
     */
    createSale: async function (data) {
      await waitForDB();
      var db = window.db;

      var customerId   = data.customerId ? Number(data.customerId) : null;
      var rawItems    = Array.isArray(data.items) ? data.items : [];
      var deliverKegs = Math.max(0, Math.round(Number(data.deliverKegs) || 0));
      var returnKegs  = Math.max(0, Math.round(Number(data.returnKegs) || 0));

      // ── 1. Lấy snapshot khách hàng ──────────────────────────
      var customerInfo = null;
      if (customerId) {
        customerInfo = await getCustomerSnapshot(customerId);
      }

      // ── 2. Lấy snapshot tất cả sản phẩm (batch để tăng tốc) ──
      var productIds = rawItems.map(function (it) { return Number(it.productId) || Number(it.product_id); }).filter(Boolean);
      var productSnapshots = {};
      if (productIds.length > 0 && db.products) {
        try {
          var prods = await db.products.bulkGet(productIds);
          prods.forEach(function (p) {
            if (p) {
              productSnapshots[p.id] = {
                name:       p.name       || ('SP #' + p.id),
                cost_price: Number(p.cost_price) || 0,
                sell_price: Number(p.sell_price) || 0,
                product_id: p.id,
                slug:       p.slug       || null
              };
            }
          });
        } catch (e) {
          console.warn('[SAFE_SALE] bulkGet products thất bại:', e.message);
        }
      }

      // ── 3. Tạo snapshot từng item ───────────────────────────
      var snapshots = [];
      for (var i = 0; i < rawItems.length; i++) {
        var raw = rawItems[i];
        var pid = Number(raw.productId) || Number(raw.product_id);
        var pInfo = productSnapshots[pid] || null;

        // Nếu không tìm được product → tạo snapshot với sell_price từ form
        if (!pInfo && raw.price && Number(raw.price) > 0) {
          pInfo = {
            name:       raw.product_name || ('SP #' + pid || 'SP đã xoá'),
            cost_price: Number(raw.cost_price) || Math.round(Number(raw.price) * 0.7),
            sell_price: Number(raw.price) || 0,
            product_id: pid,
            slug:       null
          };
        }

        var snap = await snapshotItem(raw, pInfo);
        if (snap.quantity > 0) snapshots.push(snap);
      }

      if (snapshots.length === 0) {
        return { success: false, error: 'Không có sản phẩm nào' };
      }

      // ── 4. Tính tổng ───────────────────────────────────────
      var totalAmount = snapshots.reduce(function (s, it) {
        return s + (it.price * it.quantity);
      }, 0);
      var totalProfit = snapshots.reduce(function (s, it) {
        return s + it.profit;
      }, 0);

      // ── 5. Ngày tháng (Việt Nam UTC+7) ────────────────────
      var vn = new Date(new Date().getTime() + 7 * 3600000);
      var dateStr = vn.getUTCFullYear() + '-' +
        String(vn.getUTCMonth() + 1).padStart(2, '0') + '-' +
        String(vn.getUTCDate()).padStart(2, '0');

      // ── 6. Lưu sale ────────────────────────────────────────
      var saleRecord = {
        customer_id:    customerId,
        customer_name:  customerInfo
          ? (customerInfo.name || ('KH_' + customerId))
          : (customerId ? ('KH_' + customerId) : 'KH_LE'),

        // Snapshot các trường bổ sung
        deliver_kegs:   deliverKegs,
        return_kegs:    returnKegs,

        date:           dateStr,
        createdAt:      new Date(),
        total:          totalAmount,
        profit:         totalProfit,
        total_amount:   totalAmount,
        total_profit:   totalProfit,

        synced: 0
      };

      var saleId;
      await db.transaction('rw', [db.sales, db.sale_items], async function () {
        saleId = await db.sales.add(saleRecord);

        for (var j = 0; j < snapshots.length; j++) {
          snapshots[j].sale_id = saleId;
          await db.sale_items.add(snapshots[j]);
        }
      });

      console.log('[SAFE_SALE] Đã lưu đơn #' + saleId +
        ' | Tổng: ' + fmtVND(totalAmount) +
        ' | Lợi nhuận: ' + fmtVND(totalProfit) +
        ' | Items: ' + snapshots.length);

      return {
        success: true,
        saleId:  saleId,
        total:   totalAmount,
        profit:  totalProfit,
        items:   snapshots.length
      };
    },

    // ── Cập nhật một đơn đã tồn tại (giữ snapshot) ───────────
    updateSale: async function (saleId, data) {
      await waitForDB();
      var db = window.db;

      var sale = await db.sales.get(Number(saleId));
      if (!sale) return { success: false, error: 'Không tìm thấy đơn #' + saleId };

      var newItems = Array.isArray(data.items) ? data.items : [];
      var newSnapshots = [];

      for (var i = 0; i < newItems.length; i++) {
        var raw   = newItems[i];
        var pid   = Number(raw.productId) || Number(raw.product_id);
        var pInfo = null;
        if (pid && db.products) {
          try { pInfo = await db.products.get(pid); } catch (_) {}
        }
        var snap = await snapshotItem(raw, pInfo);
        if (snap.quantity > 0) newSnapshots.push(snap);
      }

      var totalAmount = newSnapshots.reduce(function (s, it) { return s + it.price * it.quantity; }, 0);
      var totalProfit = newSnapshots.reduce(function (s, it) { return s + it.profit; }, 0);

      await db.transaction('rw', [db.sales, db.sale_items], async function () {
        // Cập nhật sale
        await db.sales.update(saleId, {
          total:         totalAmount,
          profit:        totalProfit,
          total_amount:  totalAmount,
          total_profit:  totalProfit,
          customer_id:   data.customerId ? Number(data.customerId) : sale.customer_id
        });

        // Xoá items cũ
        var oldItems = await db.sale_items.where('sale_id').equals(Number(saleId)).toArray();
        await Promise.all(oldItems.map(function (it) {
          return db.sale_items.delete(it.id);
        }));

        // Thêm items mới
        for (var j = 0; j < newSnapshots.length; j++) {
          newSnapshots[j].sale_id = Number(saleId);
          await db.sale_items.add(newSnapshots[j]);
        }
      });

      return { success: true, saleId: Number(saleId), total: totalAmount, profit: totalProfit };
    },

    // ── Lấy thông tin đơn (đầy đủ snapshot) ──────────────────
    getSale: async function (saleId) {
      await waitForDB();
      var db = window.db;
      var sale = await db.sales.get(Number(saleId));
      if (!sale) return null;
      var items = await db.sale_items.where('sale_id').equals(Number(saleId)).toArray();
      return { ...sale, items: items };
    },

    // ── Xoá đơn (cũng xoá hết items) ─────────────────────────
    deleteSale: async function (saleId) {
      await waitForDB();
      var db = window.db;
      await db.transaction('rw', [db.sales, db.sale_items], async function () {
        var items = await db.sale_items.where('sale_id').equals(Number(saleId)).toArray();
        await Promise.all(items.map(function (it) { return db.sale_items.delete(it.id); }));
        await db.sales.delete(Number(saleId));
      });
      return { success: true };
    }
  };

  console.log('[SAFE_SALE] Đã tải — window.__safeSale.createSale(data)');
})();
