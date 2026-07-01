/**
 * Report Data API
 * Handles /report/data endpoint - aggregated report data for dashboard and report page.
 * Supports both dashboard format (?mode=quick&period=today|week|month)
 * and report page format (?type=month&month=4&year=2026)
 */

const express = require('express');
const router = express.Router();
const db = require('../database');

function litersFromProductName(name) {
  if (!name) return 1;
  var m = String(name).match(/(\d+)\s*[Ll]/);
  return m ? parseInt(m[1], 10) : 1;
}

router.get('/data', (req, res) => {
  try {
    var now = new Date();
    var vn = new Date(now.getTime() + 7 * 3600000);
    var year = String(vn.getUTCFullYear());
    var month = String(vn.getUTCMonth() + 1).padStart(2, '0');
    var day = String(vn.getUTCDate()).padStart(2, '0');
    var today = year + '-' + month + '-' + day;
    var startDate, endDate;

    var type = req.query.type;
    if (type) {
      var rYear = parseInt(req.query.year) || vn.getUTCFullYear();
      var rMonth = parseInt(req.query.month);
      if (type === 'month' && rMonth) {
        var lastDay = new Date(rYear, rMonth, 0).getDate();
        startDate = rYear + '-' + String(rMonth).padStart(2, '0') + '-01';
        endDate = rYear + '-' + String(rMonth).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');
      } else if (type === 'year') {
        startDate = rYear + '-01-01';
        endDate = rYear + '-12-31';
      } else if (type === 'custom' && req.query.startDate && req.query.endDate) {
        startDate = req.query.startDate;
        endDate = req.query.endDate;
      } else {
        startDate = '1970-01-01';
        endDate = '2100-12-31';
      }
    } else {
      var mode = req.query.mode || 'quick';
      var period = req.query.period || 'today';
      var fromParam = req.query.from;
      var toParam = req.query.to;

      if (mode === 'custom' && fromParam && toParam) {
        startDate = fromParam;
        endDate = toParam;
      } else if (period === 'today') {
        startDate = today;
        endDate = today;
      } else if (period === 'week') {
        var wa = new Date(vn); wa.setUTCDate(wa.getUTCDate() - 7);
        startDate = wa.getUTCFullYear() + '-' + String(wa.getUTCMonth()+1).padStart(2,'0') + '-' + String(wa.getUTCDate()).padStart(2,'0');
        endDate = today;
      } else {
        startDate = year + '-' + month + '-01';
        endDate = today;
      }
    }

    // Detect which date column exists in sales table for backward compatibility
    var dateCol = 's.date';
    try {
      var cols = db.prepare("PRAGMA table_info(sales)").all().map(r => r.name);
      if (!cols.includes('date')) {
        if (cols.includes('created_at')) {
          dateCol = 's.created_at';
        }
      }
    } catch(_) {}

    var startDay = startDate.split(' ')[0];
    var endDay = endDate.split(' ')[0];
    var dateCond = 'date(' + dateCol + ') >= date(?) AND date(' + dateCol + ') <= date(?)';
    var dateParams = [startDay, endDay];
    var salesDateBare = dateCol.indexOf('created_at') !== -1 ? 'created_at' : 'date';

    // Main sales query - CHỈ lấy type='sale', KHÔNG lấy replacement/gift (đúng với KPI)
    var sales = db.prepare(
      "SELECT s.id, s.customer_id, s.date, s.total, s.profit, s.type, s.deliver_kegs, s.return_kegs, COALESCE(c.name, 'Khách lẻ') as customer_name, (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id) as quantity FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.archived = 0 AND s.type = 'sale' AND (s.status IS NULL OR s.status != 'returned') AND " + dateCond +
      " ORDER BY datetime(" + dateCol + ") DESC LIMIT 200"
    ).all(...dateParams);

    // Aggregated KPIs - loại trừ returned (bao gồm MONTHLY_BONUS vì có doanh thu thực)
    var revR = db.prepare('SELECT COALESCE(SUM(total), 0) as t FROM sales WHERE archived = 0 AND (status IS NULL OR status != \'returned\') AND type = \'sale\' AND date(' + salesDateBare + ') >= date(?) AND date(' + salesDateBare + ') <= date(?)').get(...dateParams);
    var profR = db.prepare('SELECT COALESCE(SUM(profit), 0) as t FROM sales WHERE archived = 0 AND (status IS NULL OR status != \'returned\') AND type = \'sale\' AND date(' + salesDateBare + ') >= date(?) AND date(' + salesDateBare + ') <= date(?)').get(...dateParams);
    var ordR = db.prepare('SELECT COUNT(*) as t FROM sales WHERE archived = 0 AND (status IS NULL OR status != \'returned\') AND type = \'sale\' AND date(' + salesDateBare + ') >= date(?) AND date(' + salesDateBare + ') <= date(?)').get(...dateParams);
    var totalRevenue = revR ? revR.t : 0;
    var totalProfit = profR ? profR.t : 0;
    var totalOrders = ordR ? ordR.t : 0;
    var totalExpense = 0;
    try { var expR = db.prepare('SELECT COALESCE(SUM(amount), 0) as t FROM expenses WHERE archived = 0 AND date >= ? AND date <= ?').get(startDay, endDay); totalExpense = expR ? expR.t : 0; } catch(_){}

    // ===== Hàng cần xuất hôm nay =====
    var todayStr = today; // Dùng cùng format với biến today đã tính ở trên
    var todayDeliver = db.prepare(`
      SELECT COALESCE(SUM(deliver_kegs), 0) as total_deliver, COALESCE(SUM(return_kegs), 0) as total_return,
      COUNT(*) as order_count
      FROM sales WHERE archived = 0 AND type = 'sale' AND (status IS NULL OR status != 'returned')
      AND date(date) = date(?)
    `).get(todayStr);
    var todayKegs = (todayDeliver ? todayDeliver.total_deliver : 0) - (todayDeliver ? todayDeliver.total_return : 0);
    var todayOrderCount = todayDeliver ? todayDeliver.order_count : 0;

    // Chi tiết sản phẩm cần xuất hôm nay (bao gồm cả khuyến mãi, KHÔNG phân biệt giá)
    var todayProducts = db.prepare(`
      SELECT p.name, SUM(si.quantity) as qty, p.type
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      WHERE s.archived = 0 AND s.type = 'sale'
      AND (s.status IS NULL OR s.status != 'returned')
      AND date(s.date) = date(?)
      GROUP BY p.id
      ORDER BY qty DESC
    `).all(todayStr);

    // Daily breakdown - bao gồm tất cả đơn có doanh thu
    var daily = db.prepare(
      "SELECT date(" + dateCol + ") as date, COALESCE(SUM(s.total), 0) as revenue, COALESCE(SUM(s.profit), 0) as profit, COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.archived = 0 AND date(e.date) = date(" + dateCol + ")), 0) as expense FROM sales s WHERE s.archived = 0 AND s.type = 'sale' AND (s.status IS NULL OR s.status != 'returned') AND " + dateCond +
      " GROUP BY date(" + dateCol + ") ORDER BY date DESC LIMIT 30"
    ).all(...dateParams);

    // Profit by product (loại trừ items free/price=0)
    var profitByProduct = db.prepare(
      'SELECT p.id, p.name, p.type, SUM(si.quantity) as quantity_sold, COUNT(DISTINCT si.sale_id) as order_count, SUM(si.quantity * si.price) as revenue, SUM(si.quantity * si.cost_price) as cost, SUM(si.profit) as profit FROM sale_items si JOIN products p ON p.id = si.product_id JOIN sales s ON s.id = si.sale_id WHERE s.archived = 0 AND s.type = \'sale\' AND si.price > 0 AND (s.status IS NULL OR s.status != \'returned\') AND ' + dateCond +
      ' GROUP BY p.id ORDER BY SUM(si.profit) DESC LIMIT 20'
    ).all(...dateParams);

    // Profit by customer (loại trừ items free/price=0)
    // Dùng SUM(si.profit) thay vì SUM(s.profit) để tránh duplicate khi JOIN tạo multiple rows
    var profitByCustomer = db.prepare(
      'SELECT c.id, c.name, COUNT(DISTINCT s.id) as order_count, SUM(s.total) as revenue, SUM(si.profit) as profit, SUM(si.quantity) as qty ' +
      'FROM sales s JOIN customers c ON c.id = s.customer_id JOIN sale_items si ON si.sale_id = s.id AND si.price > 0 WHERE s.archived = 0 AND s.type = \'sale\' AND ' + dateCond +
      ' GROUP BY c.id ORDER BY profit DESC'
    ).all(...dateParams);

    var literRows = db.prepare(
      'SELECT s.customer_id, p.name as product_name, si.quantity ' +
      'FROM sale_items si ' +
      'JOIN sales s ON s.id = si.sale_id ' +
      'JOIN products p ON p.id = si.product_id ' +
      "WHERE s.archived = 0 AND s.type = 'sale' AND si.price > 0 AND (s.status IS NULL OR s.status != 'returned') AND " + dateCond
    ).all(...dateParams);
    var literByCustomerId = {};
    for (var lr = 0; lr < literRows.length; lr++) {
      var cid = literRows[lr].customer_id;
      if (cid == null) continue;
      var L = litersFromProductName(literRows[lr].product_name) * (Number(literRows[lr].quantity) || 0);
      literByCustomerId[cid] = (literByCustomerId[cid] || 0) + L;
    }
    profitByCustomer = profitByCustomer.map(function (row) {
      return Object.assign({}, row, { quantity: literByCustomerId[row.id] || 0 });
    });

    // Purchases
    var purchases = [];
    try {
      var purchaseCols = db.prepare("PRAGMA table_info(purchases)").all().map(r => r.name);
      var purchaseDateCol = purchaseCols.includes('date') ? 'date' : (purchaseCols.includes('created_at') ? 'created_at' : 'date');
      var purchaseDateCond = 'date(' + purchaseDateCol + ') >= date(?) AND date(' + purchaseDateCol + ') <= date(?)';
      purchases = db.prepare(
        "SELECT p.id, p.date, p.total_amount as total, COALESCE(p.note, '') as note, " +
        "(SELECT COUNT(*) FROM purchase_items WHERE purchase_id = p.id) as item_count " +
        "FROM purchases p WHERE p.archived = 0 AND " + purchaseDateCond + " ORDER BY datetime(" + purchaseDateCol + ") DESC"
      ).all(...dateParams);
      for (var pi = 0; pi < purchases.length; pi++) {
        purchases[pi].items = db.prepare(
          "SELECT pi.product_id, pr.name as product_name, pi.quantity, pi.unit_price, pi.total_price " +
          "FROM purchase_items pi JOIN products pr ON pr.id = pi.product_id WHERE pi.purchase_id = ?"
        ).all(purchases[pi].id);
      }
    } catch(e) {
      console.error('[REPORT] Purchases query error:', e.message);
    }

    var totalPurchaseAmount = purchases.reduce(function(s, p) { return s + (p.total || 0); }, 0);

    res.json({ 
      sales, totalRevenue, totalProfit, totalOrders, totalExpense, 
      daily, profitByProduct, profitByCustomer, purchases, totalPurchaseAmount,
      todayDeliveries: { totalKegs: todayKegs, orderCount: todayOrderCount, products: todayProducts }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// ============================================================
// BONUS REPORT API - Báo cáo trả thưởng (KHÔNG phụ thuộc bộ lọc ngày)
// ============================================================
router.get('/bonus-report', (req, res) => {
  try {
    var now = new Date();
    var vn = new Date(now.getTime() + 7 * 3600000);
    var currentMonth = vn.getUTCMonth() + 1;
    var currentYear = vn.getUTCFullYear();

    // Xác định tháng báo cáo từ query (mặc định = tháng hiện tại)
    var reportMonth = parseInt(req.query.month) || currentMonth;
    var reportYear = parseInt(req.query.year) || currentYear;

    // Tháng trước = tháng của kỳ thưởng
    var rewardMonth = reportMonth === 1 ? 12 : reportMonth - 1;
    var rewardYear = reportMonth === 1 ? reportYear - 1 : reportYear;

    // ===== 1. Thưởng sản lượng tháng =====
    // Lấy tiers thưởng từ settings
    var settings = db.prepare("SELECT reward_tiers FROM promotion_settings WHERE id = 1").get();
    var tiers = [];
    try {
      tiers = JSON.parse(settings && settings.reward_tiers ? settings.reward_tiers : '[]');
      tiers.sort(function(a, b) { return a.threshold - b.threshold; });
    } catch(e) {
      tiers = [{ threshold: 300, reward: 10 }, { threshold: 500, reward: 20 }];
    }

    // Cần trả = tổng thưởng của tất cả khách đạt tier trong tháng thưởng
    // Dựa trên purchased_liters trong customer_monthly_stats
    var stats = db.prepare(`
      SELECT SUM(purchased_liters) as total_liters,
             COUNT(CASE WHEN purchased_liters >= ? THEN 1 END) as count_300plus,
             COUNT(CASE WHEN purchased_liters >= ? THEN 1 END) as count_500plus
      FROM customer_monthly_stats
      WHERE year = ? AND month = ?
    `).get(300, 500, rewardYear, rewardMonth);
    var totalLiters = stats ? stats.total_liters : 0;

    // Tính tổng thưởng cần trả (dựa trên tiers)
    var needToPay = 0;
    var customers = db.prepare(`
      SELECT purchased_liters FROM customer_monthly_stats WHERE year = ? AND month = ?
    `).all(rewardYear, rewardMonth);

    customers.forEach(function(c) {
      var liters = c.purchased_liters || 0;
      // Tìm tier cao nhất đạt được
      for (var i = tiers.length - 1; i >= 0; i--) {
        if (liters >= tiers[i].threshold) {
          needToPay += tiers[i].reward;
          break;
        }
      }
    });

    // Đã trả = tổng reward_liters_used của các đơn MONTHLY_BONUS của kỳ thưởng đó
    // Note format: "tháng X/Y" hoặc "tháng X.0/Y.0" (float) - cần match X%/%Y
    var paidReward = db.prepare(`
      SELECT COALESCE(SUM(reward_liters_used), 0) as total
      FROM sales
      WHERE archived = 0 AND promo_type = 'MONTHLY_BONUS' AND reward_liters_used > 0
        AND (note LIKE '%tháng ' || ? || '%/%' || ? || '%')
    `).get(rewardMonth, rewardYear);
    var alreadyPaid = paidReward ? paidReward.total : 0;

    // Còn phải trả
    var remaining = Math.max(0, needToPay - alreadyPaid);

    // ===== 2. Khuyến mãi 10 tặng 1 =====
    var promoMonth = String(reportMonth).padStart(2, '0');
    var freePromoLiters = db.prepare(`
      SELECT COALESCE(SUM(promo_free_liters), 0) as total
      FROM sales
      WHERE archived = 0 AND promo_type != 'MONTHLY_BONUS' AND promo_free_liters > 0
        AND strftime('%Y-%m', date) = ? || '-' || ?
    `).get(String(reportYear), promoMonth);
    var buy10Given = freePromoLiters ? freePromoLiters.total : 0;

    res.json({
      reportMonth, reportYear,
      rewardMonth, rewardYear,
      needToPay: Math.round(needToPay),
      alreadyPaid: Math.round(alreadyPaid),
      remaining: Math.round(remaining),
      buy10Given: Math.round(buy10Given)
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
