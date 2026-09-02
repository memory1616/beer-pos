/**
 * RewardService — SINGLE SOURCE OF TRUTH cho logic tra thuong san luong.
 *
 * Mot so thuat ngu:
 *   - orderedQty: so lit khach dat (truoc khi tru thuong)
 *   - paidQty:    so lit khach phai tra tien
 *   - rewardQty:  so lit duoc tra thuong (khong tinh tien)
 *   - deliveredQty: so lit thuc te giao = orderedQty (khong cong them)
 *   - lineTotal: doanh thu cua dong = paidQty * price
 *
 * QUY TAC (theo yeu cau):
 *   1. Giao hang = orderedQty (KHONG cong them reward)
 *   2. Tinh tien  = paidQty * price (CHI phan khach tra tien)
 *   3. Reward    = rewardQty * price = 0 dong
 *   4. COGS      = deliveredQty * cost_price (TINH DAY DU - ca phan thuong)
 *   5. Profit    = Revenue - COGS (khong bi sai khi co thuong)
 *   6. pending_rewards.remaining = total - consumed
 *   7. Neu reward > ordered: chi dung phan ordered, phan du con lai pending
 *
 * Module nay duoc goi tu:
 *   - routes/api/sales.js (POST /)
 *   - src/services/saleDelete.js (reverse khi xoa don)
 *   - tests/services/RewardService.test.js
 *
 * KHONG phu thuoc truc tiep vao DB (pure functions), chi goi DB khi can thiet.
 */

const db = require('../../database');
const logger = require('../utils/logger');
const promotionCalc = require('./promotionCalc');

// ────────────────────────────────────────────────────────────────────────────────
// CLASSIFICATION
// ────────────────────────────────────────────────────────────────────────────────

const BLACK_KEYWORDS = ['guinness', 'kilkenny', 'murphy', 'black', 'đen', 'smithwick'];

function classifyBeer(productName) {
  if (!productName) return 'gold';
  const name = productName.toLowerCase();
  return BLACK_KEYWORDS.some(k => name.includes(k)) ? 'black' : 'gold';
}

// ────────────────────────────────────────────────────────────────────────────────
// REWARD SERVICE
// ────────────────────────────────────────────────────────────────────────────────

class RewardService {

  // ════════════════════════════════════════════════════════════════════════════
  // STEP 1: Lay thong tin reward dang co (pending)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Lay reward hien tai cua khach (uu tien tu pending_rewards, khong tinh lai).
   *
   * @param {number} customerId
   * @param {string|null} orderDate - YYYY-MM-DD de xac dinh thang tra thuong
   * @returns {{ available: boolean, pendingId: number|null, total: number, remaining: number,
   *             yellowTotal: number, yellowRemaining: number,
   *             blackTotal: number, blackRemaining: number,
   *             mode: string|null, rewardMonth: number|null, rewardYear: number|null,
   *             status: string }}
   */
  getAvailableReward(customerId, orderDate) {
    const now = orderDate ? new Date(orderDate) : new Date();
    const rewardMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const rewardMonthNum = rewardMonth.getMonth() + 1;
    const rewardYear = rewardMonth.getFullYear();

    // Uu tien 1: doc tu pending_rewards
    const pending = db.prepare(`
      SELECT * FROM pending_rewards
      WHERE customer_id = ? AND reward_month = ? AND reward_year = ?
    `).get(customerId, rewardMonthNum, rewardYear);

    if (pending) {
      const total = pending.reward_liters || 0;
      const consumed = pending.consumed_liters || 0;
      const yellowTotal = pending.reward_yellow_liters || 0;
      const blackTotal = pending.reward_black_liters || 0;

      // Da co pending: tinh remaining tu consumed_liters
      const remaining = Math.max(0, total - consumed);
      // Tinh remaining theo tung loai (don gian: ty le)
      const yellowRemaining = total > 0 ? Math.max(0, Math.round(yellowTotal * remaining / total)) : 0;
      const blackRemaining = total > 0 ? Math.max(0, Math.round(blackTotal * remaining / total)) : 0;

    // Kiem tra da nhan thuong thang nay chua (qua reward_history)
    // NOTE: reward_history KHONG co cot reward_month / reward_year (chi co tren sale_items
    // va pending_rewards). De check da claim thang nay hay chua, dung note LIKE voi pattern
    // "tháng X/YYYY" hoặc "thang X/YYYY" (data cu co the khong dau) giong nhu
    // reverseRewardFromOrder.
    const claimed = db.prepare(`
      SELECT COUNT(*) as cnt FROM reward_history
      WHERE customer_id = ? AND (note LIKE ? OR note LIKE ?)
    `).get(customerId, `%tháng ${rewardMonthNum}/${rewardYear}%`, `%thang ${rewardMonthNum}/${rewardYear}%`);

      if (claimed && claimed.cnt > 0) {
        return {
          available: false,
          reason: 'already_claimed',
          pendingId: null,
          total: 0, remaining: 0,
          yellowTotal: 0, yellowRemaining: 0,
          blackTotal: 0, blackRemaining: 0,
          mode: null,
          rewardMonth: rewardMonthNum,
          rewardYear: rewardYear,
          status: 'paid'
        };
      }

      return {
        available: remaining > 0,
        pendingId: pending.id,
        total,
        remaining,
        yellowTotal,
        yellowRemaining,
        blackTotal,
        blackRemaining,
        mode: pending.mode || 'MIXED',
        rewardMonth: rewardMonthNum,
        rewardYear: rewardYear,
        status: pending.status || 'pending'
      };
    }

    // Uu tien 2: da co reward_history cho thang nay (da nhan roi)
    // NOTE: reward_history KHONG co cot reward_month / reward_year (chi co tren sale_items
    // va pending_rewards). De check da claim thang nay hay chua, dung note LIKE voi pattern
    // "tháng X/YYYY" hoặc "thang X/YYYY" (data cu co the khong dau).
    const claimed = db.prepare(`
      SELECT COUNT(*) as cnt FROM reward_history
      WHERE customer_id = ? AND (note LIKE ? OR note LIKE ?)
    `).get(customerId, `%tháng ${rewardMonthNum}/${rewardYear}%`, `%thang ${rewardMonthNum}/${rewardYear}%`);

    if (claimed && claimed.cnt > 0) {
      return {
        available: false,
        reason: 'already_claimed',
        pendingId: null,
        total: 0, remaining: 0,
        yellowTotal: 0, yellowRemaining: 0,
        blackTotal: 0, blackRemaining: 0,
        mode: null,
        rewardMonth: rewardMonthNum,
        rewardYear: rewardYear,
        status: 'paid'
      };
    }

    // Uu tien 3 (FALLBACK): pending_rewards khong co → tinh real-time tu liters thang truoc
    // Dam bao don dau tien cua thang moi van duoc ap thuong neu auto-generate chua chay.
    // Cung luu vao pending_rewards de lan sau kiem tra nhanh.
    return this._calculateRewardFromPrevMonth(customerId, rewardMonthNum, rewardYear, orderDate);
  }

  /**
   * Fallback: tinh reward tu liters thang truoc (khi pending_rewards chua co row).
   * Chi ap dung neu:
   *   - Khach co purchased_liters (yellow/black) trong customer_monthly_stats
   *   - Hoac co the tinh real-time tu sale_items (fallback cuoi cung)
   * Luu ket qua vao pending_rewards de lan sau doc nhanh.
   * @returns RewardAvailability (cung shape voi cac branch khac)
   */
  _calculateRewardFromPrevMonth(customerId, rewardMonthNum, rewardYear, orderDate) {
    let yellowTotal = 0, blackTotal = 0;

    // Thu 1: doc tu customer_monthly_stats (snapshot da tinh san)
    try {
      const stats = db.prepare(`
        SELECT purchased_yellow_liters, purchased_black_liters
        FROM customer_monthly_stats
        WHERE customer_id = ? AND year = ? AND month = ?
      `).get(customerId, rewardYear, rewardMonthNum);
      if (stats) {
        yellowTotal = Number(stats.purchased_yellow_liters) || 0;
        blackTotal = Number(stats.purchased_black_liters) || 0;
      }
    } catch (_) { /* bang co the chua co cot */ }

    // Thu 2: neu stats rong → tinh real-time tu sale_items (de phong stats chua rebuild)
    if (yellowTotal === 0 && blackTotal === 0) {
      try {
        const rewardMonthStr = String(rewardMonthNum).padStart(2, '0');
        const items = db.prepare(`
          SELECT p.name AS product_name, si.quantity
          FROM sales s
          JOIN sale_items si ON si.sale_id = s.id
          JOIN products p ON p.id = si.product_id
          WHERE s.customer_id = ?
            AND s.type = 'sale'
            AND s.archived = 0
            AND si.price > 0
            AND p.type = 'keg'
            AND strftime('%Y', s.date) = ?
            AND strftime('%m', s.date) = ?
        `).all(customerId, String(rewardYear), rewardMonthStr);
        for (const it of items) {
          const q = Number(it.quantity) || 0;
          if (classifyBeer(it.product_name) === 'black') blackTotal += q;
          else yellowTotal += q;
        }
      } catch (_) { /* skip */ }
    }

    if (yellowTotal <= 0 && blackTotal <= 0) {
      return {
        available: false,
        reason: 'no_pending_reward',
        pendingId: null,
        total: 0, remaining: 0,
        yellowTotal: 0, yellowRemaining: 0,
        blackTotal: 0, blackRemaining: 0,
        mode: null,
        rewardMonth: rewardMonthNum,
        rewardYear: rewardYear,
        status: 'none'
      };
    }

    // Tinh reward theo promotionCalc
    const calc = promotionCalc.calculatePromotion(yellowTotal, blackTotal);
    if (!calc || calc.totalReward <= 0) {
      return {
        available: false,
        reason: 'no_pending_reward',
        pendingId: null,
        total: 0, remaining: 0,
        yellowTotal: 0, yellowRemaining: 0,
        blackTotal: 0, blackRemaining: 0,
        mode: null,
        rewardMonth: rewardMonthNum,
        rewardYear: rewardYear,
        status: 'none'
      };
    }

    // Luu vao pending_rewards de lan sau doc nhanh (idempotent).
    // BO QUA khach co don MONTHLY_BONUS trong thang hien tai (thang order) → da nhan roi.
    let savedPendingId = null;
    try {
      const now = orderDate ? new Date(orderDate) : new Date();
      const orderMonthNum = now.getMonth() + 1;
      const orderYear = now.getFullYear();
      const orderMonthStr = String(orderMonthNum).padStart(2, '0');
      const alreadyClaimed = db.prepare(`
        SELECT COUNT(*) as cnt FROM sales
        WHERE customer_id = ? AND archived = 0 AND promo_type = 'MONTHLY_BONUS'
          AND strftime('%Y', date) = ? AND strftime('%m', date) = ?
      `).get(customerId, String(orderYear), orderMonthStr);
      if (!alreadyClaimed || alreadyClaimed.cnt === 0) {
        const result = db.prepare(`
          INSERT OR IGNORE INTO pending_rewards
            (customer_id, reward_month, reward_year, reward_liters, reward_yellow_liters, reward_black_liters, mode, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
        `).run(customerId, rewardMonthNum, rewardYear, calc.totalReward, calc.yellowReward, calc.blackReward, calc.mode);
        // Lay id cua row vua insert (neu moi) hoac row da ton tai
        const existing = db.prepare(`
          SELECT id FROM pending_rewards WHERE customer_id = ? AND reward_month = ? AND reward_year = ?
        `).get(customerId, rewardMonthNum, rewardYear);
        savedPendingId = existing ? existing.id : (result.lastInsertRowid || null);
      }
    } catch (_) { /* ignore - pending_rewards insert khong quan trong */ }

    return {
      available: true,
      reason: 'calculated_fallback',
      pendingId: savedPendingId,
      total: calc.totalReward,
      remaining: calc.totalReward,
      yellowTotal: calc.yellowReward,
      yellowRemaining: calc.yellowReward,
      blackTotal: calc.blackReward,
      blackRemaining: calc.blackReward,
      mode: calc.mode,
      rewardMonth: rewardMonthNum,
      rewardYear: rewardYear,
      status: 'pending'
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STEP 2: Tinh reward application (PURE FUNCTION - khong can DB)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Tinh reward application cho tung dong san pham.
   * Day la PURE FUNCTION - chi su ly data, khong truy van DB.
   *
   * @param {Array} orderedItems - [{productId, productSlug, productName, quantity, price, costPrice, type}]
   * @param {{ available: boolean, yellowRemaining: number, blackRemaining: number,
   *           total: number, remaining: number, mode: string }} availableReward
   * @returns {{
   *   applied: boolean,
   *   items: Array<{
   *     productId, productSlug, productName, quantity, price, costPrice, type,
   *     paidQty, rewardQty, lineTotal, lineCOGS, appliedReward: {yellow: number, black: number},
   *     rewardSource: string, rewardMonth: number|null, rewardYear: number|null
   *   }>,
   *   totalRewardApplied: number, totalPaidQty: number, totalLineTotal: number,
   *   yellowApplied: number, blackApplied: number,
   *   rewardMonth: number|null, rewardYear: number|null,
   *   remainingAfter: { yellow: number, black: number, total: number }
   * }}
   */
  calculateRewardApplication(orderedItems, availableReward) {
    if (!availableReward.available || !orderedItems || orderedItems.length === 0) {
      return {
        applied: false,
        items: orderedItems ? orderedItems.map(item => ({
          ...item,
          paidQty: item.quantity,
          rewardQty: 0,
          lineTotal: (item.quantity || 0) * (item.price || 0),
          lineCOGS: (item.quantity || 0) * (item.costPrice || 0),
          appliedReward: { yellow: 0, black: 0 }
        })) : [],
        totalRewardApplied: 0,
        totalPaidQty: 0,
        totalLineTotal: 0,
        yellowApplied: 0,
        blackApplied: 0,
        rewardMonth: null,
        rewardYear: null,
        remainingAfter: { yellow: availableReward.yellowRemaining || 0, black: availableReward.blackRemaining || 0, total: availableReward.remaining || 0 }
      };
    }

    const {
      yellowRemaining, blackRemaining, total: totalReward,
      mode, rewardMonth, rewardYear
    } = availableReward;

    let yLeft = yellowRemaining;
    let bLeft = blackRemaining;
    const results = [];

    for (const item of orderedItems) {
      const qty = item.quantity || 0;
      const beerType = item.type === 'keg' ? classifyBeer(item.productName || item.productSlug || '') : 'other';
      let rewardApplied = 0;

      if (beerType === 'gold' && yLeft > 0) {
        // Bia vang
        rewardApplied = Math.min(qty, yLeft);
        yLeft -= rewardApplied;
      } else if (beerType === 'black' && bLeft > 0) {
        // Bia den
        rewardApplied = Math.min(qty, bLeft);
        bLeft -= rewardApplied;
      }

      const paidQty = qty - rewardApplied;
      const price = item.price || 0;
      const costPrice = item.costPrice || 0;
      const lineTotal = paidQty * price;
      // COGS = delivered (qty) * cost, BAO GOM ca phan thuong (yeu cau 10)
      const lineCOGS = qty * costPrice;
      // Profit = Revenue - COGS (khong phai (paidQty * price) - (paidQty * cost))
      // vi COGS tinh tren toan bo deliveredQty
      const lineProfit = lineTotal - lineCOGS;

      results.push({
        ...item,
        paidQty,
        rewardQty: rewardApplied,
        lineTotal,
        lineCOGS,
        lineProfit,
        appliedReward: {
          yellow: beerType === 'gold' ? rewardApplied : 0,
          black: beerType === 'black' ? rewardApplied : 0
        },
        rewardSource: rewardApplied > 0 ? 'pending' : null,
        rewardMonth: rewardMonth || null,
        rewardYear: rewardYear || null
      });
    }

    const yellowApplied = yellowRemaining - yLeft;
    const blackApplied = blackRemaining - bLeft;
    const totalRewardApplied = yellowApplied + blackApplied;
    const totalPaidQty = results.reduce((sum, r) => sum + r.paidQty, 0);
    const totalLineTotal = results.reduce((sum, r) => sum + r.lineTotal, 0);
    const totalLineCOGS = results.reduce((sum, r) => sum + r.lineCOGS, 0);

    return {
      applied: totalRewardApplied > 0,
      items: results,
      totalRewardApplied,
      totalPaidQty,
      totalLineTotal,
      totalLineCOGS,
      yellowApplied,
      blackApplied,
      rewardMonth,
      rewardYear,
      remainingAfter: {
        yellow: yLeft,
        black: bLeft,
        total: (availableReward.remaining || 0) - totalRewardApplied
      }
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STEP 3: Apply reward vao don hang (trong transaction)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Gan reward vao don hang trong cung transaction voi tao don.
   *
   * Flow:
   *   1. UPDATE sale_items: set paid_quantity, reward_quantity, reward_source, reward_month, reward_year
   *   2. UPDATE sales: total, profit (tinh lai dung)
   *   3. UPDATE pending_rewards: consumed_liters += rewardQty, status = 'paid'|'partial'
   *   4. INSERT reward_history: ghi nhan da nhan thuong
   *
   * YEU CAU: Ham nay phai duoc goi TRONG transaction da mo san cua routes/api/sales.js
   *
   * @param {number} saleId
   * @param {number} customerId
   * @param {{ applied: boolean, items: Array, totalRewardApplied: number,
   *           yellowApplied: number, blackApplied: number,
   *           rewardMonth: number|null, rewardYear: number|null,
   *           remainingAfter: { yellow, black, total },
   *           totalLineTotal: number, totalLineCOGS: number }} application
   * @param {number} pendingId - pending_rewards.id
   * @param {number} rewardMonth - thang tra thuong
   * @param {number} rewardYear - nam tra thuong
   * @returns {{ success: boolean, rewardLiters: number, paidQty: number, remaining: number }}
   */
  applyRewardToOrder(saleId, customerId, application, pendingId, rewardMonth, rewardYear) {
    if (!application.applied || application.totalRewardApplied <= 0) {
      return { success: true, rewardLiters: 0, paidQty: 0, remaining: application.remainingAfter?.total || 0 };
    }

    const { items, totalRewardApplied, yellowApplied, blackApplied,
            remainingAfter, totalLineTotal, totalLineCOGS,
            rewardMonth: rMonth, rewardYear: rYear } = application;

    try {
      // 1. UPDATE sale_items: set paid_quantity, reward_quantity cho cac dong co reward
      for (const item of items) {
        if (item.rewardQty > 0) {
          db.prepare(`
            UPDATE sale_items SET
              paid_quantity = ?,
              reward_quantity = ?,
              reward_source = ?,
              reward_month = ?,
              reward_year = ?,
              profit = ? -- tinh lai profit = lineTotal - lineCOGS
            WHERE id = ?
          `).run(
            item.paidQty,
            item.rewardQty,
            item.rewardSource || 'pending',
            item.rewardMonth || rMonth,
            item.rewardYear || rYear,
            item.lineProfit || 0,
            item.saleItemId || null
          );
        }
      }

      // Neu khong co saleItemId tren item (vi du khi goi tu transaction chinh),
      // can update theo product_id cua sale. Tim dong item cua san pham nay.
      for (const item of items) {
        if (item.rewardQty > 0 && !item.saleItemId) {
          // Tim dong sale_items cua san pham nay trong don hien tai
          // BUGFIX: column reward_quantity co default=0 (khong phai NULL),
          // nen can OR (reward_quantity IS NULL OR reward_quantity = 0)
          // de tranh update sai khi co reward line price=0 cu
          const si = db.prepare(`
            SELECT id FROM sale_items
            WHERE sale_id = ? AND product_id = ?
              AND (reward_quantity IS NULL OR reward_quantity = 0)
              AND price > 0
            ORDER BY id ASC LIMIT 1
          `).get(saleId, item.productId);
          if (si) {
            db.prepare(`
              UPDATE sale_items SET
                paid_quantity = ?,
                reward_quantity = ?,
                reward_source = ?,
                reward_month = ?,
                reward_year = ?,
                profit = ?
              WHERE id = ?
            `).run(
              item.paidQty,
              item.rewardQty,
              item.rewardSource || 'pending',
              item.rewardMonth || rMonth,
              item.rewardYear || rYear,
              item.lineProfit || 0,
              si.id
            );
            // QUAN TRONG: cap nhat lai saleItemId de loop INSERT reward_history ben duoi co the dung
            item.saleItemId = si.id;
          }
        }
      }

      // 2. UPDATE sales: total = doanh thu (chi tinh paid), profit = Revenue - COGS
      // COGS = SUM(sale_items.quantity * cost_price) = totalLineCOGS
      const profit = totalLineTotal - totalLineCOGS;
      db.prepare(`
        UPDATE sales SET
          total = ?,
          profit = ?,
          promo_type = 'MONTHLY_BONUS',
          reward_liters_used = COALESCE(reward_liters_used, 0) + ?,
          promo_free_liters = COALESCE(promo_free_liters, 0) + ?,
          note = COALESCE(note, '') || ' | Trả thưởng sản lượng tháng ' || CAST(? AS TEXT) || '/' || CAST(? AS TEXT)
        WHERE id = ?
      `).run(
        totalLineTotal,  // doanh thu = paidQty * price
        profit,           // loi nhuan = Revenue - COGS
        totalRewardApplied,
        totalRewardApplied,
        rMonth || rewardMonth,
        rYear || rewardYear,
        saleId
      );

      // 3. UPDATE pending_rewards: consumed_liters += rewardApplied, cap nhat status
      if (pendingId) {
        const pending = db.prepare('SELECT * FROM pending_rewards WHERE id = ?').get(pendingId);
        if (pending) {
          const newConsumed = (pending.consumed_liters || 0) + totalRewardApplied;
          const totalReward = pending.reward_liters || 0;
          let newStatus = 'partial';
          if (newConsumed >= totalReward) {
            newStatus = 'paid';
          } else if (newConsumed <= 0) {
            newStatus = 'pending';
          }

          db.prepare(`
            UPDATE pending_rewards SET
              consumed_liters = ?,
              status = ?
            WHERE id = ?
          `).run(newConsumed, newStatus, pendingId);
        }
      }

      // 4. INSERT reward_history: ghi nhan da nhan thuong
      // NOTE 1: bang reward_history KHONG co cot reward_month/reward_year (chi co tren
      //         sale_items va pending_rewards). Thong tin thang/nam da duoc luu trong note
      //         (pattern "tháng X/YYYY") nen khong can cot rieng.
      // NOTE 2: Insert 1 row PER sale_item co reward (set sale_item_id) de reverse co the
      //         biet chinh xac reward_yellow_liters/reward_black_liters cua tung item.
      //         Truoc day chi insert 1 row aggregate (khong co sale_item_id) nen khi reverse
      //         khong lay duoc yellow/black breakdown → yellowReversed/blackReversed luon = 0.
      const tier = `BONUS_${totalRewardApplied}L`;
      const noteSuffix = yellowApplied > 0 && blackApplied > 0
        ? `${totalRewardApplied}L (${yellowApplied}L vang + ${blackApplied}L den)`
        : `${totalRewardApplied}L`;
      const baseNote = `Trả thưởng sản lượng tháng ${rMonth || rewardMonth}/${rYear || rewardYear} - ${noteSuffix}`;

      const insertHistory = db.prepare(`
        INSERT INTO reward_history
          (customer_id, sale_item_id, reward_tier, reward_liters, reward_yellow_liters, reward_black_liters, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      let insertedHistory = 0;
      for (const item of items) {
        if (item.rewardQty > 0 && item.saleItemId) {
          // Ty le yellow/black cho item nay = rewardQty (vi moi item chi co 1 loai bia)
          const itemYellow = item.appliedReward?.yellow || 0;
          const itemBlack = item.appliedReward?.black || 0;
          insertHistory.run(
            customerId,
            item.saleItemId,
            tier,
            item.rewardQty,
            itemYellow,
            itemBlack,
            baseNote
          );
          insertedHistory++;
        }
      }

      // Fallback: neu khong co saleItemId (khong nen xay ra) thi van insert 1 row aggregate
      if (insertedHistory === 0) {
        insertHistory.run(
          customerId,
          null,
          tier,
          totalRewardApplied,
          yellowApplied,
          blackApplied,
          baseNote
        );
      }

      logger.info(`[RewardService] Applied: sale=${saleId}, customer=${customerId}, ` +
        `reward=${totalRewardApplied}L (y=${yellowApplied}, b=${blackApplied}), ` +
        `month=${rMonth || rewardMonth}/${rYear || rewardYear}, remaining=${remainingAfter.total}L`);

      return {
        success: true,
        rewardLiters: totalRewardApplied,
        paidQty: application.totalPaidQty || 0,
        remaining: remainingAfter.total,
        yellowRemaining: remainingAfter.yellow,
        blackRemaining: remainingAfter.black
      };
    } catch (e) {
      logger.error('[RewardService] applyRewardToOrder error:', e);
      throw e; // Re-throw de transaction rollback
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STEP 4: Reverse reward khi xoa don (trong transaction)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Hoan lai reward khi xoa don hang.
   *
   * Flow:
   *   1. Doc sale_items cua don co reward_quantity > 0
   *   2. Xoa reward_history tuong ung
   *   3. Cong lai consumed_liters tren pending_rewards
   *   4. Cap nhat status pending_rewards (partial / pending)
   *
   * YEU CAU: Ham nay phai duoc goi TRONG transaction da mo san cua saleDelete.js
   *
   * @param {number} saleId
   * @returns {{ success: boolean, reversedLiters: number, yellowReversed: number, blackReversed: number }}
   */
  reverseRewardFromOrder(saleId) {
    try {
      // 1. Doc cac dong co reward
      // NOTE: reward_month, reward_year luu tren sale_items (migration 043).
      // reward_yellow_liters, reward_black_liters luu tren reward_history aggregate theo sale_item_id
      // (code applyRewardToOrder hien tai chi chen 1 row per claim, KHONG set sale_id vi bang
      // reward_history KHONG co cot sale_id - chi co sale_item_id).
      // Truoc day code cu JOIN qua customer_id nen sai schema va
      // gay "no such column: rh.reward_month" khi xoa don.
      const rewardItems = db.prepare(`
        SELECT si.*, rh.id as history_id,
               rh.reward_yellow_liters, rh.reward_black_liters
        FROM sale_items si
        LEFT JOIN reward_history rh ON rh.sale_item_id = si.id
        WHERE si.sale_id = ? AND si.reward_quantity > 0
      `).all(saleId);

      if (!rewardItems || rewardItems.length === 0) {
        return { success: true, reversedLiters: 0, yellowReversed: 0, blackReversed: 0 };
      }

      let totalReversed = 0;
      let yellowReversed = 0;
      let blackReversed = 0;
      const processedHistoryIds = new Set();

      for (const item of rewardItems) {
        const rewardQty = item.reward_quantity || 0;
        // Lay yellow/black tu sale_items (migration 043)
        const yellow = item.reward_yellow_liters || 0;
        const black = item.reward_black_liters || 0;
        // Lay month/year tu sale_items (migration 043)
        const rMonth = item.reward_month;
        const rYear = item.reward_year;

        // Lay ty le de tach phan reverse
        const totalItemReward = item.reward_quantity || 1;
        const yellowItem = Math.round(rewardQty * yellow / totalItemReward);
        const blackItem = Math.round(rewardQty * black / totalItemReward);

        totalReversed += rewardQty;
        yellowReversed += yellowItem;
        blackReversed += blackItem;

        // Xoa reward_history neu chua xoa (JOIN qua sale_item_id de chinh xac)
        if (item.history_id && !processedHistoryIds.has(item.history_id)) {
          db.prepare('DELETE FROM reward_history WHERE id = ?').run(item.history_id);
          processedHistoryIds.add(item.history_id);
        }

        // Cong lai consumed_liters tren pending_rewards chi khi biet month/year
        if (rMonth != null && rYear != null) {
          const pending = db.prepare(`
            SELECT * FROM pending_rewards
            WHERE customer_id = (SELECT customer_id FROM sales WHERE id = ?)
              AND reward_month = ? AND reward_year = ?
          `).get(saleId, rMonth, rYear);

          if (pending) {
            const newConsumed = Math.max(0, (pending.consumed_liters || 0) - rewardQty);
            let newStatus = 'pending';
            const totalReward = pending.reward_liters || 0;
            if (newConsumed > 0 && newConsumed < totalReward) {
              newStatus = 'partial';
            } else if (newConsumed >= totalReward) {
              newStatus = 'paid';
            }

            db.prepare(`
              UPDATE pending_rewards SET
                consumed_liters = ?,
                status = ?
              WHERE id = ?
            `).run(newConsumed, newStatus, pending.id);
          }
        }

        // Reset sale_items.reward_quantity + paid_quantity ve ban dau (khi archive don)
        // paid_quantity se tinh lai o saleDelete.js neu can
        db.prepare(`
          UPDATE sale_items SET
            reward_quantity = 0,
            reward_source = NULL,
            paid_quantity = quantity
          WHERE id = ?
        `).run(item.id);

        // Xoa reward_history theo pattern cu (neu van con) — phong TH reward_history cu chua
        // sale_item_id va note co chua "tháng X/YYYY" hoặc "thang X/YYYY" (data cu khong dau).
        if (rMonth != null && rYear != null) {
          if (processedHistoryIds.size > 0) {
            const placeholders = [...processedHistoryIds].map(() => '?').join(',');
            db.prepare(`
              DELETE FROM reward_history
              WHERE customer_id = (SELECT customer_id FROM sales WHERE id = ?)
                AND (note LIKE ? OR note LIKE ?)
                AND id NOT IN (${placeholders})
            `).run(saleId, `%tháng ${rMonth}/${rYear}%`, `%thang ${rMonth}/${rYear}%`, ...processedHistoryIds);
          } else {
            db.prepare(`
              DELETE FROM reward_history
              WHERE customer_id = (SELECT customer_id FROM sales WHERE id = ?)
                AND (note LIKE ? OR note LIKE ?)
            `).run(saleId, `%tháng ${rMonth}/${rYear}%`, `%thang ${rMonth}/${rYear}%`);
          }
        }
      }

      // ============================================================
      // QUAN TRONG: Reset customer_state (customers + customer_monthly_stats)
      // de khach co the nhan lai thuong neu don bi xoa.
      // ============================================================
      // Logic: lay customer_id tu sale, kiem tra xem thang do con pending (consumed < total)
      // hay da het (consumed >= total). Neu het -> reset reward_claimed=0 de frontend
      // cho phep claim lai (consumed da duoc giam ben tren).
      try {
        const saleCustomerId = db.prepare('SELECT customer_id FROM sales WHERE id = ?').get(saleId)?.customer_id;
        if (saleCustomerId) {
          // Lay thang/nam cua reward (dung processedHistoryIds hoac sale_items)
          // Lay ban ghi pending hien tai (neu co)
          const lastPending = db.prepare(`
            SELECT * FROM pending_rewards
            WHERE customer_id = ?
              AND reward_month IS NOT NULL
              AND reward_year IS NOT NULL
            ORDER BY reward_year DESC, reward_month DESC
            LIMIT 1
          `).get(saleCustomerId);

          if (lastPending) {
            // Neu pending con reward (consumed < total) -> cho khach claim lai
            const newConsumed = lastPending.consumed_liters || 0;
            const totalReward = lastPending.reward_liters || 0;
            if (newConsumed < totalReward) {
              // Reset customer_monthly_stats (neu co)
              db.prepare(`
                UPDATE customer_monthly_stats
                SET reward_claimed = 0,
                    reward_claimed_liters = 0,
                    reward_claimed_at = NULL,
                    reward_claimed_sale_id = NULL
                WHERE customer_id = ?
                  AND year = ?
                  AND month = ?
              `).run(saleCustomerId, lastPending.reward_year, lastPending.reward_month);

              // Reset customers.reward_claimed (cho UI hien thi)
              db.prepare(`
                UPDATE customers
                SET reward_claimed = 0,
                    reward_claimed_at = NULL
                WHERE id = ?
              `).run(saleCustomerId);

              logger.info(`[RewardService] Reset customer_state for customer=${saleCustomerId} month=${lastPending.reward_month}/${lastPending.reward_year} (consumed=${newConsumed}/${totalReward}, can still claim)`);
            }
          }
        }
      } catch (e) {
        logger.error('[RewardService] Reset customer_state error:', e);
        // Khong throw - transaction chinh da thanh cong, chi warning
      }

      logger.info(`[RewardService] Reversed: sale=${saleId}, liters=${totalReversed} (y=${yellowReversed}, b=${blackReversed})`);

      return {
        success: true,
        reversedLiters: totalReversed,
        yellowReversed,
        blackReversed
      };
    } catch (e) {
      logger.error('[RewardService] reverseRewardFromOrder error:', e);
      throw e;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // UTILITY: Kiem tra da co reward chua (idempotency)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Kiem tra don da co reward chua (de chong double-apply).
   * @param {number} saleId
   * @returns {boolean}
   */
  hasRewardApplied(saleId) {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM sale_items
      WHERE sale_id = ? AND reward_quantity > 0
    `).get(saleId);
    return row && row.cnt > 0;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // UTILITY: Lay pending reward summary cho frontend
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Lay thong tin pending reward cua 1 khach (cho frontend hien thi).
   * @param {number} customerId
   * @returns {{ pending: boolean, total: number, remaining: number,
   *             yellow: number, black: number, status: string,
   *             rewardMonth: number|null, rewardYear: number|null }}
   */
  getPendingRewardSummary(customerId) {
    const available = this.getAvailableReward(customerId, null);
    if (!available.available) {
      return {
        pending: false,
        total: 0, remaining: 0,
        yellow: 0, black: 0,
        status: available.status,
        rewardMonth: available.rewardMonth,
        rewardYear: available.rewardYear
      };
    }
    return {
      pending: true,
      total: available.total,
      remaining: available.remaining,
      yellow: available.yellowTotal,
      black: available.blackTotal,
      yellowRemaining: available.yellowRemaining,
      blackRemaining: available.blackRemaining,
      status: available.status,
      rewardMonth: available.rewardMonth,
      rewardYear: available.rewardYear,
      mode: available.mode
    };
  }
}

module.exports = RewardService;
