/**
 * Report Data API
 * Handles /report/data endpoint - aggregated report data for dashboard and report page.
 * Supports both dashboard format (?mode=quick&period=today|week|month)
 * and report page format (?type=month&month=4&year=2026)
 */

const express = require('express');
const router = express.Router();
const db = require('../database');
const promoCalc = require('../src/services/promotionCalc');

function litersFromProductName(name) {
  if (!name) return 1;
  const m = String(name).match(/(\d+)\s*[Ll]/);
  return m ? parseInt(m[1], 10) : 1;
}

router.get('/data', (req, res) => {
  try {
    const now = new Date();
    const vn = new Date(now.getTime() + 7 * 3600000);
    const year = String(vn.getUTCFullYear());
    const month = String(vn.getUTCMonth() + 1).padStart(2, '0');
    const day = String(vn.getUTCDate()).padStart(2, '0');
    const today = year + '-' + month + '-' + day;
    let startDate, endDate;

    const type = req.query.type;
    if (type) {
      const rYear = parseInt(req.query.year) || vn.getUTCFullYear();
      const rMonth = parseInt(req.query.month);
      if (type === 'month' && rMonth) {
        const lastDay = new Date(rYear, rMonth, 0).getDate();
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
      const mode = req.query.mode || 'quick';
      const period = req.query.period || 'today';
      const fromParam = req.query.from;
      const toParam = req.query.to;

      if (mode === 'custom' && fromParam && toParam) {
        startDate = fromParam;
        endDate = toParam;
      } else if (period === 'today') {
        startDate = today;
        endDate = today;
      } else if (period === 'week') {
        const wa = new Date(vn); wa.setUTCDate(wa.getUTCDate() - 7);
        startDate = wa.getUTCFullYear() + '-' + String(wa.getUTCMonth()+1).padStart(2,'0') + '-' + String(wa.getUTCDate()).padStart(2,'0');
        endDate = today;
      } else {
        startDate = year + '-' + month + '-01';
        endDate = today;
      }
    }

    // Detect which date column exists in sales table for backward compatibility
    let dateCol = 's.date';
    try {
      const cols = db.prepare("PRAGMA table_info(sales)").all().map(r => r.name);
      if (!cols.includes('date')) {
        if (cols.includes('created_at')) {
          dateCol = 's.created_at';
        }
      }
    } catch(_) {}

    const startDay = startDate.split(' ')[0];
    const endDay = endDate.split(' ')[0];
    const dateCond = 'date(' + dateCol + ') >= date(?) AND date(' + dateCol + ') <= date(?)';
    const dateParams = [startDay, endDay];
    const salesDateBare = dateCol.indexOf('created_at') !== -1 ? 'created_at' : 'date';

    // Main sales query - CHỈ lấy type='sale', KHÔNG lấy replacement/gift (đúng với KPI)
    const sales = db.prepare(
      "SELECT s.id, s.customer_id, s.date, s.total, s.profit, s.type, s.deliver_kegs, s.return_kegs, COALESCE(c.name, 'Khách lẻ') as customer_name, (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id) as quantity FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.archived = 0 AND s.type = 'sale' AND (s.status IS NULL OR s.status != 'returned') AND " + dateCond +
      " ORDER BY datetime(" + dateCol + ") DESC LIMIT 200"
    ).all(...dateParams);

    // Aggregated KPIs - loại trừ returned (bao gồm MONTHLY_BONUS vì có doanh thu thực)
    const revR = db.prepare('SELECT COALESCE(SUM(total), 0) as t FROM sales WHERE archived = 0 AND (status IS NULL OR status != \'returned\') AND type = \'sale\' AND date(' + salesDateBare + ') >= date(?) AND date(' + salesDateBare + ') <= date(?)').get(...dateParams);
    const profR = db.prepare('SELECT COALESCE(SUM(profit), 0) as t FROM sales WHERE archived = 0 AND (status IS NULL OR status != \'returned\') AND type = \'sale\' AND date(' + salesDateBare + ') >= date(?) AND date(' + salesDateBare + ') <= date(?)').get(...dateParams);
    const ordR = db.prepare('SELECT COUNT(*) as t FROM sales WHERE archived = 0 AND (status IS NULL OR status != \'returned\') AND type = \'sale\' AND date(' + salesDateBare + ') >= date(?) AND date(' + salesDateBare + ') <= date(?)').get(...dateParams);
    const totalRevenue = revR ? revR.t : 0;
    const totalProfit = profR ? profR.t : 0;
    const totalOrders = ordR ? ordR.t : 0;
    let totalExpense = 0;
    try { const expR = db.prepare('SELECT COALESCE(SUM(amount), 0) as t FROM expenses WHERE archived = 0 AND date >= ? AND date <= ?').get(startDay, endDay); totalExpense = expR ? expR.t : 0; } catch(_){}

    // ===== Hàng cần xuất hôm nay =====
    const todayStr = today; // Dùng cùng format với biến today đã tính ở trên
    const todayDeliver = db.prepare(`
      SELECT COALESCE(SUM(deliver_kegs), 0) as total_deliver, COALESCE(SUM(return_kegs), 0) as total_return,
      COUNT(*) as order_count
      FROM sales WHERE archived = 0 AND type = 'sale' AND (status IS NULL OR status != 'returned')
      AND date(date) = date(?)
    `).get(todayStr);
    const todayKegs = (todayDeliver ? todayDeliver.total_deliver : 0) - (todayDeliver ? todayDeliver.total_return : 0);
    const todayOrderCount = todayDeliver ? todayDeliver.order_count : 0;

    // Chi tiết sản phẩm cần xuất hôm nay (bao gồm cả khuyến mãi, KHÔNG phân biệt giá)
    const todayProducts = db.prepare(`
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
    const daily = db.prepare(
      "SELECT date(" + dateCol + ") as date, COALESCE(SUM(s.total), 0) as revenue, COALESCE(SUM(s.profit), 0) as profit, COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.archived = 0 AND date(e.date) = date(" + dateCol + ")), 0) as expense FROM sales s WHERE s.archived = 0 AND s.type = 'sale' AND (s.status IS NULL OR s.status != 'returned') AND " + dateCond +
      " GROUP BY date(" + dateCol + ") ORDER BY date DESC LIMIT 30"
    ).all(...dateParams);

    // Profit by product (loại trừ items free/price=0)
    const profitByProduct = db.prepare(
      'SELECT p.id, p.name, p.type, SUM(si.quantity) as quantity_sold, COUNT(DISTINCT si.sale_id) as order_count, SUM(si.quantity * si.price) as revenue, SUM(si.quantity * si.cost_price) as cost, SUM(si.profit) as profit FROM sale_items si JOIN products p ON p.id = si.product_id JOIN sales s ON s.id = si.sale_id WHERE s.archived = 0 AND s.type = \'sale\' AND si.price > 0 AND (s.status IS NULL OR s.status != \'returned\') AND ' + dateCond +
      ' GROUP BY p.id ORDER BY SUM(si.profit) DESC LIMIT 20'
    ).all(...dateParams);

    // Profit by customer (loại trừ items free/price=0)
    // Dùng SUM(si.profit) thay vì SUM(s.profit) để tránh duplicate khi JOIN tạo multiple rows
    let profitByCustomer = db.prepare(
      'SELECT c.id, c.name, COUNT(DISTINCT s.id) as order_count, SUM(s.total) as revenue, SUM(si.profit) as profit, SUM(si.quantity) as qty ' +
      'FROM sales s JOIN customers c ON c.id = s.customer_id JOIN sale_items si ON si.sale_id = s.id AND si.price > 0 WHERE s.archived = 0 AND s.type = \'sale\' AND ' + dateCond +
      ' GROUP BY c.id ORDER BY profit DESC'
    ).all(...dateParams);

    const literRows = db.prepare(
      'SELECT s.customer_id, p.name as product_name, si.quantity ' +
      'FROM sale_items si ' +
      'JOIN sales s ON s.id = si.sale_id ' +
      'JOIN products p ON p.id = si.product_id ' +
      "WHERE s.archived = 0 AND s.type = 'sale' AND si.price > 0 AND (s.status IS NULL OR s.status != 'returned') AND " + dateCond
    ).all(...dateParams);
    const literByCustomerId = {};
    for (let lr = 0; lr < literRows.length; lr++) {
      const cid = literRows[lr].customer_id;
      if (cid == null) continue;
      const L = litersFromProductName(literRows[lr].product_name) * (Number(literRows[lr].quantity) || 0);
      literByCustomerId[cid] = (literByCustomerId[cid] || 0) + L;
    }
    profitByCustomer = profitByCustomer.map(function (row) {
      return Object.assign({}, row, { quantity: literByCustomerId[row.id] || 0 });
    });

    // Purchases
    let purchases = [];
    try {
      const purchaseCols = db.prepare("PRAGMA table_info(purchases)").all().map(r => r.name);
      const purchaseDateCol = purchaseCols.includes('date') ? 'date' : (purchaseCols.includes('created_at') ? 'created_at' : 'date');
      const purchaseDateCond = 'date(' + purchaseDateCol + ') >= date(?) AND date(' + purchaseDateCol + ') <= date(?)';
      purchases = db.prepare(
        "SELECT p.id, p.date, p.total_amount as total, COALESCE(p.note, '') as note, " +
        "(SELECT COUNT(*) FROM purchase_items WHERE purchase_id = p.id) as item_count " +
        "FROM purchases p WHERE p.archived = 0 AND " + purchaseDateCond + " ORDER BY datetime(" + purchaseDateCol + ") DESC"
      ).all(...dateParams);
      for (let pi = 0; pi < purchases.length; pi++) {
        purchases[pi].items = db.prepare(
          "SELECT pi.product_id, pr.name as product_name, pi.quantity, pi.unit_price, pi.total_price " +
          "FROM purchase_items pi JOIN products pr ON pr.id = pi.product_id WHERE pi.purchase_id = ?"
        ).all(purchases[pi].id);
      }
    } catch(e) {
      console.error('[REPORT] Purchases query error:', e.message);
    }

    const totalPurchaseAmount = purchases.reduce(function(s, p) { return s + (p.total || 0); }, 0);

    res.json({ 
      sales, totalRevenue, totalProfit, totalOrders, totalExpense, 
      daily, profitByProduct, profitByCustomer, purchases, totalPurchaseAmount,
      todayDeliveries: { totalKegs: todayKegs, orderCount: todayOrderCount, products: todayProducts }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// BONUS DETAIL API - Chi tiết khách nhận thưởng
// ============================================================
router.get('/bonus-detail', (req, res) => {
  try {
    const now = new Date();
    const vn = new Date(now.getTime() + 7 * 3600000);

    const reportMonth = parseInt(req.query.month) || (vn.getUTCMonth() + 1);
    const reportYear = parseInt(req.query.year) || vn.getUTCFullYear();

    // Tháng thưởng = tháng trước
    const rewardMonth = reportMonth === 1 ? 12 : reportMonth - 1;
    const rewardYear = reportMonth === 1 ? reportYear - 1 : reportYear;

    // Lấy tiers
    const settings = db.prepare("SELECT reward_tiers, new_shop_days, start_date FROM promotion_settings WHERE id = 1").get();
    let tiers = [];
    
    try {
      tiers = JSON.parse(settings && settings.reward_tiers ? settings.reward_tiers : '[]');
      tiers.sort(function(a, b) { return a.threshold - b.threshold; });
    } catch(e) {
      tiers = [{ threshold: 300, reward: 20 }, { threshold: 500, reward: 40 }];
    }

    // Lấy tất cả khách có stats trong tháng thưởng
    // CHỈ lấy khách có reward_enabled = 1 (được tham gia thưởng doanh số)
    // Bia Inox V2: lấy cả purchased_yellow_liters + purchased_black_liters
    const allStats = db.prepare(`
      SELECT cms.customer_id, cms.purchased_liters, cms.purchased_yellow_liters, cms.purchased_black_liters,
             c.name as customer_name, c.phone, c.created_at, c.reward_enabled, c.new_shop_enabled, c.promotion_enabled
      FROM customer_monthly_stats cms
      JOIN customers c ON c.id = cms.customer_id
      WHERE cms.year = ? AND cms.month = ?
        AND c.archived = 0
        AND c.reward_enabled = 1
        AND c.promotion_enabled != 0
    `).all(rewardYear, rewardMonth);

    // B18: Trích xuất tháng/năm từ note bằng regex chính xác để tránh false positive
    //     Pattern cũ LIKE '%tháng 1/2026%' có thể match '%tháng 11/2026%' vì wildcard.
    //     Cách mới: lấy tất cả note MONTHLY_BONUS, sau đó filter trong JS bằng regex anchored.
    //     Note thực tế có thể chứa '.0' do SQL concat với REAL (vd "tháng 7.0/2026.0"),
    //     nên regex cần linh hoạt: cho phép `.0` tùy chọn sau số tháng và năm.
    const claimedSales = db.prepare(`
      SELECT customer_id, reward_liters_used, note
      FROM sales
      WHERE archived = 0 AND promo_type = 'MONTHLY_BONUS' AND reward_liters_used > 0
    `).all();

    const rxMonthYear = new RegExp('tháng\\s+(\\d{1,2})(?:\\.0)?/(' + rewardYear + ')(?:\\.0)?(?!\\d)');
    const claimedMap = {};
    claimedSales.forEach(function(s) {
      if (!s.customer_id || !s.note) return;
      const m = s.note.match(rxMonthYear);
      if (m && parseInt(m[1], 10) === rewardMonth) {
        if (!claimedMap[s.customer_id]) claimedMap[s.customer_id] = { liters: 0, sale_id: s.customer_id };
        claimedMap[s.customer_id].liters += s.reward_liters_used || 0;
      }
    });

    // Lấy danh sách khách NEW_SHOP trong tháng để loại trừ
    const newShopCustomers = db.prepare(`
      SELECT DISTINCT customer_id
      FROM sales
      WHERE archived = 0 AND promo_type = 'NEW_SHOP'
        AND strftime('%Y-%m', date) = ? || '-' || ?
    `).all(String(rewardYear), String(rewardMonth).padStart(2, '0'));
    const newShopMap = {};
    newShopCustomers.forEach(function(s) {
      if (s.customer_id) newShopMap[s.customer_id] = true;
    });

    // ============ BIA INOX V2: Lấy yellowVolume + blackVolume riêng ============
    // Group stats theo customer_id: { yellow, black, total }
    const litersByCustomer = {};
    for (const stat of allStats) {
      litersByCustomer[stat.customer_id] = {
        yellow: stat.purchased_yellow_liters || 0,
        black: stat.purchased_black_liters || 0,
        total: stat.purchased_liters || 0
      };
    }

    // Tính tier và phân loại
    const customers_eligible = [];
    const customers_claimed = [];
    const customers_unclaimed = [];

    // Bia Inox V2: dùng promotionCalc
    const promoCalc = require('../src/services/promotionCalc');

    allStats.forEach(function(stat) {
      // Loại trừ khách đang trong giai đoạn NEW_SHOP (tháng đó)
      if (newShopMap[stat.customer_id]) {
        return; // Skip - đang trong new shop
      }

      const litersObj = litersByCustomer[stat.customer_id];
      // Bia Inox V2: dùng calculatePromotion (yellow, black)
      const calc = promoCalc.calculatePromotion(litersObj.yellow, litersObj.black);
      const liters = litersObj.total;
      const tierReward = calc.totalReward;
      const tierName = tierReward > 0 ? `BONUS_${tierReward}L` : null;
      const yellowReward = calc.yellowReward;
      const blackReward = calc.blackReward;
      const mode = calc.mode;

      // Kiểm tra đã nhận thưởng chưa
      const claimedInfo = claimedMap[stat.customer_id] || null;
      const isClaimed = claimedInfo !== null && claimedInfo.liters > 0;
      const claimedLiters = claimedInfo ? claimedInfo.liters : 0;

      const item = {
        customer_id: stat.customer_id,
        customer_name: stat.customer_name,
        phone: stat.phone || '',
        purchased_liters: liters,
        yellow_volume: litersObj.yellow,
        black_volume: litersObj.black,
        tier: tierName,
        reward_liters: tierReward,
        yellow_reward: yellowReward,
        black_reward: blackReward,
        mode: mode,
        claimed: isClaimed,
        claimed_liters: claimedLiters
      };

      // Bia Inox V2: đạt tier khi tổng reward > 0
      if (tierReward > 0) {
        customers_eligible.push(item);
        if (isClaimed) {
          customers_claimed.push(item);
        } else {
          customers_unclaimed.push(item);
        }
      }
    });

    // Tính tổng
    const total_eligible = customers_eligible.length;
    const total_claimed = customers_claimed.length;
    const total_unclaimed = customers_unclaimed.length;
    const total_reward_needed = customers_unclaimed.reduce(function(sum, c) { return sum + c.reward_liters; }, 0);
    const total_reward_paid = customers_claimed.reduce(function(sum, c) { return sum + c.claimed_liters; }, 0);

    res.json({
      reportMonth: reportMonth,
      reportYear: reportYear,
      rewardMonth: rewardMonth,
      rewardYear: rewardYear,
      tiers: tiers,
      summary: {
        total_eligible: total_eligible,
        total_claimed: total_claimed,
        total_unclaimed: total_unclaimed,
        total_reward_needed: total_reward_needed,
        total_reward_paid: total_reward_paid
      },
      customers_eligible: customers_eligible,
      customers_claimed: customers_claimed,
      customers_unclaimed: customers_unclaimed
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
    const now = new Date();
    const vn = new Date(now.getTime() + 7 * 3600000);
    const currentMonth = vn.getUTCMonth() + 1;
    const currentYear = vn.getUTCFullYear();

    // Xác định tháng báo cáo từ query (mặc định = tháng hiện tại)
    const reportMonth = parseInt(req.query.month) || currentMonth;
    const reportYear = parseInt(req.query.year) || currentYear;

    // Tháng trước = tháng của kỳ thưởng
    const rewardMonth = reportMonth === 1 ? 12 : reportMonth - 1;
    const rewardYear = reportMonth === 1 ? reportYear - 1 : reportYear;

    // ===== 1. Thưởng sản lượng tháng =====
    // Lấy tiers thưởng từ settings
    const settings = db.prepare("SELECT reward_tiers FROM promotion_settings WHERE id = 1").get();
    let tiers = [];
    try {
      tiers = JSON.parse(settings && settings.reward_tiers ? settings.reward_tiers : '[]');
      tiers.sort(function(a, b) { return a.threshold - b.threshold; });
    } catch(e) {
      tiers = [{ threshold: 300, reward: 20 }, { threshold: 500, reward: 40 }];
    }

    // Lấy danh sách khách NEW_SHOP trong tháng thưởng để loại trừ
    const newShopCustomers = db.prepare(`
      SELECT DISTINCT customer_id
      FROM sales
      WHERE archived = 0 AND promo_type = 'NEW_SHOP'
        AND strftime('%Y-%m', date) = ? || '-' || ?
    `).all(String(rewardYear), String(rewardMonth).padStart(2, '0'));
    const newShopMap = {};
    newShopCustomers.forEach(function(s) {
      if (s.customer_id) newShopMap[s.customer_id] = true;
    });

    // Bia Inox V2: lấy yellow/black breakdown
    // Lấy danh sách khách có stats trong tháng thưởng (rewardMonth)
    const eligibleCustomers = db.prepare(`
      SELECT cms.customer_id, cms.purchased_liters, cms.purchased_yellow_liters, cms.purchased_black_liters,
             c.name as customer_name, c.phone, c.created_at, c.reward_enabled, c.new_shop_enabled, c.promotion_enabled
      FROM customer_monthly_stats cms
      JOIN customers c ON c.id = cms.customer_id
      WHERE cms.year = ? AND cms.month = ?
        AND c.archived = 0
        AND c.reward_enabled = 1
        AND c.promotion_enabled != 0
    `).all(rewardYear, rewardMonth);

    let yellowNeeded = 0;
    let blackNeeded = 0;
    let needToPay = 0;
    eligibleCustomers.forEach(function(c) {
      // Loại trừ khách NEW_SHOP
      if (newShopMap[c.customer_id]) return;

      // Bia Inox V2: dùng calculatePromotion(yellow, black)
      const yellow = c.purchased_yellow_liters || 0;
      const black = c.purchased_black_liters || 0;
      const calc = promoCalc.calculatePromotion(yellow, black);
      needToPay += calc.totalReward;
      yellowNeeded += calc.yellowReward;
      blackNeeded += calc.blackReward;
    });

    // Đã trả = tổng reward_liters_used của các đơn MONTHLY_BONUS của kỳ thưởng đó
    // B18: Dùng JS regex filter thay vì LIKE với wildcard để tránh false positive.
    //     Hỗ trợ note có '.0' do SQL concat với REAL (backward-compatible).
    const allPaidSales = db.prepare(`
      SELECT reward_liters_used, note
      FROM sales
      WHERE archived = 0 AND promo_type = 'MONTHLY_BONUS' AND reward_liters_used > 0
    `).all();
    const rxPaidYear = new RegExp('tháng\\s+(\\d{1,2})(?:\\.0)?/(' + rewardYear + ')(?:\\.0)?(?!\\d)');
    let alreadyPaid = allPaidSales.reduce(function(sum, s) {
      if (!s.note) return sum;
      const m = s.note.match(rxPaidYear);
      if (m && parseInt(m[1], 10) === rewardMonth) return sum + (s.reward_liters_used || 0);
      return sum;
    }, 0);

    // Bia Inox V2: Đã trả theo từng loại - lấy từ reward_history (lưu chính xác yellow/black)
    // Nhưng bảng reward_history không có cột tháng/năm riêng, dùng note để filter
    const rewardHistory = db.prepare(`
      SELECT reward_liters, reward_yellow_liters, reward_black_liters, note
      FROM reward_history
      WHERE reward_tier NOT LIKE 'NEW_SHOP%'
    `).all();
    const rxHistoryMonth = new RegExp('tháng\\s+(\\d{1,2})(?:\\.0)?/(' + rewardYear + ')(?:\\.0)?');
    let yellowPaid = 0;
    let blackPaid = 0;
    rewardHistory.forEach(function(r) {
      if (!r.note) return;
      const m = r.note.match(rxHistoryMonth);
      if (m && parseInt(m[1], 10) === rewardMonth) {
        yellowPaid += r.reward_yellow_liters || 0;
        blackPaid += r.reward_black_liters || 0;
      }
    });
    // Sync: alreadyPaid = yellowPaid + blackPaid (dùng con số chính xác từ reward_history)
    alreadyPaid = yellowPaid + blackPaid;

    // Còn phải trả
    const remaining = Math.max(0, needToPay - alreadyPaid);
    const yellowRemaining = Math.max(0, yellowNeeded - yellowPaid);
    const blackRemaining = Math.max(0, blackNeeded - blackPaid);

    // ===== 2. Khuyến mãi 10 tặng 1 =====
    const promoMonth = String(reportMonth).padStart(2, '0');
    const freePromoLiters = db.prepare(`
      SELECT COALESCE(SUM(promo_free_liters), 0) as total
      FROM sales
      WHERE archived = 0 AND promo_type != 'MONTHLY_BONUS' AND promo_free_liters > 0
        AND strftime('%Y-%m', date) = ? || '-' || ?
    `).get(String(reportYear), promoMonth);
    const buy10Given = freePromoLiters ? freePromoLiters.total : 0;

    res.json({
      reportMonth, reportYear,
      rewardMonth, rewardYear,
      needToPay: Math.round(needToPay),
      needToPayYellow: Math.round(yellowNeeded),
      needToPayBlack: Math.round(blackNeeded),
      alreadyPaid: Math.round(alreadyPaid),
      alreadyPaidYellow: Math.round(yellowPaid),
      alreadyPaidBlack: Math.round(blackPaid),
      remaining: Math.round(remaining),
      remainingYellow: Math.round(yellowRemaining),
      remainingBlack: Math.round(blackRemaining),
      buy10Given: Math.round(buy10Given)
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
