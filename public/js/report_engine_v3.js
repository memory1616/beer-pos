// ============================================================
// report_engine_v3.js — Bộ máy báo cáo thế hệ 3
// Nguyên tắc:
//   - TUYỆT ĐỐI không JOIN bảng products/customers
//   - Chỉ đọc từ sales + sale_items
//   - Dùng snapshot đã lưu khi tạo đơn (safe_sale_service)
//   - Hoạt động hoàn toàn offline
// ============================================================

(function () {
  'use strict';

  // ── Tiện ích ──────────────────────────────────────────────
  function fmtVND(n) {
    return new Intl.NumberFormat('vi-VN').format(n || 0) + ' đ';
  }

  function safeNum(v) {
    var n = Number(v);
    return isNaN(n) || n < 0 ? 0 : n;
  }

  function escHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Đợi DB ───────────────────────────────────────────────
  function waitForDB() {
    return new Promise(function (resolve, reject) {
      if (!window.db) { reject(new Error('window.db chưa tải')); return; }
      if (window.dbReady) window.dbReady.then(resolve).catch(reject);
      else resolve();
    });
  }

  // ── Lấy dữ liệu thô (sales + items) theo khoảng ngày ────
  async function loadRawData(dateRange) {
    var db = window.db;
    dateRange = dateRange || {};

    var sales = [];
    try {
      sales = await db.sales
        .where('date')
        .between(dateRange.start || '', dateRange.end || '\xff', true, true)
        .toArray();
    } catch (e) {
      console.warn('[REPORT_V3] Lỗi đọc sales:', e.message);
    }

    var saleIds = sales.map(function (s) { return s.id; });
    var items  = [];
    if (saleIds.length > 0) {
      try {
        items = await db.sale_items.where('sale_id').anyOf(saleIds).toArray();
      } catch (e) {
        console.warn('[REPORT_V3] Lỗi đọc sale_items:', e.message);
      }
    }

    // Bảo đảm mỗi item có đầy đủ trường
    items = items.map(function (it) {
      var sale = sales.find(function (s) { return s.id === it.sale_id; }) || {};
      return {
        sale_id:         it.sale_id,
        sale_date:       sale.date || '',
        customer_id:     sale.customer_id || null,
        customer_name:   sale.customer_name || it._customer_name || 'Khách lẻ',
        product_id:      it.product_id  || null,
        product_name:    it.product_name || ('SP #' + (it.product_id || '?')),
        quantity:        Math.max(0, safeNum(it.quantity)),
        price:           safeNum(it.price),        // giá bán
        cost_price:      safeNum(it.cost_price),   // giá vốn
        profit:          safeNum(it.profit),
        profit_estimated: !!(it.profit_estimated)
      };
    });

    return { sales: sales, items: items };
  }

  // ══════════════════════════════════════════════════════════
  // PART 3a: getProfitByProduct — lợi nhuận theo sản phẩm
  // ══════════════════════════════════════════════════════════
  function getProfitByProduct(sales, items) {
    var byProduct = {};
    var totalEstimated = 0;

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var key = it.product_name || 'SP không tên';
      if (!byProduct[key]) {
        byProduct[key] = {
          name:           key,
          product_id:     it.product_id,
          quantity:       0,
          revenue:        0,
          cost:           0,
          profit:         0,
          estimated:      false,
          order_count:    0
        };
      }
      var qty = it.quantity;
      var price = it.price;
      var cp = it.cost_price;
      var profit = it.profit;

      byProduct[key].quantity   += qty;
      byProduct[key].revenue    += price * qty;
      byProduct[key].cost       += cp * qty;
      byProduct[key].profit     += profit;
      byProduct[key].order_count++;
      if (it.profit_estimated) {
        byProduct[key].estimated = true;
        totalEstimated++;
      }
    }

    var result = Object.values(byProduct);

    // Tính estimated_ratio
    var totalItems = result.reduce(function (s, p) { return s + p.order_count; }, 0);
    result = result.map(function (p) {
      p.estimated_ratio = totalItems > 0
        ? (p.estimated ? p.order_count / totalItems : 0)
        : 0;
      p.data_quality_score = 1 - p.estimated_ratio;
      p.revenue = Math.round(p.revenue);
      p.cost    = Math.round(p.cost);
      p.profit  = Math.round(p.profit);
      return p;
    });

    result.sort(function (a, b) { return b.profit - a.profit; });
    return result;
  }

  // ══════════════════════════════════════════════════════════
  // PART 3b: getProfitByCustomer — lợi nhuận theo khách hàng
  // ══════════════════════════════════════════════════════════
  function getProfitByCustomer(sales, items) {
    var byCustomer = {};
    var saleMap = {};
    sales.forEach(function (s) { saleMap[s.id] = s; });

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var sale = saleMap[it.sale_id] || {};
      var key = sale.customer_name || it.customer_name || 'Khách lẻ';

      if (!byCustomer[key]) {
        byCustomer[key] = {
          name:          key,
          customer_id:   sale.customer_id || null,
          order_count:   0,
          item_count:    0,
          revenue:       0,
          cost:          0,
          profit:        0
        };
      }

      var qty = it.quantity;
      byCustomer[key].item_count  += qty;
      byCustomer[key].order_count++;
      byCustomer[key].revenue    += it.price * qty;
      byCustomer[key].cost       += it.cost_price * qty;
      byCustomer[key].profit    += it.profit;
    }

    var result = Object.values(byCustomer);
    result = result.map(function (c) {
      c.revenue = Math.round(c.revenue);
      c.cost    = Math.round(c.cost);
      c.profit  = Math.round(c.profit);
      return c;
    });
    result.sort(function (a, b) { return b.profit - a.profit; });
    return result;
  }

  // ══════════════════════════════════════════════════════════
  // PART 3c: getProfitByTime — lợi nhuận theo ngày
  // ══════════════════════════════════════════════════════════
  function getProfitByTime(sales, items) {
    var byDate = {};
    var saleMap = {};
    sales.forEach(function (s) { saleMap[s.id] = s.date || ''; });

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var dateKey = (saleMap[it.sale_id] || '').split('T')[0];
      if (!dateKey) continue;

      if (!byDate[dateKey]) {
        byDate[dateKey] = { date: dateKey, revenue: 0, cost: 0, profit: 0, order_count: 0 };
      }
      var qty = it.quantity;
      byDate[dateKey].revenue    += it.price * qty;
      byDate[dateKey].cost       += it.cost_price * qty;
      byDate[dateKey].profit    += it.profit;
      byDate[dateKey].order_count++;
    }

    var result = Object.values(byDate);
    result = result.map(function (d) {
      d.revenue = Math.round(d.revenue);
      d.cost    = Math.round(d.cost);
      d.profit  = Math.round(d.profit);
      return d;
    });
    result.sort(function (a, b) { return a.date.localeCompare(b.date); });
    return result;
  }

  // ══════════════════════════════════════════════════════════
  // PART 3d: getDashboardStats — chỉ số tổng quan dashboard
  // ══════════════════════════════════════════════════════════
  function getDashboardStats(sales, items) {
    var totalRevenue = 0;
    var totalProfit  = 0;
    var totalCost    = 0;
    var estimatedCount = 0;
    var validItems   = 0;

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var qty = it.quantity;
      totalRevenue += it.price * qty;
      totalCost    += it.cost_price * qty;
      totalProfit  += it.profit;
      validItems++;
      if (it.profit_estimated) estimatedCount++;
    }

    var totalOrders     = sales.length;
    var avgOrderValue   = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    var avgProfitRate   = totalRevenue > 0 ? totalProfit / totalRevenue : 0;
    var estimated_ratio = validItems > 0 ? estimatedCount / validItems : 0;

    return {
      total_revenue:       Math.round(totalRevenue),
      total_profit:        Math.round(totalProfit),
      total_cost:          Math.round(totalCost),
      total_orders:        totalOrders,
      total_items:         validItems,
      avg_order_value:     Math.round(avgOrderValue),
      avg_profit_rate:     Math.round(avgProfitRate * 10000) / 10000,
      estimated_ratio:     Math.round(estimated_ratio * 10000) / 10000,
      data_quality_score:  Math.round((1 - estimated_ratio) * 10000) / 10000,
      warning:             estimated_ratio > 0
                           ? 'Dữ liệu bao gồm lợi nhuận ước tính (' + Math.round(estimated_ratio * 100) + '%)'
                           : null
    };
  }

  // ══════════════════════════════════════════════════════════
  // PART 3e: getTopProducts — top sản phẩm theo lợi nhuận
  // ══════════════════════════════════════════════════════════
  function getTopProducts(sales, items, limit) {
    limit = Math.max(1, Math.min(limit || 10, 100));
    var byProduct = getProfitByProduct(sales, items);
    return byProduct.slice(0, limit);
  }

  // ══════════════════════════════════════════════════════════
  // PART 3f: getWorstProducts — sản phẩm có lợi nhuận thấp nhất
  // ══════════════════════════════════════════════════════════
  function getWorstProducts(sales, items, limit) {
    limit = Math.max(1, Math.min(limit || 10, 100));
    var byProduct = getProfitByProduct(sales, items);
    var sorted = byProduct.sort(function (a, b) { return a.profit - b.profit; });
    return sorted.slice(0, limit);
  }

  // ── Tính lợi nhuận ròng (trừ chi phí) ──────────────────────
  function getNetProfit(stats, expenses) {
    var totalExpense = (expenses || []).reduce(function (s, e) {
      return s + safeNum(e.amount);
    }, 0);
    return {
      gross_profit:  stats.total_profit,
      expenses:      totalExpense,
      net_profit:    stats.total_profit - totalExpense
    };
  }

  // ── Tạo báo cáo đầy đủ theo khoảng ngày ───────────────────
  async function generateReport(dateRange, includeExpenses) {
    await waitForDB();
    var db = window.db;

    var raw = await loadRawData(dateRange);
    var sales = raw.sales, items = raw.items;

    // Tính expenses nếu cần
    var expenses = [];
    if (includeExpenses !== false) {
      try {
        expenses = await db.expenses
          .where('date')
          .between(dateRange.start || '', dateRange.end || '\xff', true, true)
          .toArray();
      } catch (e) {}
    }

    var stats        = getDashboardStats(sales, items);
    var net          = getNetProfit(stats, expenses);
    var profitByProduct  = getProfitByProduct(sales, items);
    var profitByCustomer = getProfitByCustomer(sales, items);
    var profitByTime     = getProfitByTime(sales, items);
    var topProducts      = profitByProduct.slice(0, 10);
    var worstProducts    = profitByProduct.slice(-10).reverse();

    return {
      generated_at:  new Date().toISOString(),
      date_range:    dateRange,
      sales:         sales,
      items_count:   items.length,
      stats:         { ...stats, ...net },
      profitByProduct:  profitByProduct,
      profitByCustomer: profitByCustomer,
      profitByTime:     profitByTime,
      topProducts:      topProducts,
      worstProducts:    worstProducts,
      expenses:         expenses
    };
  }

  // ── Xuất báo cáo ra HTML ───────────────────────────────────
  function exportToHTML(report) {
    var s = report.stats;
    var rows = report.profitByProduct.map(function (p) {
      var estNote = p.estimated_ratio > 0
        ? ' <span style="color:#D97706">⚠️</span>' : '';
      return '<tr><td>' + escHtml(p.name) + estNote + '</td>' +
             '<td>' + p.quantity + '</td>' +
             '<td>' + fmtVND(p.revenue) + '</td>' +
             '<td>' + fmtVND(p.cost) + '</td>' +
             '<td>' + fmtVND(p.profit) + '</td></tr>';
    }).join('\n');

    var html = '<!DOCTYPE html>\n<html lang="vi">\n<head>' +
      '<meta charset="UTF-8"><title>Báo cáo BeerPOS</title>' +
      '<style>body{font-family:sans-serif;padding:20px}' +
      '.card{padding:12px;border:1px solid #EAECEF;margin-bottom:12px}' +
      'table{width:100%;border-collapse:collapse}' +
      'th,td{padding:8px;border:1px solid #EAECEF;text-align:right}' +
      'th{background:#F5F5F5;text-align:left}' +
      '.warning{background:#FEF9C3;padding:8px;border-radius:4px}</style>' +
      '</head>\n<body>\n<h1>📊 Báo cáo BeerPOS</h1>' +
      '<div class="card"><strong>Từ ngày:</strong> ' + escHtml(report.date_range.start) +
      ' — <strong>đến ngày:</strong> ' + escHtml(report.date_range.end) + '</div>' +

      '<div class="card"><strong>Tổng doanh thu:</strong> ' + fmtVND(s.total_revenue) +
      ' | <strong>Lợi nhuận gộp:</strong> ' + fmtVND(s.total_profit) +
      ' | <strong>Lợi nhuận ròng:</strong> ' + fmtVND(s.net_profit) +
      ' | <strong>Đơn hàng:</strong> ' + s.total_orders +
      ' | <strong>Chất lượng dữ liệu:</strong> ' + Math.round(s.data_quality_score * 100) + '%' +
      (s.warning ? '<div class="warning">⚠️ ' + escHtml(s.warning) + '</div>' : '') +
      '</div>\n' +

      '<h2>Theo sản phẩm</h2>\n' +
      '<table><thead><tr><th>Tên</th><th>SL</th><th>Doanh thu</th><th>Giá vốn</th><th>Lợi nhuận</th></tr></thead>\n' +
      '<tbody>\n' + rows + '\n</tbody></table>\n' +
      '</body></html>';

    return html;
  }

  // ── Gán API toàn cục ────────────────────────────────────────
  window.__reportV3 = {
    loadRawData:          loadRawData,
    getProfitByProduct:   getProfitByProduct,
    getProfitByCustomer:  getProfitByCustomer,
    getProfitByTime:     getProfitByTime,
    getDashboardStats:    getDashboardStats,
    getTopProducts:       getTopProducts,
    getWorstProducts:    getWorstProducts,
    generateReport:      generateReport,
    exportToHTML:        exportToHTML
  };

  console.log('[REPORT_V3] Đã tải — TUYỆT ĐỐI không dùng JOIN products/customers');
  console.log('  window.__reportV3.generateReport(dateRange) — Tạo báo cáo đầy đủ');
  console.log('  window.__reportV3.getDashboardStats(sales, items) — Chỉ số tổng quan');
  console.log('  window.__reportV3.getProfitByProduct(sales, items) — Theo sản phẩm');
  console.log('  window.__reportV3.getProfitByCustomer(sales, items) — Theo khách hàng');
  console.log('  window.__reportV3.exportToHTML(report) — Xuất HTML');
})();
