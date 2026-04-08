// ============================================================
// recovery_full.js — Chuẩn hoá & phục hồi dữ liệu
// Phiên bản: v2 (thay thế recovery.js cũ)
// Mục đích:
//   - Sửa lỗi dữ liệu hiện tại
//   - Chạy migrate lên schema v39
//   - Đảm bảo report hoạt động không phụ thuộc products/customers
// Sử dụng: browser console → window.__recovery.normalizeAllData()
// ============================================================

(function () {
  'use strict';

  // ── Chờ DB sẵn sàng ───────────────────────────────────────────
  async function waitForDB() {
    if (window.dbReady) {
      try { await window.dbReady; } catch (_) {}
    }
    if (!window.db) throw new Error('[RECOVERY_FULL] window.db chưa được tải');
  }

  // ── Định dạng tiền VND ───────────────────────────────────────
  function fmtVND(n) {
    return new Intl.NumberFormat('vi-VN').format(n || 0) + ' đ';
  }

  // ── Ghi log có timestamp ───────────────────────────────────────
  function log(msg, type) {
    var ts = new Date().toLocaleTimeString('vi-VN');
    var prefix = type === 'warn' ? '[⚠️ RECOVERY_FULL]' :
                type === 'err'  ? '[❌ RECOVERY_FULL]' :
                                 '[✅ RECOVERY_FULL]';
    console[type === 'warn' ? 'warn' : type === 'err' ? 'error' : 'log'](
      prefix + ' [' + ts + '] ' + msg
    );
  }

  // ── PART 1: Chuẩn hoá dữ liệu từng đơn hàng ─────────────────
  async function normalizeAllData() {
    await waitForDB();
    var db = window.db;

    log('===== BẮT ĐẦU CHUẨN HOÁ DỮ LIỆU =====', 'log');
    var t0 = Date.now();

    var allSales = await db.sales.toArray();
    var saleIds  = allSales.map(function (s) { return s.id; });
    var allItems = saleIds.length > 0
      ? await db.sale_items.where('sale_id').anyOf(saleIds).toArray()
      : [];

    var stats = {
      totalSales:          allSales.length,
      totalItems:          allItems.length,
      fixedSales:          0,
      fixedItems:          0,
      estimatedItems:      0,
      addedCreatedAt:      0,
      addedCustomerName:   0,
      addedProductName:    0,
      addedCostPrice:      0,
      recalculatedProfit:  0,
      totalRecalculatedProfit: 0,
      errors:              []
    };

    // Tạo map: product_id → {name, cost_price} (để fill nhanh)
    var productMap = {};
    if (db.products) {
      var prods = await db.products.toArray();
      prods.forEach(function (p) {
        productMap[p.id] = {
          name:       p.name || ('SP #' + p.id),
          cost_price: Number(p.cost_price) || 0,
          sell_price: Number(p.sell_price) || 0
        };
      });
      log('Đã nạp ' + prods.length + ' sản phẩm vào map', 'log');
    }

    // Tạo map: customer_id → name
    var customerMap = {};
    if (db.customers) {
      var custs = await db.customers.toArray();
      custs.forEach(function (c) {
        customerMap[c.id] = c.name || ('KH #' + c.id);
      });
      log('Đã nạp ' + custs.length + ' khách hàng vào map', 'log');
    }

    // ── Lặp từng sale ──────────────────────────────────────────
    for (var si = 0; si < allSales.length; si++) {
      var sale = allSales[si];
      var saleUpdates = {};
      var saleItems   = allItems.filter(function (it) { return it.sale_id === sale.id; });
      var saleFixed   = false;

      // ── Sale: createdAt ──────────────────────────────────────
      if (!sale.createdAt) {
        saleUpdates.createdAt = sale.date
          ? new Date(sale.date + 'T00:00:00+07:00')
          : new Date();
        stats.addedCreatedAt++;
        saleFixed = true;
      }

      // ── Sale: customer_name ──────────────────────────────────
      if (!sale.customer_name) {
        var custId   = sale.customer_id;
        var custName = custId ? (customerMap[custId] || ('KH_' + custId)) : 'KH_LE';
        saleUpdates.customer_name = custName;
        stats.addedCustomerName++;
        saleFixed = true;
      }

      // ── Sale: đảm bảo total_amount ─────────────────────────
      var computedTotal = 0;
      saleItems.forEach(function (it) {
        computedTotal += (Number(it.price) || 0) * (Number(it.quantity) || 0);
      });
      if (sale.total_amount == null || sale.total_amount === '') {
        saleUpdates.total_amount = computedTotal;
        saleFixed = true;
      }

      // ── Sale: đảm bảo total_profit ───────────────────────────
      var computedProfit = saleItems.reduce(function (s, it) {
        return s + (Number(it.profit) || 0);
      }, 0);
      if (sale.total_profit == null || sale.total_profit === '') {
        saleUpdates.total_profit = computedProfit;
        stats.totalRecalculatedProfit += computedProfit;
        saleFixed = true;
      }

      // Lưu sale updates
      if (Object.keys(saleUpdates).length > 0) {
        await db.sales.update(sale.id, saleUpdates);
        stats.fixedSales++;
      }

      // ── Lặp từng item ───────────────────────────────────────
      for (var ji = 0; ji < saleItems.length; ji++) {
        var item = saleItems[ji];
        var itemUpdates = {};
        var itemFixed   = false;

        // product_name
        if (!item.product_name) {
          var pid  = item.product_id;
          var name = pid ? (productMap[pid] ? productMap[pid].name : 'SP đã xoá (' + pid + ')')
                        : 'SP đã xoá (unknown)';
          itemUpdates.product_name = name;
          stats.addedProductName++;
          itemFixed = true;
        }

        // quantity → >= 0
        if (item.quantity == null || item.quantity === '' || item.quantity < 0) {
          itemUpdates.quantity = Math.abs(Number(item.quantity) || 0);
          itemFixed = true;
        }

        // sell_price
        var sellPrice = Number(item.price) || 0;
        if (item.price == null || item.price === '' || item.price < 0) {
          // Thử lấy từ products
          if (item.product_id && productMap[item.product_id]) {
            itemUpdates.price = productMap[item.product_id].sell_price || 0;
          } else {
            itemUpdates.price = 0;
          }
          itemFixed = true;
        }

        // cost_price
        var costPrice = Number(item.cost_price) || 0;
        if (item.cost_price == null || item.cost_price === '' || item.cost_price === 0) {
          var refCP = item.product_id && productMap[item.product_id]
            ? productMap[item.product_id].cost_price
            : 0;
          if (refCP > 0) {
            itemUpdates.cost_price = refCP;
          } else {
            // Fallback: ước tính 70% giá bán
            itemUpdates.cost_price    = Math.round(sellPrice * 0.7);
            itemUpdates.profit_estimated = true;
          }
          stats.addedCostPrice++;
          itemFixed = true;
        }

        // profit
        var currentProfit = Number(item.profit);
        if (item.profit == null || item.profit === '' || typeof item.profit !== 'number' || isNaN(currentProfit)) {
          var qty   = Number(item.quantity) || 0;
          var cp    = Number(itemUpdates.cost_price) || costPrice || Math.round(sellPrice * 0.7);
          var finalCP = cp > 0 ? cp : Math.round(sellPrice * 0.7);
          var calcProfit = (sellPrice - finalCP) * qty;
          itemUpdates.profit = calcProfit;
          itemUpdates.profit_estimated = (cp <= 0);
          stats.recalculatedProfit++;
          stats.totalRecalculatedProfit += calcProfit;
          itemFixed = true;
        } else {
          // Kiểm tra profit có âm bất thường không
          if (currentProfit < -(sellPrice * (Number(item.quantity) || 0) * 10)) {
            log('Phát hiện lợi nhuận bất thường ở item.id=' + item.id + ': ' + currentProfit, 'warn');
          }
        }

        // Đảm bảo profit_estimated flag tồn tại (sau khi tính xong)
        if (itemFixed && itemUpdates.profit_estimated === undefined) {
          itemUpdates.profit_estimated = false;
        }

        // Log 10 item đầu tiên được sửa
        if (itemFixed && stats.fixedItems < 10) {
          log('  [Sửa] item.id=' + item.id +
              ' | product_name: ' + (itemUpdates.product_name || item.product_name || '?') +
              ' | profit: ' + (itemUpdates.profit || currentProfit || '?') +
              (itemUpdates.profit_estimated ? ' [ước tính]' : ''), 'log');
        }

        if (Object.keys(itemUpdates).length > 0) {
          await db.sale_items.update(item.id, itemUpdates);
          stats.fixedItems++;
          if (itemUpdates.profit_estimated) stats.estimatedItems++;
        }
      }
    }

    // ── Tổng hợp lại sale.total_profit sau khi đã fix items ──
    var allItemsAfter = saleIds.length > 0
      ? await db.sale_items.where('sale_id').anyOf(saleIds).toArray()
      : [];
    for (var si2 = 0; si2 < allSales.length; si2++) {
      var s = allSales[si2];
      var sItems = allItemsAfter.filter(function (it) { return it.sale_id === s.id; });
      var sProfit = sItems.reduce(function (sum, it) { return sum + (Number(it.profit) || 0); }, 0);
      if (sProfit !== (Number(s.total_profit) || 0) && sProfit !== (Number(s.profit) || 0)) {
        await db.sales.update(s.id, { total_profit: sProfit, profit: sProfit });
        stats.recalculatedProfit++;
      }
    }

    var elapsed = ((Date.now() - t0) / 1000).toFixed(2);

    // ── In bảng tổng kết ──────────────────────────────────────
    log('===== KẾT QUẢ CHUẨN HOÁ =====', 'log');
    log('Tổng đơn hàng        : ' + stats.totalSales, 'log');
    log('Tổng mặt hàng        : ' + stats.totalItems, 'log');
    log('Đơn đã sửa           : ' + stats.fixedSales, 'log');
    log('Item đã sửa          : ' + stats.fixedItems, 'log');
    log('  - Thêm createdAt    : ' + stats.addedCreatedAt, 'log');
    log('  - Thêm customer_name: ' + stats.addedCustomerName, 'log');
    log('  - Thêm product_name : ' + stats.addedProductName, 'log');
    log('  - Thêm cost_price    : ' + stats.addedCostPrice, 'log');
    log('  - Item ước tính     : ' + stats.estimatedItems, 'log');
    log('  - Lợi nhuận tính lại: ' + stats.recalculatedProfit, 'log');
    log('Tổng lợi nhuận đã xử lý: ' + fmtVND(stats.totalRecalculatedProfit), 'log');
    log('Thời gian chạy       : ' + elapsed + 's', 'log');
    log('===== HOÀN TẤT =====', 'log');

    return stats;
  }

  // ── PART 8: Migration v39 (chạy 1 lần duy nhất) ─────────────
  async function migrateToV39() {
    await waitForDB();
    var db = window.db;

    log('===== MIGRATION v39 =====', 'log');
    var done = localStorage.getItem('_migration_v39_done');
    if (done) {
      log('v39 đã chạy rồi — bỏ qua', 'log');
      return { status: 'skipped', reason: 'already done' };
    }

    var allSales = await db.sales.toArray();
    var saleIds  = allSales.map(function (s) { return s.id; });
    var allItems = saleIds.length > 0
      ? await db.sale_items.where('sale_id').anyOf(saleIds).toArray()
      : [];

    // Tạo map sản phẩm
    var productMap = {};
    if (db.products) {
      (await db.products.toArray()).forEach(function (p) {
        productMap[p.id] = p;
      });
    }

    var fixed = 0;
    for (var i = 0; i < allItems.length; i++) {
      var it = allItems[i];
      var up = {};

      if (it.product_name === undefined) {
        var pRef = productMap[it.product_id];
        up.product_name = pRef ? (pRef.name || 'SP đã xoá') : 'SP đã xoá (unknown)';
        fixed++;
      }
      if (it.cost_price === undefined) {
        var pRef2 = productMap[it.product_id];
        up.cost_price = pRef2 ? (Number(pRef2.cost_price) || 0) : 0;
        fixed++;
      }
      if (it.profit === undefined) {
        var sp2 = Number(it.price) || 0;
        var cp2 = Number(up.cost_price) || Number(it.cost_price) || 0;
        up.profit = (sp2 - cp2) * (Number(it.quantity) || 0);
        fixed++;
      }
      if (it.profit_estimated === undefined) up.profit_estimated = false;
      if (Object.keys(up).length > 0) await db.sale_items.update(it.id, up);
    }

    for (var j = 0; j < allSales.length; j++) {
      var s2 = allSales[j];
      var us = {};
      if (s2.customer_name === undefined) {
        us.customer_name = s2.customer_id ? ('KH_' + s2.customer_id) : 'KH_LE';
        fixed++;
      }
      if (Object.keys(us).length > 0) await db.sales.update(s2.id, us);
    }

    localStorage.setItem('_migration_v39_done', 'true');
    log('v39 migration hoàn tất — đã sửa ' + fixed + ' bản ghi', 'log');
    return { status: 'done', fixed: fixed };
  }

  // ── Kiểm tra xem dữ liệu đã sạch chưa ─────────────────────
  async function checkDataHealth() {
    await waitForDB();
    var db = window.db;
    var allSales = await db.sales.toArray();
    var saleIds  = allSales.map(function (s) { return s.id; });
    var allItems = saleIds.length > 0
      ? await db.sale_items.where('sale_id').anyOf(saleIds).toArray()
      : [];

    var issues = { sales: 0, items: 0, details: [] };

    for (var i = 0; i < allSales.length; i++) {
      var s = allSales[i];
      var problems = [];
      if (!s.customer_name) problems.push('missing customer_name');
      if (!s.date)          problems.push('missing date');
      if (s.profit < 0)     problems.push('negative profit');
      if (problems.length > 0) {
        issues.sales++;
        issues.details.push('Sale #' + s.id + ': ' + problems.join(', '));
      }
    }

    for (var j = 0; j < allItems.length; j++) {
      var it = allItems[j];
      var problems = [];
      if (!it.product_name)     problems.push('missing product_name');
      if (it.cost_price == null || it.cost_price === '') problems.push('missing cost_price');
      if (it.profit == null || it.profit === undefined)   problems.push('missing profit');
      if (it.quantity < 0)                            problems.push('negative quantity');
      if (it.price < 0)                                problems.push('negative price');
      if (problems.length > 0) {
        issues.items++;
        issues.details.push('Item #' + it.id + ': ' + problems.join(', '));
      }
    }

    if (issues.sales === 0 && issues.items === 0) {
      log('Dữ liệu sạch — không có vấn đề!', 'log');
    } else {
      log('Phát hiện vấn đề: ' + issues.sales + ' đơn, ' + issues.items + ' mặt hàng', 'warn');
      issues.details.slice(0, 20).forEach(function (d) { log('  ' + d, 'warn'); });
    }

    return issues;
  }

  // ── Gán API toàn cục ─────────────────────────────────────────
  window.__recovery = {
    normalizeAllData: normalizeAllData,
    migrateToV39:     migrateToV39,
    checkDataHealth:  checkDataHealth
  };

  log('recovery_full.js đã tải xong!', 'log');
  log('  window.__recovery.normalizeAllData() — Chuẩn hoá toàn bộ dữ liệu', 'log');
  log('  window.__recovery.migrateToV39()     — Chạy migration v39 (1 lần)', 'log');
  log('  window.__recovery.checkDataHealth()  — Kiểm tra sức khoẻ dữ liệu', 'log');
})();
