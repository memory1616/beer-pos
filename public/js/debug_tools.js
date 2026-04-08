// ============================================================
// debug_tools.js — Công cụ kiểm tra toàn diện
// Chức năng:
//   - Kiểm tra tính toàn vẹn dữ liệu
//   - Phát hiện các giá trị bất thường
//   - Đưa ra cảnh báo để sửa chữa
// Sử dụng:
//   window.__debug.checkIntegrity()       — Kiểm tra toàn diện
//   window.__debug.quickSummary()       — Tóm tắt nhanh dữ liệu
//   window.__debug.findAnomalies()      — Tìm bất thường
// ============================================================

(function () {
  'use strict';

  async function waitForDB() {
    if (window.dbReady) { try { await window.dbReady; } catch (_) {} }
    if (!window.db) throw new Error('window.db chưa tải');
  }

  function fmtVND(n) {
    return new Intl.NumberFormat('vi-VN').format(n || 0) + ' đ';
  }

  function log(msg, type) {
    var tag = type === 'error' ? '[❌ DEBUG]' :
              type === 'warn'  ? '[⚠️ DEBUG]' :
                                 '[✅ DEBUG]';
    var fn = type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'log';
    console[fn](tag + ' ' + msg);
  }

  function safeNum(v) {
    var n = Number(v);
    return isNaN(n) ? 0 : n;
  }

  // ══════════════════════════════════════════════════════════
  // PART 7a: checkIntegrity — kiểm tra toàn vẹn dữ liệu
  // ══════════════════════════════════════════════════════════
  async function checkIntegrity() {
    await waitForDB();
    var db = window.db;

    log('===== KIỂM TRA TOÀN VẸN DỮ LIỆU =====', 'log');

    var allSales = await db.sales.toArray();
    var saleIds  = allSales.map(function (s) { return s.id; });
    var allItems = saleIds.length > 0
      ? await db.sale_items.where('sale_id').anyOf(saleIds).toArray()
      : [];

    var result = {
      sales_count:      allSales.length,
      items_count:      allItems.length,
      issues:           [],
      warnings:         [],
      score:            100,    // 100 = hoàn hảo, giảm theo lỗi
      passed:           true
    };

    // ── 1. Kiểm tra trường bắt buộc trong sale ────────────
    for (var i = 0; i < allSales.length; i++) {
      var s = allSales[i];

      if (s.id == null || s.id === '') {
        result.issues.push('Sale thiếu id: ' + JSON.stringify(s).substring(0, 80));
        result.score -= 5;
      }
      if (!s.date) {
        result.issues.push('Sale #' + s.id + ' thiếu trường date');
        result.score -= 2;
      }
      if (!s.customer_name) {
        result.warnings.push('Sale #' + s.id + ' thiếu customer_name');
        result.score -= 1;
      }
      if (s.createdAt && isNaN(new Date(s.createdAt).getTime())) {
        result.issues.push('Sale #' + s.id + ' có createdAt không hợp lệ');
        result.score -= 2;
      }
      // Lợi nhuận bất thường (âm nặng)
      if (safeNum(s.profit) < -(safeNum(s.total) * 10)) {
        result.issues.push('Sale #' + s.id + ' có lợi nhuận bất thường: ' + s.profit + ' (tổng: ' + s.total + ')');
        result.score -= 5;
      }
    }

    // ── 2. Kiểm tra trường bắt buộc trong item ───────────
    for (var j = 0; j < allItems.length; j++) {
      var it = allItems[j];

      if (it.sale_id == null || it.sale_id === '') {
        result.issues.push('Item #' + it.id + ' thiếu sale_id');
        result.score -= 5;
      }
      if (!it.product_name) {
        result.warnings.push('Item #' + it.id + ' thiếu product_name');
        result.score -= 1;
      }
      if (it.quantity == null || it.quantity === '') {
        result.issues.push('Item #' + it.id + ' thiếu quantity');
        result.score -= 2;
      }
      if (it.quantity < 0) {
        result.issues.push('Item #' + it.id + ' có quantity ÂM: ' + it.quantity);
        result.score -= 3;
      }
      if (it.price < 0) {
        result.issues.push('Item #' + it.id + ' có price ÂM: ' + it.price);
        result.score -= 3;
      }
      if (it.profit == null || it.profit === undefined) {
        result.warnings.push('Item #' + it.id + ' thiếu profit');
        result.score -= 1;
      }
      if (safeNum(it.profit) < -(safeNum(it.price) * safeNum(it.quantity) * 10)) {
        result.issues.push('Item #' + it.id + ' có lợi nhuận bất thường: ' + it.profit);
        result.score -= 5;
      }
      if (it.cost_price == null || it.cost_price === '') {
        result.warnings.push('Item #' + it.id + ' thiếu cost_price');
        result.score -= 0.5;
      }
      // Thời gian không hợp lệ
      if (it.createdAt && isNaN(new Date(it.createdAt).getTime())) {
        result.warnings.push('Item #' + it.id + ' có createdAt không hợp lệ');
      }
    }

    // ── 3. Kiểm tra sale_items không thuộc sale nào ───────
    var validSaleIds = new Set(allSales.map(function (s) { return s.id; }));
    var orphanItems = allItems.filter(function (it) {
      return !validSaleIds.has(it.sale_id);
    });
    if (orphanItems.length > 0) {
      result.issues.push('Phát hiện ' + orphanItems.length + ' item không thuộc sale nào (orphan)');
      result.score -= orphanItems.length;
    }

    // ── 4. Kiểm tra sale không có item nào ────────────────
    var saleItemCounts = {};
    allItems.forEach(function (it) {
      saleItemCounts[it.sale_id] = (saleItemCounts[it.sale_id] || 0) + 1;
    });
    for (var k = 0; k < allSales.length; k++) {
      var sk = allSales[k];
      if (!saleItemCounts[sk.id] || saleItemCounts[sk.id] === 0) {
        result.warnings.push('Sale #' + sk.id + ' không có mặt hàng nào');
        result.score -= 1;
      }
    }

    // ── 5. Kiểm tra trùng lặp sale_items trong cùng 1 sale ─
    var dupMap = {};
    for (var l = 0; l < allItems.length; l++) {
      var key = allItems[l].sale_id + '-' + allItems[l].product_id;
      if (!dupMap[key]) dupMap[key] = 0;
      dupMap[key]++;
    }
    var dups = Object.entries(dupMap).filter(function (_, v) { return v > 1; });
    if (dups.length > 0) {
      result.warnings.push('Phát hiện ' + dups.length + ' cặp item trùng lặp trong cùng sale');
    }

    result.score = Math.max(0, Math.round(result.score * 10) / 10);
    result.passed = result.issues.length === 0;

    // ── In kết quả ────────────────────────────────────────
    log('Tổng đơn: ' + allSales.length + ' | Tổng item: ' + allItems.length, 'log');
    log('Điểm sức khoẻ: ' + result.score + '/100', result.score < 80 ? 'warn' : 'log');
    log('Vấn đề nghiêm trọng: ' + result.issues.length, result.issues.length > 0 ? 'error' : 'log');
    log('Cảnh báo: ' + result.warnings.length, result.warnings.length > 0 ? 'warn' : 'log');

    if (result.issues.length > 0) {
      log('--- Vấn đề nghiêm trọng ---', 'error');
      result.issues.slice(0, 20).forEach(function (msg) { log('  ' + msg, 'error'); });
    }
    if (result.warnings.length > 0) {
      log('--- Cảnh báo ---', 'warn');
      result.warnings.slice(0, 20).forEach(function (msg) { log('  ' + msg, 'warn'); });
    }
    if (result.passed) {
      log('✅ Dữ liệu toàn vẹn — không có vấn đề nghiêm trọng!', 'log');
    }

    return result;
  }

  // ══════════════════════════════════════════════════════════
  // PART 7b: quickSummary — tóm tắt nhanh 1 dòng
  // ══════════════════════════════════════════════════════════
  async function quickSummary() {
    await waitForDB();
    var db = window.db;

    var allSales = await db.sales.toArray();
    var saleIds  = allSales.map(function (s) { return s.id; });
    var allItems = saleIds.length > 0
      ? await db.sale_items.where('sale_id').anyOf(saleIds).toArray()
      : [];
    var allProducts = db.products ? await db.products.toArray() : [];
    var allCustomers = db.customers ? await db.customers.toArray() : [];

    var totalRevenue = allItems.reduce(function (s, it) {
      return s + safeNum(it.price) * safeNum(it.quantity);
    }, 0);
    var totalProfit  = allItems.reduce(function (s, it) { return s + safeNum(it.profit); }, 0);
    var missingPN    = allItems.filter(function (it) { return !it.product_name; }).length;
    var missingCP    = allItems.filter(function (it) { return it.cost_price == null; }).length;
    var missingProf  = allItems.filter(function (it) { return it.profit == null; }).length;
    var missingCN    = allSales.filter(function (s) { return !s.customer_name; }).length;
    var estimated    = allItems.filter(function (it) { return it.profit_estimated; }).length;

    var summary = {
      sales:        allSales.length,
      items:        allItems.length,
      products:     allProducts.length,
      customers:    allCustomers.length,
      total_revenue: Math.round(totalRevenue),
      total_profit:  Math.round(totalProfit),
      missing_product_name: missingPN,
      missing_cost_price:   missingCP,
      missing_profit:       missingProf,
      missing_customer_name: missingCN,
      estimated_profit:     estimated
    };

    var qualityScore = allItems.length > 0
      ? Math.round((1 - (missingPN + missingCP + missingProf) / (allItems.length * 3)) * 100)
      : 100;

    log('【TÓM TẮT NHANH】', 'log');
    log('  Đơn hàng: ' + summary.sales +
        ' | Mặt hàng: ' + summary.items +
        ' | SP: ' + summary.products +
        ' | KH: ' + summary.customers, 'log');
    log('  Tổng DT: ' + fmtVND(summary.total_revenue) +
        ' | Lợi nhuận: ' + fmtVND(summary.total_profit), 'log');
    log('  Chất lượng: ' + qualityScore + '%', qualityScore < 90 ? 'warn' : 'log');
    log('  ⚠️ Thiếu product_name: ' + missingPN +
        ' | Thiếu cost_price: ' + missingCP +
        ' | Thiếu profit: ' + missingProf, 'log');
    log('  ⚠️ Thiếu customer_name: ' + missingCN +
        ' | Ước tính: ' + estimated, 'log');

    return summary;
  }

  // ══════════════════════════════════════════════════════════
  // PART 7c: findAnomalies — tìm các bất thường
  // ══════════════════════════════════════════════════════════
  async function findAnomalies() {
    await waitForDB();
    var db = window.db;

    log('===== TÌM BẤT THƯỜNG =====', 'log');

    var allSales = await db.sales.toArray();
    var saleIds  = allSales.map(function (s) { return s.id; });
    var allItems = saleIds.length > 0
      ? await db.sale_items.where('sale_id').anyOf(saleIds).toArray()
      : [];

    var anomalies = [];

    // ── 1. Đơn có lợi nhuận âm ──────────────────────────
    var lossSales = allSales.filter(function (s) {
      return safeNum(s.profit) < 0;
    });
    if (lossSales.length > 0) {
      anomalies.push({ type: 'loss_sale', count: lossSales.length, items: lossSales.slice(0, 5) });
      log('Đơn hàng LỖ: ' + lossSales.length + ' đơn (lợi nhuận âm)', 'warn');
    }

    // ── 2. Item có lợi nhuận âm ─────────────────────────
    var lossItems = allItems.filter(function (it) {
      return safeNum(it.profit) < 0;
    });
    if (lossItems.length > 0) {
      anomalies.push({ type: 'loss_item', count: lossItems.length, items: lossItems.slice(0, 5) });
      log('Mặt hàng LỖ: ' + lossItems.length + ' item (lợi nhuận âm)', 'warn');
    }

    // ── 3. Item có giá bán bằng 0 ───────────────────────
    var freeItems = allItems.filter(function (it) {
      return safeNum(it.price) === 0 && safeNum(it.quantity) > 0;
    });
    if (freeItems.length > 0) {
      anomalies.push({ type: 'free_item', count: freeItems.length, items: freeItems.slice(0, 5) });
      log('Mặt hàng GIÁ 0: ' + freeItems.length + ' item', 'warn');
    }

    // ── 4. Item có số lượng rất lớn (>1000) ──────────────
    var hugeQty = allItems.filter(function (it) { return safeNum(it.quantity) > 1000; });
    if (hugeQty.length > 0) {
      anomalies.push({ type: 'huge_quantity', count: hugeQty.length, items: hugeQty.slice(0, 5) });
      log('Số lượng bất thường: ' + hugeQty.length + ' item (>1000)', 'warn');
    }

    // ── 5. Đơn có tổng tiền = 0 ──────────────────────────
    var emptySales = allSales.filter(function (s) {
      return safeNum(s.total) === 0;
    });
    if (emptySales.length > 0) {
      anomalies.push({ type: 'empty_sale', count: emptySales.length, items: emptySales.slice(0, 5) });
      log('Đơn hàng TRỐNG: ' + emptySales.length + ' đơn (tổng = 0)', 'warn');
    }

    // ── 6. Đơn có tổng không khớp với tổng items ────────
    var saleMap = {};
    allItems.forEach(function (it) {
      if (!saleMap[it.sale_id]) saleMap[it.sale_id] = 0;
      saleMap[it.sale_id] += safeNum(it.price) * safeNum(it.quantity);
    });
    var mismatched = allSales.filter(function (s) {
      return saleMap[s.id] && Math.abs(saleMap[s.id] - safeNum(s.total)) > 100;
    });
    if (mismatched.length > 0) {
      anomalies.push({ type: 'total_mismatch', count: mismatched.length, items: mismatched.slice(0, 5) });
      log('Tổng tiền KHÔNG KHỚP: ' + mismatched.length + ' đơn', 'warn');
    }

    // ── 7. Item thiếu product_name ───────────────────────
    var noName = allItems.filter(function (it) { return !it.product_name; });
    if (noName.length > 0) {
      anomalies.push({ type: 'missing_product_name', count: noName.length, items: noName.slice(0, 5) });
      log('Thiếu product_name: ' + noName.length + ' item', 'warn');
    }

    if (anomalies.length === 0) {
      log('✅ Không phát hiện bất thường nào!', 'log');
    } else {
      log('Tổng cộng ' + anomalies.length + ' loại bất thường', 'warn');
    }

    return anomalies;
  }

  // ── Gán API toàn cục ────────────────────────────────────
  window.__debug = {
    checkIntegrity:  checkIntegrity,
    quickSummary:    quickSummary,
    findAnomalies:   findAnomalies
  };

  console.log('[DEBUG] Đã tải — window.__debug.checkIntegrity() | .quickSummary() | .findAnomalies()');
})();
