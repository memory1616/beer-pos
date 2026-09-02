/**
 * BeerPOS Service Layer
 *
 * Service Layer chứa business logic, tách biệt khỏi routes.
 * Các service được thiết kế để:
 * 1. Tái sử dụng logic giữa nhiều routes
 * 2. Dễ test và maintain
 * 3. Cache data ở memory để tránh query DB nhiều lần
 *
 * CÁCH DÙNG:
 * const { SaleService, DebtService, PromotionService, InventoryService, AnalyticsService } = require('./src/services');
 */

const db = require('../../database');
const logger = require('../utils/logger');
const promotionCalc = require('./promotionCalc');

// B6: Lock timezone = Asia/Ho_Chi_Minh cho toàn bộ service.
//     Đảm bảo logic tính tháng/năm nhất quán ngay cả khi file này được
//     require từ script ngoài server.js (backfill, test).
//     Nếu server đã set TZ rồi thì set lại không sao (idempotent).
if (!process.env.TZ) {
  process.env.TZ = 'Asia/Ho_Chi_Minh';
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(amount || 0);
}

// ── Import from modular service files ────────────────────────────────────────
const SaleService = require('./SaleService');
const InventoryService = require('./InventoryService');
const DebtService = require('./DebtService');

// ============================================================
// PROMOTION SERVICE - Business logic cho khuyến mãi
// Bao gồm: khuyến mãi quán mới và thưởng doanh số theo tháng
//
// QUY TẮC:
// - Quán mới: tạo ngày 09+ trong tháng → tháng tạo = NEW_CUSTOMER
// - Từ tháng kế tiếp: tham gia thưởng sản lượng MONTHLY_VOLUME
// - Mỗi khách mỗi tháng chỉ một CTKM, không trùng lặp
// ============================================================
class PromotionService {
  constructor() {
    // Chỉ dùng GOLD/BLACK BUY và FREE cho quán mới (ko dùng 30 ngày)
    this.GOLD_BUY = 10;
    this.GOLD_FREE = 1;
    this.BLACK_BUY = 20;
    this.BLACK_FREE = 1;
    this.TIER_NONE = 'NONE';
    this.TIER_BONUS_10L = 'BONUS_10L';
    this.TIER_BONUS_20L = 'BONUS_20L';
  }

  // ── 0. SYSTEM PROMOTION SETTINGS ─────────────────────────

  /**
   * Lấy toàn bộ cấu hình khuyến mãi hệ thống
   * @returns {Object} promotion settings
   */
  getSystemPromotionSettings() {
    try {
      const settings = db.prepare('SELECT * FROM promotion_settings WHERE id = 1').get();
      if (!settings) {
        return this._getDefaultSettings();
      }
      return {
        newShopEnabled: !!settings.new_shop_enabled,
        // KHONG con newShopDays - chi dung created_day de xac dinh quan moi
        newShopGoldBuy: settings.new_shop_gold_buy || 10,
        newShopGoldFree: settings.new_shop_gold_free || 1,
        newShopBlackBuy: settings.new_shop_black_buy || 20,
        newShopBlackFree: settings.new_shop_black_free || 1,
        rewardEnabled: !!settings.reward_enabled,
        rewardTiers: this._parseRewardTiers(settings.reward_tiers),
        startDate: settings.start_date || null,
        endDate: settings.end_date || null,
        updatedAt: settings.updated_at
      };
    } catch (e) {
      logger.error('getSystemPromotionSettings error:', e);
      return this._getDefaultSettings();
    }
  }

  /**
   * Kiểm tra khuyến mãi có đang trong thời gian áp dụng không
   * @returns {boolean} true nếu đang trong thời gian, false nếu ngoài thời gian
   */
  isWithinPromotionPeriod() {
    const settings = this.getSystemPromotionSettings();
    const now = new Date();

    // Nếu không có start_date và end_date -> luôn áp dụng
    if (!settings.startDate && !settings.endDate) {
      return true;
    }

    // Kiểm tra start_date
    if (settings.startDate) {
      const startDate = new Date(settings.startDate);
      if (now < startDate) {
        return false; // Chưa đến ngày bắt đầu
      }
    }

    // Kiểm tra end_date
    if (settings.endDate) {
      const endDate = new Date(settings.endDate);
      endDate.setHours(23, 59, 59, 999); // Cuối ngày end_date
      if (now > endDate) {
        return false; // Đã hết hạn
      }
    }

    return true;
  }

  /**
   * Kiểm tra một tháng có nằm trong thời gian áp dụng khuyến mãi không
   * @param {Date} monthStart - Ngày đầu tháng
   * @param {Date} monthEnd - Ngày cuối tháng
   * @returns {boolean} true nếu tháng nằm trong thời gian áp dụng
   */
  _isMonthInPromotionPeriod(monthStart, monthEnd) {
    const settings = this.getSystemPromotionSettings();

    // Nếu không có giới hạn thời gian -> luôn áp dụng
    if (!settings.startDate && !settings.endDate) {
      return true;
    }

    const promoStart = settings.startDate ? new Date(settings.startDate) : null;
    const promoEnd = settings.endDate ? new Date(settings.endDate) : null;

    // Kiểm tra tháng bắt đầu SAU ngày kết thúc khuyến mãi -> không áp dụng
    if (promoEnd && monthStart > promoEnd) {
      return false;
    }

    // Kiểm tra tháng kết thúc TRƯỚC ngày bắt đầu khuyến mãi -> không áp dụng
    if (promoStart && monthEnd < promoStart) {
      return false;
    }

    return true;
  }

  _getDefaultSettings() {
    return {
      newShopEnabled: true,
      // KHONG con newShopDays - chi dung created_day de xac dinh quan moi
      newShopGoldBuy: 10,
      newShopGoldFree: 1,
      newShopBlackBuy: 20,
      newShopBlackFree: 1,
      rewardEnabled: true,
      // BIA INOX V2: Tier cố định 300L→20L, 500L→40L (áp dụng cho cả Vàng/Đen theo quy tắc SEPARATE/MIXED).
      // rewardTiers chỉ lưu trữ; logic thực tế dùng `promotionCalc.TIER_REWARDS`.
      rewardTiers: [
        { threshold: 300, reward: 20 },
        { threshold: 500, reward: 40 }
      ],
      updatedAt: null
    };
  }

  _parseRewardTiers(tiersJson) {
    try {
      const tiers = JSON.parse(tiersJson || '[]');
      return tiers.sort((a, b) => a.threshold - b.threshold);
    } catch (e) {
      // BIA INOX V2: fallback đúng theo tier cố định
      return [
        { threshold: 300, reward: 20 },
        { threshold: 500, reward: 40 }
      ];
    }
  }

  /**
   * Lưu cấu hình khuyến mãi hệ thống
   */
  saveSystemPromotionSettings(data) {
    const settings = this.getSystemPromotionSettings();
    const merged = { ...settings, ...data };

    const newShopEnabled = merged.newShopEnabled ? 1 : 0;
    const rewardEnabled = merged.rewardEnabled ? 1 : 0;
    const rewardTiers = JSON.stringify(merged.rewardTiers || []);

    db.prepare(`
      UPDATE promotion_settings SET
        new_shop_enabled = ?,
        new_shop_gold_buy = ?,
        new_shop_gold_free = ?,
        new_shop_black_buy = ?,
        new_shop_black_free = ?,
        reward_enabled = ?,
        reward_tiers = ?,
        start_date = ?,
        end_date = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(
      newShopEnabled,
      merged.newShopGoldBuy || 10,
      merged.newShopGoldFree || 1,
      merged.newShopBlackBuy || 20,
      merged.newShopBlackFree || 1,
      rewardEnabled,
      rewardTiers,
      merged.startDate || null,
      merged.endDate || null
    );

    logger.info('[PromotionService] Saved system promotion settings');
    return this.getSystemPromotionSettings();
  }

  // ── 1. KHUYẾN MÃI QUÁN MỚI ──────────────────────────────

  /**
   * Kiểm tra khách hàng có phải "quán mới"
   * Quán mới = tạo từ ngày 09 trở đi trong tháng hiện tại (không đếm ngày)
   */
  isNewShopEligible(customerId) {
    const settings = this.getSystemPromotionSettings();
    if (!settings.newShopEnabled) {
      return { eligible: false, reason: 'Khuyến mãi quán mới đã bị tắt' };
    }

    if (!this.isWithinPromotionPeriod()) {
      return { eligible: false, reason: 'Khuyến mãi chưa hoặc đã hết thời gian áp dụng' };
    }

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) return { eligible: false, reason: 'Không tìm thấy khách hàng' };

    if (customer.promotion_enabled === 0) {
      return { eligible: false, reason: 'Khách đã tắt tham gia CTKM', promotionEnabled: false };
    }

    if (customer.new_shop_enabled === 0) {
      return { eligible: false, reason: 'Khách đã tắt khuyến mãi quán mới', promotionEnabled: false };
    }

    const created = new Date(customer.created_at);
    const now = new Date();
    const isSameMonth = created.getMonth() === now.getMonth() && created.getFullYear() === now.getFullYear();
    const isDay09Plus = created.getDate() >= 9;

    if (isSameMonth && isDay09Plus) {
      return {
        eligible: true,
        createdDay: created.getDate(),
        firstOrderDate: customer.created_at,
        buyGold: settings.newShopGoldBuy,
        freeGold: settings.newShopGoldFree,
        buyBlack: settings.newShopBlackBuy,
        freeBlack: settings.newShopBlackFree,
        promotionEnabled: true
      };
    }
    return { eligible: false, reason: 'Không thuộc chương trình quán mới', promotionEnabled: true };
  }

  /**
   * Kiểm tra khách có đang trong thời gian quán mới của THÁNG HIỆN TẠI
   * Dựa trên ngày tạo: tạo ngày 09+ → tháng tạo là quán mới
   * @returns {boolean} true nếu khách đang trong thời gian quán mới
   */
  isInNewShopPeriod(customerId) {
    const newShopInfo = this.isNewShopEligible(customerId);
    return newShopInfo.eligible;
  }

  /**
   * Xác định chương trình khuyến mãi cho khách hàng trong một tháng cụ thể
   *
   * Quy tắc:
   * - Nếu tháng đó thuộc giai đoạn Quán mới (tạo ngày 09+) → NEW_CUSTOMER
   * - Nếu tháng đó đã có đơn MONTHLY_BONUS → NEW_CUSTOMER (đã hưởng quán mới)
   * - Nếu không thuộc quán mới và đủ điều kiện thưởng sản lượng → MONTHLY_VOLUME
   * - Ngược lại → NONE
   *
   * @param {number} customerId - ID khách hàng
   * @param {number} year - Năm cần kiểm tra
   * @param {number} month - Tháng cần kiểm tra (1-12)
   * @returns {string} 'NEW_CUSTOMER' | 'MONTHLY_VOLUME' | 'NONE'
   */
  determinePromotionProgram(customerId, year, month) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) return 'NONE';

    const created = new Date(customer.created_at);
    const createdDay = created.getDate();
    const createdMonth = created.getMonth() + 1;
    const createdYear = created.getFullYear();

    // Kiểm tra nếu tháng này là THÁNG TẠO khách hàng
    // QUY TẮC NGHIỆP VỤ (Q1_A):
    //   - Khách tạo ngày 01-08 → VẪN được tham gia thưởng sản lượng ngay tháng tạo
    //   - Khách tạo ngày 09+   → tháng tạo là NEW_CUSTOMER (quán mới)
    const isCreationMonth = (createdYear === year && createdMonth === month);
    if (isCreationMonth && createdDay >= 9) {
      return 'NEW_CUSTOMER';
    }

    // Kiểm tra nếu đã có đơn NEW_SHOP trong tháng này (dấu hiệu quán mới)
    const hasNewShopSale = db.prepare(`
      SELECT COUNT(*) as cnt FROM sales
      WHERE customer_id = ?
        AND promo_type = 'NEW_SHOP'
        AND strftime('%Y', date) = ?
        AND strftime('%m', date) = ?
    `).get(customerId, String(year), String(month).padStart(2, '0'));

    if (hasNewShopSale && hasNewShopSale.cnt > 0) {
      return 'NEW_CUSTOMER';
    }

    // Kiểm tra nếu đủ điều kiện thưởng sản lượng tháng này
    const settings = this.getSystemPromotionSettings();
    if (!settings.rewardEnabled) return 'NONE';

    // QUAN TRỌNG: MONTHLY_BONUS chỉ loại phần si.price=0 (bia free), KHÔNG loại cả đơn.
    const purchasedLiters = db.prepare(`
      SELECT COALESCE(SUM(si.quantity), 0) as total
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
    `).get(customerId, String(year), String(month).padStart(2, '0'));

    const liters = purchasedLiters ? purchasedLiters.total : 0;
    const tiers = settings.rewardTiers || [];
    const eligibleTier = tiers.find(t => liters >= t.threshold);

    return eligibleTier ? 'MONTHLY_VOLUME' : 'NONE';
  }

  /**
   * Kiểm tra xem tháng đã thuộc chương trình nào chưa (để tránh trùng lặp)
   * @param {number} customerId
   * @param {number} year
   * @param {number} month
   * @returns {{ program: string, hasNewShopSale: boolean, hasMonthlyBonusSale: boolean }}
   */
  getMonthPromotionStatus(customerId, year, month) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);

    // Kiểm tra nếu tháng này là THÁNG TẠO
    const created = new Date(customer.created_at);
    const isCreationMonth = (created.getFullYear() === year && (created.getMonth() + 1) === month);

    const newShopSale = db.prepare(`
      SELECT COUNT(*) as cnt FROM sales
      WHERE customer_id = ?
        AND promo_type = 'NEW_SHOP'
        AND strftime('%Y', date) = ?
        AND strftime('%m', date) = ?
    `).get(customerId, String(year), String(month).padStart(2, '0'));

    const monthlyBonusSale = db.prepare(`
      SELECT COUNT(*) as cnt FROM sales
      WHERE customer_id = ?
        AND promo_type = 'MONTHLY_BONUS'
        AND strftime('%Y', date) = ?
        AND strftime('%m', date) = ?
    `).get(customerId, String(year), String(month).padStart(2, '0'));

    const hasNewShopSale = newShopSale && newShopSale.cnt > 0;
    const hasMonthlyBonusSale = monthlyBonusSale && monthlyBonusSale.cnt > 0;

    // Quy tắc: tháng tạo = NEW_CUSTOMER, có đơn NEW_SHOP/MONTHLY_BONUS = NEW_CUSTOMER
    let program = 'NONE';
    if (isCreationMonth || hasNewShopSale || hasMonthlyBonusSale) {
      program = 'NEW_CUSTOMER';
    } else if (customer) {
      const liters = this._getMonthlyLiters(customerId, year, month);
      const settings = this.getSystemPromotionSettings();
      const tiers = settings.rewardTiers || [];
      const eligibleTier = tiers.find(t => liters >= t.threshold);
      if (eligibleTier) program = 'MONTHLY_VOLUME';
    }

    return {
      program,
      isCreationMonth,
      hasNewShopSale,
      hasMonthlyBonusSale,
      eligibleForMonthly: program === 'MONTHLY_VOLUME'
    };
  }

  /**
   * Lấy sản lượng tháng của khách hàng
   * @private
   */
  _getMonthlyLiters(customerId, year, month) {
    // QUAN TRỌNG: MONTHLY_BONUS chỉ loại phần si.price=0 (bia free), KHÔNG loại cả đơn.
    const result = db.prepare(`
      SELECT COALESCE(SUM(si.quantity), 0) as total
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
    `).get(customerId, String(year), String(month).padStart(2, '0'));

    return result ? result.total : 0;
  }

  /**
   * Xác định loại khuyến mãi dựa trên ngày tạo khách hàng và tháng target
   * Quy tắc:
   *   - Ngày 01-08: tham gia thưởng doanh số từ ngày tạo
   *   - Ngày 09+: tháng tạo là quán mới, bắt đầu từ tháng kế tiếp
   * @param {object} customer - customer object có created_at
   * @param {number} targetMonth - tháng cần kiểm tra (1-12)
   * @param {number} targetYear - năm cần kiểm tra
   * @returns {{ rewardEligible: boolean, newShopEligible: boolean, reason: string, promotionStartDate: string }}
   */
  getPromotionEligibility(customer, targetMonth, targetYear) {
    const settings = this.getSystemPromotionSettings();

    // Kiểm tra khuyến mãi hệ thống
    if (!settings.newShopEnabled && !settings.rewardEnabled) {
      return { rewardEligible: false, newShopEligible: false, reason: 'Chương trình đã kết thúc', promotionStartDate: null };
    }
    if (!this.isWithinPromotionPeriod()) {
      return { rewardEligible: false, newShopEligible: false, reason: 'Ngoài thời gian khuyến mãi', promotionStartDate: null };
    }

    // Tính ngày bắt đầu khuyến mãi
    const promotionStartDate = this.getPromotionStartDate(customer);
    const created = new Date(customer.created_at);
    const createdDay = created.getDate();
    const createdMonth = created.getMonth() + 1;
    const createdYear = created.getFullYear();

    const sameMonth = (targetMonth === createdMonth && targetYear === createdYear);

    if (sameMonth) {
      // Trong tháng tạo khách
      if (createdDay <= 8) {
        // Ngày 01-08: tham gia thưởng doanh số
        const canReward = customer.reward_enabled !== 0 && settings.rewardEnabled;
        return {
          rewardEligible: canReward,
          newShopEligible: false,
          promotionStartDate,
          reason: canReward
            ? 'Tham gia thưởng doanh số tháng ' + targetMonth
            : 'Không tham gia thưởng doanh số'
        };
      } else {
        // Ngày 09+: quán mới trong tháng tạo, không thưởng tháng này
        return {
          rewardEligible: false,
          newShopEligible: settings.newShopEnabled && customer.new_shop_enabled !== 0,
          promotionStartDate,
          reason: 'Hưởng KM Quán mới trong tháng ' + targetMonth + '. Từ tháng ' + (targetMonth === 12 ? '1' : targetMonth + 1) + ' tham gia thưởng doanh số.'
        };
      }
    } else {
      // Khác tháng tạo: luôn tham gia thưởng doanh số
      const canReward = customer.reward_enabled !== 0 && settings.rewardEnabled;
      return {
        rewardEligible: canReward,
        newShopEligible: false,
        promotionStartDate,
        reason: canReward
          ? 'Tham gia thưởng doanh số tháng ' + targetMonth
          : 'Không tham gia thưởng doanh số'
      };
    }
  }

  /**
   * Backward-compatible wrapper cho getPromotionEligibility
   * Dùng tháng hiện tại làm target
   * @param {number} customerId
   * @returns {{ isNewShopPromotion: boolean, isRewardEligible: boolean, reason: string }}
   */
  getCustomerPromotionType(customerId) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) {
      return { isNewShopPromotion: false, isRewardEligible: false, reason: 'Không tìm thấy khách hàng' };
    }
    if (customer.promotion_enabled === 0) {
      return { isNewShopPromotion: false, isRewardEligible: false, reason: 'CTKM đang tắt' };
    }

    const now = new Date();
    const result = this.getPromotionEligibility(customer, now.getMonth() + 1, now.getFullYear());
    return {
      isNewShopPromotion: result.newShopEligible,
      isRewardEligible: result.rewardEligible,
      reason: result.reason
    };
  }

  /**
   * Tính lít được tặng cho quán mới theo từng loại bia
   * @param {number} quantityGold - số lít bia vàng mua
   * @param {number} quantityBlack - số lít bia đen mua
   * @returns {{ freeGold, freeBlack, totalFree, promoType }}
   */
  calculateNewShopPromotion(quantityGold = 0, quantityBlack = 0) {
    const settings = this.getSystemPromotionSettings();
    if (!settings.newShopEnabled) {
      return { freeGold: 0, freeBlack: 0, totalFree: 0, promoType: null };
    }

    const freeGold = Math.floor(quantityGold / settings.newShopGoldBuy) * settings.newShopGoldFree;
    const freeBlack = Math.floor(quantityBlack / settings.newShopBlackBuy) * settings.newShopBlackFree;
    return {
      freeGold,
      freeBlack,
      totalFree: freeGold + freeBlack,
      promoType: 'NEW_SHOP'
    };
  }

  // ── 2. THƯỞNG DOANH SỐ THÁNG ────────────────────────────

  /**
   * Lấy ngày bắt đầu tham gia khuyến mãi sản lượng của khách
   * Quy tắc:
   *   - Ngày tạo 01-08: bắt đầu từ ngày tạo
   *   - Ngày tạo 09+: bắt đầu từ ngày 01 của tháng kế tiếp
   * @returns {string} YYYY-MM-DD
   */
  getPromotionStartDate(customer) {
    if (!customer || !customer.created_at) return null;

    const created = new Date(customer.created_at);
    const day = created.getDate();

    if (day <= 8) {
      // Bắt đầu từ ngày tạo - format date thành YYYY-MM-DD
      const y = created.getFullYear();
      const m = String(created.getMonth() + 1).padStart(2, '0');
      const d = String(created.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    } else {
      // Bắt đầu từ ngày 01 của tháng kế tiếp
      // B7: Dùng local date components thay vì toISOString() để tránh lệch ngày
      //     khi server ở TZ khác Asia/Ho_Chi_Minh (boundary ngày 31).
      //     new Date(year, month, 1) tự động cuộn ngày nếu month vượt phạm vi
      //     (ví dụ: month=12 → next year, month=0 → prev year).
      const nextMonth = new Date(created.getFullYear(), created.getMonth() + 1, 1);
      const y = nextMonth.getFullYear();
      const m = String(nextMonth.getMonth() + 1).padStart(2, '0');
      return `${y}-${m}-01`;
    }
  }

  /**
   * Tính sản lượng tháng hiện tại (CHỈ tính lít MUA thực trả, KHÔNG tính lít tặng)
   * Bia tặng khuyến mãi có si.price = 0 nên được lọc ra
   * LUÔN query real-time để đảm bảo đúng sau khi sửa/xóa đơn hàng
   * CHỈ tính keg (bia bình 1L), KHÔNG tính pet (chai nhựa), box, bottle
   *
   * BIA INOX V2: Trả về { total, yellow, black } - phân tách theo loại bia.
   * Phân loại dựa trên PromotionService.classifyBeer(productName) - shared với frontend.
   *
   * @param {number} customerId
   * @param {string} startDate - ngày bắt đầu tính sản lượng (YYYY-MM-DD)
   * @returns {{ total: number, yellow: number, black: number }}
   */
  calculateMonthlyPurchasedLiters(customerId, startDate = null) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const monthStr = String(month).padStart(2, '0');

    // Lấy ngày bắt đầu tính sản lượng
    let effectiveStartDate = startDate;
    if (!effectiveStartDate) {
      const customer = db.prepare('SELECT created_at FROM customers WHERE id = ?').get(customerId);
      if (!customer) return { total: 0, yellow: 0, black: 0 };
      effectiveStartDate = this.getPromotionStartDate(customer);
    }

    // Nếu ngày bắt đầu lớn hơn ngày đầu tháng, chỉ tính từ ngày bắt đầu
    const monthStart = `${year}-${monthStr}-01`;
    const queryStartDate = effectiveStartDate > monthStart ? effectiveStartDate : monthStart;

    // Bia Inox V2: Lấy product_name để classify vàng/đen ngay trong query (case-insensitive).
    // QUAN TRỌNG: chỉ tính item có si.price > 0 (loại bỏ bia tặng), chỉ tính keg.
    const rows = db.prepare(`
      SELECT p.name AS product_name, si.quantity AS quantity
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      JOIN products p ON p.id = si.product_id
      WHERE s.customer_id = ?
        AND s.type = 'sale'
        AND s.archived = 0
        AND si.price > 0
        AND p.type = 'keg'
        AND s.date >= ?
        AND strftime('%Y', s.date) = ?
        AND strftime('%m', s.date) = ?
    `).all(customerId, queryStartDate, String(year), monthStr);

    let total = 0, yellow = 0, black = 0;
    for (const row of rows) {
      const q = Number(row.quantity) || 0;
      total += q;
      if (this.classifyBeer(row.product_name) === 'black') {
        black += q;
      } else {
        yellow += q;
      }
    }
    return { total, yellow, black };
  }

  /**
   * Xác định reward tier dựa trên sản lượng tháng (BIA INOX V2)
   * QUY TẮC MỚI (xem src/services/promotionCalc.js - SINGLE SOURCE OF TRUTH):
   *   - Tách riêng yellowVolume/blackVolume
   *   - Chỉ vàng → tính vàng
   *   - Chỉ đen → tính đen
   *   - Cả 2 ≥ 300 → SEPARATE (thưởng riêng từng loại)
   *   - Có cả 2 nhưng không cùng ≥ 300 → MIXED (tổng hỗn hợp, thưởng bia vàng)
   * KHÔNG cộng dồn mốc.
   *
   * @returns {{
   *   mode, tier, yellowReward, blackReward, totalReward, liters,
   *   yellowVolume, blackVolume, totalVolume,
   *   nextTier, nextTierLiters, progressToNext, litersToNext,
   *   totalRewardEarned, remainingReward,
   *   monthlyLiters
   * }}
   */
  calculateMonthlyReward(customerId) {
    const settings = this.getSystemPromotionSettings();
    if (!settings.rewardEnabled) {
      return this._buildEmptyRewardResult();
    }

    if (!this.isWithinPromotionPeriod()) {
      const result = this._buildEmptyRewardResult();
      result.outOfPeriod = true;
      return result;
    }

    const customer = db.prepare('SELECT promotion_enabled FROM customers WHERE id = ?').get(customerId);
    if (customer && customer.promotion_enabled === 0) {
      return this._buildEmptyRewardResult();
    }

    // Bia Inox V2: dùng calculatePromotion() - single source of truth
    const purchase = this.calculateMonthlyPurchasedLiters(customerId);
    const { yellow: yellowVolume, black: blackVolume, total: totalVolume } = purchase;

    const calc = promotionCalc.calculatePromotion(yellowVolume, blackVolume);

    // Đã nhận thưởng tháng này chưa (giữ logic cũ cho backward compat)
    const claimedLiters = this._getHighestRewardClaimed(customerId);
    const remainingReward = Math.max(0, calc.totalReward - claimedLiters);

    // Tính next tier progress
    const nextTierInfo = promotionCalc.getNextTierProgress(yellowVolume, blackVolume);
    let progressToNext = 0;
    let litersToNext = nextTierInfo.litersToNext;
    if (nextTierInfo.nextThreshold && nextTierInfo.nextThreshold > 0) {
      // Dùng volume tương ứng với mode để tính %
      let progressVolume = totalVolume;
      if (nextTierInfo.isSeparate) {
        // Nếu vàng chưa đạt 500 → dùng yellowVolume; ngược lại dùng blackVolume
        if (yellowVolume < nextTierInfo.nextThreshold) progressVolume = yellowVolume;
        else progressVolume = blackVolume;
      }
      progressToNext = Math.min(100, Math.round((progressVolume / nextTierInfo.nextThreshold) * 100));
    } else {
      progressToNext = 100;
    }

    // nextTier label dựa trên reward tiếp theo (chỉ mang tính chất label)
    const nextReward = nextTierInfo.nextThreshold ? promotionCalc.tierReward(nextTierInfo.nextThreshold) : 0;
    const nextTierLabel = nextTierInfo.nextThreshold ? `BONUS_${nextReward}L` : null;

    return {
      mode: calc.mode,
      // Backward compat: tier = name cho code cũ (route sales.js, dashboard)
      tier: calc.totalReward > 0 ? `BONUS_${calc.totalReward}L` : this.TIER_NONE,
      // Bia Inox V2: chi tiết vàng/đen
      yellowReward: calc.yellowReward,
      blackReward: calc.blackReward,
      totalReward: calc.totalReward,
      liters: calc.totalReward, // backward compat: liters = totalReward
      yellowVolume,
      blackVolume,
      totalVolume,
      // Progress
      nextTier: nextTierLabel,
      nextTierLiters: nextTierInfo.nextThreshold || 0,
      progressToNext,
      litersToNext,
      // Claim tracking
      totalRewardEarned: claimedLiters,
      remainingReward,
      monthlyLiters: totalVolume,
      hasRemaining: remainingReward > 0
    };
  }

  _buildEmptyRewardResult() {
    return {
      mode: promotionCalc.REWARD_MODES.NONE,
      tier: this.TIER_NONE,
      yellowReward: 0,
      blackReward: 0,
      totalReward: 0,
      liters: 0,
      yellowVolume: 0,
      blackVolume: 0,
      totalVolume: 0,
      nextTier: null,
      nextTierLiters: 0,
      progressToNext: 0,
      litersToNext: 0,
      totalRewardEarned: 0,
      remainingReward: 0,
      monthlyLiters: 0,
      hasRemaining: false
    };
  }

  _getNextTier(tiers, currentLiters) {
    for (const tier of tiers) {
      if (tier.threshold > currentLiters) {
        return tier;
      }
    }
    return null;
  }

  /**
   * Lấy reward tier cao nhất đã nhận (từ lịch sử)
   * BIA INOX V2: Tính cả yellowReward + blackReward đã nhận.
   * @returns {{ yellow: number, black: number, total: number }}
   */
  _getHighestRewardClaimed(customerId) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const history = db.prepare(`
      SELECT reward_claimed_liters FROM customer_monthly_stats
      WHERE customer_id = ? AND year = ? AND month = ? AND reward_claimed = 1
    `).get(customerId, year, month);

    // Bia Inox V2: Tính riêng yellow/black đã nhận trong tháng hiện tại
    const rewardsByType = db.prepare(`
      SELECT COALESCE(SUM(reward_yellow_liters), 0) as yellow,
             COALESCE(SUM(reward_black_liters), 0) as black
      FROM reward_history
      WHERE customer_id = ?
        AND strftime('%Y', claimed_at) = ?
        AND strftime('%m', claimed_at) = ?
    `).get(customerId, String(year), String(month).padStart(2, '0'));

    const total = history ? (history.reward_claimed_liters || 0) : 0;
    return {
      total,
      yellow: rewardsByType ? (rewardsByType.yellow || 0) : 0,
      black: rewardsByType ? (rewardsByType.black || 0) : 0
    };
  }

  /**
   * Lấy thưởng cao nhất khách có thể nhận (tier hiện tại - đã nhận)
   * @returns {number} Số lít còn lại có thể nhận
   */
  getHighestEligibleReward(customerId) {
    const reward = this.calculateMonthlyReward(customerId);
    return {
      tier: reward.tier,
      eligibleLiters: reward.liters,
      alreadyClaimed: reward.totalRewardEarned,
      remaining: reward.remainingReward,
      hasRemaining: reward.hasRemaining
    };
  }

  /**
   * Lấy số lít thưởng còn lại khách có thể nhận
   * @returns {number} Số lít còn lại
   */
  getRemainingReward(customerId) {
    const reward = this.calculateMonthlyReward(customerId);
    return reward.remainingReward;
  }

  // ── 3. NHẬN THƯỞNG ──────────────────────────────────────

  /**
   * Lấy thông tin reward hiện tại của khách (từ DB)
   * BIA INOX V2: Trả về cả yellowReward/blackReward/totalReward.
   */
  getRewardStatus(customerId) {
    const customer = db.prepare('SELECT reward_tier, reward_claimed, reward_claimed_at FROM customers WHERE id = ?').get(customerId);
    if (!customer) return null;

    const purchase = this.calculateMonthlyPurchasedLiters(customerId);
    const rewardInfo = this.calculateMonthlyReward(customerId);

    return {
      tier: customer.reward_tier || this.TIER_NONE,
      claimed: customer.reward_claimed === 1,
      claimedAt: customer.reward_claimed_at,
      monthlyLiters: purchase.total,
      yellowVolume: purchase.yellow,
      blackVolume: purchase.black,
      ...rewardInfo
    };
  }

  /**
   * Nhận thưởng: tạo phiếu xuất kho 0đ + trừ kho
   * INVENTORY RULES: trừ kho thật, KHÔNG cộng doanh thu, KHÔNG cộng công nợ
   * BIA INOX V2: Hỗ trợ SEPARATE - tạo 2 row reward riêng (vàng + đen).
   * @param {number} customerId
   * @param {number} productId - chỉ dùng làm fallback; hàm tự tìm product vàng/đen
   * @returns {{ success, saleId, rewardLiters, yellowReward, blackReward, tier }}
   */
  claimMonthlyReward(customerId, productId) {
    const status = this.getRewardStatus(customerId);
    if (!status) return { success: false, error: 'Không tìm thấy khách hàng' };
    if (!status.hasRemaining) return { success: false, error: 'Đã nhận đủ thưởng hoặc chưa đủ điều kiện' };

    const yellowReward = status.yellowReward || 0;
    const blackReward = status.blackReward || 0;
    const totalRewardLiters = yellowReward + blackReward;
    if (totalRewardLiters <= 0) return { success: false, error: 'Không có phần thưởng để nhận' };

    // remainingReward ở đây dựa trên totalReward; trong trường hợp SEPARATE, claim từng phần
    // Để backward compat: chỉ claim 1 phần tương ứng với totalReward (nhưng tách row vàng/đen).
    const rewardLiters = totalRewardLiters;

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const tx = db.transaction(() => {
      // 1. Tạo phiếu xuất kho thưởng (sale type='sale', total=0)
      const saleDate = db.getVietnamDateStr();
      // B16/Bia Inox V2: Note có "tháng X/Y" + thông tin yellow/black để detect đã nhận
      const noteSuffix = yellowReward > 0 && blackReward > 0
        ? `${rewardLiters}L (${yellowReward}L vàng + ${blackReward}L đen)`
        : `${rewardLiters}L`;
      const result = db.prepare(`
        INSERT INTO sales (customer_id, date, total, profit, type, promo_type, reward_liters_used, note)
        VALUES (?, ?, ?, 0, 'sale', 'MONTHLY_BONUS', ?, ?)
      `).run(customerId, saleDate, 0, rewardLiters, `Thưởng doanh số tháng ${month}/${year} - ${noteSuffix} miễn phí`);

      const saleId = result.lastInsertRowid;

      // 2. Bia Inox V2: Thêm từng row riêng theo loại bia
      // - Nếu SEPARATE → 2 row (1 vàng + 1 đen)
      // - Nếu YELLOW_ONLY → 1 row vàng
      // - Nếu BLACK_ONLY → 1 row đen
      // - Nếu MIXED → 1 row vàng
      const goldProduct = this._findRewardProduct('gold');
      const blackProduct = this._findRewardProduct('black');

      // Bia vàng
      if (yellowReward > 0 && goldProduct) {
        db.prepare(`
          INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price, profit)
          VALUES (?, ?, ?, 0, 0, 0)
        `).run(saleId, goldProduct.id, yellowReward);
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(yellowReward, goldProduct.id);

        const customerNameRec = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId);
        db.prepare(`
          INSERT INTO product_audit_log (product_id, type, quantity, reason, ref_id, ref_type, customer_name, note)
          VALUES (?, 'export', ?, 'reward', ?, 'sale', ?, ?)
        `).run(goldProduct.id, yellowReward, saleId, customerNameRec?.name || '', `Thưởng doanh số tháng ${month}/${year} - bia vàng`);
      }

      // Bia đen
      if (blackReward > 0 && blackProduct) {
        db.prepare(`
          INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price, profit)
          VALUES (?, ?, ?, 0, 0, 0)
        `).run(saleId, blackProduct.id, blackReward);
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(blackReward, blackProduct.id);

        const customerNameRec = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId);
        db.prepare(`
          INSERT INTO product_audit_log (product_id, type, quantity, reason, ref_id, ref_type, customer_name, note)
          VALUES (?, 'export', ?, 'reward', ?, 'sale', ?, ?)
        `).run(blackProduct.id, blackReward, saleId, customerNameRec?.name || '', `Thưởng doanh số tháng ${month}/${year} - bia đen`);
      }

      // 4. Ghi reward_history (lưu cả 2 phần riêng)
      db.prepare(`
        INSERT INTO reward_history (customer_id, reward_tier, reward_liters, reward_yellow_liters, reward_black_liters, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(customerId, status.tier, rewardLiters, yellowReward, blackReward, `Nhận thưởng tháng ${month}/${year} - ${noteSuffix}`);

      // 5. Cập nhật customer_monthly_stats
      const existingStats = db.prepare(`
        SELECT * FROM customer_monthly_stats WHERE customer_id = ? AND year = ? AND month = ?
      `).get(customerId, year, month);

      if (existingStats) {
        const newClaimed = (existingStats.reward_claimed_liters || 0) + rewardLiters;
        db.prepare(`
          UPDATE customer_monthly_stats SET
            reward_claimed = 1,
            reward_claimed_at = CURRENT_TIMESTAMP,
            reward_claimed_liters = ?,
            reward_claimed_sale_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(newClaimed, saleId, existingStats.id);
      } else {
        db.prepare(`
          INSERT INTO customer_monthly_stats
            (customer_id, year, month, reward_claimed, reward_claimed_at, reward_claimed_liters, reward_claimed_sale_id)
          VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?)
        `).run(customerId, year, month, rewardLiters, saleId);
      }

      return { saleId, rewardLiters, yellowReward, blackReward, tier: status.tier };
    });

    try {
      const result = tx();
      logger.info(`[PromotionService] Reward claimed: customer=${customerId}, liters=${result.rewardLiters} (y=${result.yellowReward}, b=${result.blackReward}), tier=${result.tier}`);
      return { success: true, ...result };
    } catch (e) {
      logger.error('claimMonthlyReward error:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Tìm sản phẩm bia vàng/đen để xuất thưởng
   * @param {'gold'|'black'} type
   */
  _findRewardProduct(type) {
    if (type === 'black') {
      return db.prepare(`
        SELECT id, name, slug, cost_price FROM products
        WHERE archived = 0 AND type = 'keg'
          AND (name LIKE '%Đen%' OR name LIKE '%DEN%' OR name LIKE '%den%'
            OR name LIKE '%Guinness%' OR name LIKE '%guinness%'
            OR name LIKE '%Kilkenny%' OR name LIKE '%kilkenny%'
            OR name LIKE '%Murphy%' OR name LIKE '%murphy%'
            OR name LIKE '%Smithwick%' OR name LIKE '%smithwick%')
        ORDER BY id ASC LIMIT 1
      `).get();
    }
    return db.prepare(`
      SELECT id, name, slug, cost_price FROM products
      WHERE archived = 0 AND type = 'keg'
        AND (name LIKE '%Vàng%' OR name LIKE '%VANG%' OR name LIKE '%vàng%' OR name LIKE '%Gold%' OR name LIKE '%gold%')
        AND (name NOT LIKE '%Đen%' AND name NOT LIKE '%DEN%' AND name NOT LIKE '%den%')
      ORDER BY id ASC LIMIT 1
    `).get();
  }

  /**
   * Claim reward với logic "chỉ nhận mức cao nhất" - overload của claimMonthlyReward
   * Sử dụng khi cần tính lại claim logic
   */
  claimHighestReward(customerId, productId) {
    const remaining = this.getRemainingReward(customerId);
    if (remaining <= 0) {
      return { success: false, error: 'Không còn thưởng để nhận' };
    }
    return this.claimMonthlyReward(customerId, productId);
  }

  /**
   * Tự động trả thưởng cho đơn hàng đầu tiên trong tháng
   * Thưởng dựa trên sản lượng tháng TRƯỚC (tháng trả thưởng)
   * Ví dụ: tháng 5 đạt 500L → đơn hàng đầu tiên tháng 6 sẽ được thưởng
   * CHỈ trả thưởng nếu tháng trả thưởng nằm trong thời gian áp dụng
   * BIA INOX V2: Tính riêng yellowVolume/blackVolume để quyết định reward.
   * @returns {{ success, saleId, rewardLiters, yellowReward, blackReward, tier } | null}
   */
  autoClaimMonthlyReward(customerId) {
    const settings = this.getSystemPromotionSettings();
    if (!settings.rewardEnabled) return null;

    if (!this.isWithinPromotionPeriod()) return null;

    // Xác định tháng trả thưởng (tháng trước)
    const now = new Date();
    const rewardMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const rewardYear = rewardMonth.getFullYear();
    const rewardMonthNum = rewardMonth.getMonth() + 1;

    const rewardMonthStart = new Date(rewardYear, rewardMonthNum - 1, 1);
    const rewardMonthEnd = new Date(rewardYear, rewardMonthNum, 0, 23, 59, 59, 999);

    if (!this._isMonthInPromotionPeriod(rewardMonthStart, rewardMonthEnd)) {
      logger.info(`[PROMOTION] Thang ${rewardMonthNum}/${rewardYear} nam ngoai thoi gian ap dung, khong tra thuong`);
      return null;
    }

    const customer = db.prepare('SELECT promotion_enabled FROM customers WHERE id = ?').get(customerId);
    if (customer && customer.promotion_enabled === 0) return null;

    const rewardMonthStr = String(rewardMonthNum).padStart(2, '0');

    // Bia Inox V2: Tính yellow/black riêng theo sản phẩm
    const rows = db.prepare(`
      SELECT p.name AS product_name, si.quantity AS quantity
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

    let yellowVolume = 0, blackVolume = 0;
    for (const row of rows) {
      const q = Number(row.quantity) || 0;
      if (this.classifyBeer(row.product_name) === 'black') blackVolume += q;
      else yellowVolume += q;
    }

    const calc = promotionCalc.calculatePromotion(yellowVolume, blackVolume);
    if (calc.totalReward <= 0) return null;

    // Đã nhận thưởng tháng này chưa
    const statsRow = db.prepare(`
      SELECT reward_claimed FROM customer_monthly_stats
      WHERE customer_id = ? AND year = ? AND month = ?
    `).get(customerId, rewardYear, rewardMonth);

    if (statsRow && statsRow.reward_claimed === 1) return null;

    return this.claimMonthlyReward(customerId, null);
  }

  // ═══════════════════════════════════════════════════════════════
  // PENDING REWARDS - Lưu thưởng và tự động thêm vào hóa đơn đầu tiên
  // ═══════════════════════════════════════════════════════════════

  /**
   * Lưu pending reward vào bảng pending_rewards
   * Gọi khi kết thúc tháng và khách đạt thưởng
   * BIA INOX V2: Hỗ trợ yellowReward + blackReward.
   */
  savePendingReward(customerId, rewardMonth, rewardYear, liters, tier, yellowReward, blackReward, mode) {
    const monthStr = String(rewardMonth).padStart(2, '0');
    try {
      db.prepare(`
        INSERT OR REPLACE INTO pending_rewards 
        (customer_id, reward_month, reward_year, reward_liters, reward_yellow_liters, reward_black_liters, mode, reward_tier)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(customerId, rewardMonth, rewardYear, liters, yellowReward || 0, blackReward || 0, mode || null, tier || null);
      logger.info(`[PENDING_REWARD] Saved: customer=${customerId}, month=${rewardMonth}/${rewardYear}, liters=${liters}L (y=${yellowReward || 0}, b=${blackReward || 0})`);
      return true;
    } catch (e) {
      logger.error('[PENDING_REWARD] Save error:', e);
      return false;
    }
  }

  /**
   * Lấy pending reward của khách (nếu có)
   */
  getPendingReward(customerId) {
    const pending = db.prepare(`
      SELECT * FROM pending_rewards WHERE customer_id = ? LIMIT 1
    `).get(customerId);
    return pending || null;
  }

  /**
   * Xóa pending reward của khách (sau khi đã thêm vào hóa đơn)
   */
  clearPendingReward(customerId) {
    try {
      db.prepare('DELETE FROM pending_rewards WHERE customer_id = ?').run(customerId);
      return true;
    } catch (e) {
      logger.error('[PENDING_REWARD] Clear error:', e);
      return false;
    }
  }

  /**
   * Thêm pending reward vào hóa đơn hiện tại
   * Gọi sau khi tạo hóa đơn thành công
   * BIA INOX V2: Hỗ trợ 2 row reward riêng (yellow + black).
   * @returns {{ added, rewardLiters, rewardMonth, rewardYear, yellowReward, blackReward, mode }}
   */
  addPendingRewardToSale(saleId, customerId) {
    const pending = this.getPendingReward(customerId);
    if (!pending) return { added: false };

    const reward_liters = pending.reward_liters || 0;
    const reward_yellow = pending.reward_yellow_liters || 0;
    const reward_black = pending.reward_black_liters || 0;
    const reward_month = pending.reward_month;
    const reward_year = pending.reward_year;
    const reward_tier = pending.reward_tier;

    try {
      const goldProduct = reward_yellow > 0 ? this._findRewardProduct('gold') : null;
      const blackProduct = reward_black > 0 ? this._findRewardProduct('black') : null;

      if (!goldProduct && !blackProduct) {
        logger.warn('[PENDING_REWARD] No product found for reward');
        return { added: false };
      }

      const tx = db.transaction(() => {
        // 1a. Bia vàng (nếu có)
        if (reward_yellow > 0 && goldProduct) {
          db.prepare(`
            INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit, price_at_time)
            VALUES (?, ?, ?, ?, 0, 0, 0, 0)
          `).run(saleId, goldProduct.id, goldProduct.slug || '', reward_yellow);
          db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(reward_yellow, goldProduct.id);

          const customer = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId);
          db.prepare(`
            INSERT INTO product_audit_log (product_id, type, quantity, reason, ref_id, ref_type, customer_name, note)
            VALUES (?, 'export', ?, 'pending_reward', ?, 'sale', ?, ?)
          `).run(goldProduct.id, reward_yellow, saleId, customer?.name || '', `Trả thưởng sản lượng tháng ${reward_month}/${reward_year} - bia vàng`);
        }

        // 1b. Bia đen (nếu có)
        if (reward_black > 0 && blackProduct) {
          db.prepare(`
            INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit, price_at_time)
            VALUES (?, ?, ?, ?, 0, 0, 0, 0)
          `).run(saleId, blackProduct.id, blackProduct.slug || '', reward_black);
          db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(reward_black, blackProduct.id);

          const customer = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId);
          db.prepare(`
            INSERT INTO product_audit_log (product_id, type, quantity, reason, ref_id, ref_type, customer_name, note)
            VALUES (?, 'export', ?, 'pending_reward', ?, 'sale', ?, ?)
          `).run(blackProduct.id, reward_black, saleId, customer?.name || '', `Trả thưởng sản lượng tháng ${reward_month}/${reward_year} - bia đen`);
        }

        // 2. Cập nhật hóa đơn: đánh dấu có reward + cập nhật số vỏ giao
        const noteSuffix = reward_yellow > 0 && reward_black > 0
          ? ` (${reward_yellow}L vàng + ${reward_black}L đen)`
          : '';
        // B19: Cast tháng/năm sang TEXT để tránh concat với REAL (note lỡ có '.0')
        db.prepare(`
          UPDATE sales SET
            promo_type = 'MONTHLY_BONUS',
            reward_liters_used = ?,
            promo_free_liters = promo_free_liters + ?,
            deliver_kegs = deliver_kegs + ?,
            note = COALESCE(note, '') || ' | Trả thưởng sản lượng tháng ' || CAST(? AS TEXT) || '/' || CAST(? AS TEXT) || ?
          WHERE id = ?
        `).run(reward_liters, reward_liters, reward_liters, reward_month, reward_year, noteSuffix, saleId);

        // 5b. Cập nhật keg_balance của khách (thêm vỏ thưởng)
        db.prepare('UPDATE customers SET keg_balance = keg_balance + ? WHERE id = ?').run(reward_liters, customerId);

        // 6. Ghi reward_history (lưu cả 2 phần riêng)
        db.prepare(`
          INSERT INTO reward_history (customer_id, reward_tier, reward_liters, reward_yellow_liters, reward_black_liters, note)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(customerId, reward_tier || 'MONTHLY_BONUS', reward_liters, reward_yellow, reward_black, `Trả thưởng sản lượng tháng ${reward_month}/${reward_year} - tự động qua hóa đơn đầu tiên${noteSuffix}`);

        // 7. Cập nhật customer_monthly_stats
        const existingStats = db.prepare(`
          SELECT * FROM customer_monthly_stats WHERE customer_id = ? AND year = ? AND month = ?
        `).get(customerId, reward_year, reward_month);

        if (existingStats) {
          const newClaimed = (existingStats.reward_claimed_liters || 0) + reward_liters;
          db.prepare(`
            UPDATE customer_monthly_stats SET
              reward_claimed = 1,
              reward_claimed_at = CURRENT_TIMESTAMP,
              reward_claimed_liters = ?,
              reward_claimed_sale_id = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(newClaimed, saleId, existingStats.id);
        } else {
          db.prepare(`
            INSERT INTO customer_monthly_stats
              (customer_id, year, month, reward_claimed, reward_claimed_at, reward_claimed_liters, reward_claimed_sale_id)
            VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?)
          `).run(customerId, reward_year, reward_month, reward_liters, saleId);
        }

        // 8. Xóa pending reward
        db.prepare('DELETE FROM pending_rewards WHERE customer_id = ?').run(customerId);
      });

      tx();
      logger.info(`[PENDING_REWARD] Added to sale ${saleId}: y=${reward_yellow}L b=${reward_black}L for month ${reward_month}/${reward_year}`);
      return {
        added: true,
        rewardLiters: reward_liters,
        rewardMonth: reward_month,
        rewardYear: reward_year,
        yellowReward: reward_yellow,
        blackReward: reward_black,
        mode: pending.mode || null
      };
    } catch (e) {
      logger.error('[PENDING_REWARD] Add to sale error:', e);
      return { added: false, error: e.message };
    }
  }

  /**
   * Kiểm tra và tự động thêm pending reward vào đơn hàng đầu tiên của tháng
   * Gọi khi tạo hóa đơn mới
   * @returns {{ added, rewardLiters, rewardMonth, rewardYear }} hoặc null
   */
  checkAndAddPendingRewardToFirstSale(customerId, currentSaleId) {
    // Kiểm tra khách có pending reward không
    const pending = this.getPendingReward(customerId);
    if (!pending) return null;

    const { reward_month, reward_year, reward_liters } = pending;
    const rewardMonthName = this._getMonthName(reward_month);

    // Thêm reward vào hóa đơn
    const result = this.addPendingRewardToSale(currentSaleId, customerId);
    if (result.added) {
      return result;
    }
    return null;
  }

  /**
   * Lấy tên tháng tiếng Việt
   */
  _getMonthName(monthNum) {
    const months = ['Một', 'Hai', 'Ba', 'Tư', 'Năm', 'Sáu', 'Bảy', 'Tám', 'Chín', 'Mười', 'Mười một', 'Mười hai'];
    return months[(monthNum - 1) % 12] || 'Unknown';
  }

  /**
   * Lấy thông tin thưởng dựa trên sản lượng tháng trước
   * ƯU TIÊN: Kiểm tra pending_rewards trước, nếu không có thì tính toán và lưu vào pending
   * BIA INOX V2: Trả về yellowReward, blackReward, mode. Phần thưởng là BIA VÀNG (MIXED)
   *   hoặc 2 loại riêng (SEPARATE), dựa trên sản lượng tháng trước.
   * @returns {{ eligible, rewardLiters, yellowReward, blackReward, mode, tier, alreadyClaimed, rewardMonth, rewardYear }}
   */
  getRewardForPrevMonth(customerId) {
    const settings = this.getSystemPromotionSettings();
    if (!settings.rewardEnabled) return { eligible: false, rewardLiters: 0, yellowReward: 0, blackReward: 0, mode: null, tier: null, alreadyClaimed: false };

    const customer = db.prepare('SELECT promotion_enabled FROM customers WHERE id = ?').get(customerId);
    if (customer && customer.promotion_enabled === 0) return { eligible: false, rewardLiters: 0, yellowReward: 0, blackReward: 0, mode: null, tier: null, alreadyClaimed: false };

    const now = new Date();
    const rewardMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const rewardYear = rewardMonth.getFullYear();
    const rewardMonthNum = rewardMonth.getMonth() + 1;
    const rewardMonthStr = String(rewardMonthNum).padStart(2, '0');

    const program = this.determinePromotionProgram(customerId, rewardYear, rewardMonthNum);
    if (program === 'NEW_CUSTOMER') {
      return {
        eligible: false,
        rewardLiters: 0,
        yellowReward: 0,
        blackReward: 0,
        mode: null,
        tier: null,
        alreadyClaimed: false,
        rewardMonth: rewardMonthNum,
        rewardYear,
        reason: 'Thuộc chương trình Quán mới, không nhận thưởng sản lượng'
      };
    }

    // ƯU TIÊN 1: Kiểm tra pending_rewards table
    const pendingReward = db.prepare(`
      SELECT * FROM pending_rewards
      WHERE customer_id = ? AND reward_month = ? AND reward_year = ?
    `).get(customerId, rewardMonthNum, rewardYear);

    if (pendingReward) {
      const claimed = db.prepare(`
        SELECT COUNT(*) as cnt FROM reward_history
        WHERE customer_id = ?
          AND note LIKE ?
      `).get(customerId, `%tháng ${rewardMonthNum}/${rewardYear}%`);

      const yellow = pendingReward.reward_yellow_liters || 0;
      const black = pendingReward.reward_black_liters || 0;
      return {
        eligible: !claimed || claimed.cnt === 0,
        rewardLiters: pendingReward.reward_liters,
        yellowReward: yellow,
        blackReward: black,
        mode: pendingReward.mode || null,
        tier: pendingReward.reward_tier || `BONUS_${pendingReward.reward_liters}L`,
        alreadyClaimed: claimed && claimed.cnt > 0,
        rewardMonth: rewardMonthNum,
        rewardYear: rewardYear
      };
    }

    // ƯU TIÊN 2: Tính toán sản lượng tháng trước (backward compatible)
    // Bia Inox V2: tính yellow/black riêng
    const rows = db.prepare(`
      SELECT p.name AS product_name, si.quantity AS quantity
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

    let yellowVolume = 0, blackVolume = 0;
    for (const row of rows) {
      const q = Number(row.quantity) || 0;
      if (this.classifyBeer(row.product_name) === 'black') blackVolume += q;
      else yellowVolume += q;
    }

    const calc = promotionCalc.calculatePromotion(yellowVolume, blackVolume);
    if (calc.totalReward <= 0) return { eligible: false, rewardLiters: 0, yellowReward: 0, blackReward: 0, mode: null, tier: null, alreadyClaimed: false, rewardMonth: rewardMonthNum, rewardYear };

    // Kiểm tra đã nhận thưởng tháng trước chưa
    const alreadyClaimed = db.prepare(`
      SELECT COUNT(*) as cnt FROM reward_history
      WHERE customer_id = ?
        AND note LIKE ?
    `).get(customerId, `%tháng ${rewardMonthNum}/${rewardYear}%`);

    const claimed = alreadyClaimed && alreadyClaimed.cnt > 0;

    const tierName = `BONUS_${calc.totalReward}L`;

    // Lưu vào pending_rewards để đơn hàng sau có thể sử dụng
    if (!claimed) {
      const productId = (calc.yellowReward > 0 ? this._findRewardProduct('gold')?.id : null)
        || (calc.blackReward > 0 ? this._findRewardProduct('black')?.id : null);

      db.prepare(`
        INSERT OR REPLACE INTO pending_rewards
          (customer_id, reward_month, reward_year, reward_liters, reward_yellow_liters, reward_black_liters, mode, reward_tier, product_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(customerId, rewardMonthNum, rewardYear, calc.totalReward, calc.yellowReward, calc.blackReward, calc.mode, tierName, productId);
    }

    return {
      eligible: !claimed,
      rewardLiters: calc.totalReward,
      yellowReward: calc.yellowReward,
      blackReward: calc.blackReward,
      mode: calc.mode,
      tier: tierName,
      alreadyClaimed: claimed,
      rewardMonth: rewardMonthNum,
      rewardYear: rewardYear
    };
  }

  /**
   * Gắn thưởng vào đơn hàng hiện tại (thay vì tạo đơn riêng)
   * BIA INOX V2: Hỗ trợ yellowReward + blackReward riêng (SEPARATE mode).
   *
   * @param {number} customerId
   * @param {number} saleId
   * @param {number} rewardLiters - Tổng lít (yellowReward + blackReward)
   * @param {string} tier
   * @param {number} yellowReward
   * @param {number} blackReward
   * @param {number} [rewardMonth]
   * @param {number} [rewardYear]
   */
  attachRewardToSale(customerId, saleId, rewardLiters, tier, rewardMonth, rewardYear, yellowReward, blackReward) {
    // KIỂM TRA AN TOÀN: Kiểm tra reward_history trước khi gắn
    const actualRewardMonth = (rewardMonth !== undefined && rewardMonth !== null) ? rewardMonth : null;
    const actualRewardYear = (rewardYear !== undefined && rewardYear !== null) ? rewardYear : null;

    if (actualRewardMonth !== null && actualRewardYear !== null) {
      const existingHistory = db.prepare(`
        SELECT COUNT(*) as cnt FROM reward_history
        WHERE customer_id = ? AND note LIKE ?
      `).get(customerId, `%tháng ${actualRewardMonth}/${actualRewardYear}%`);

      if (existingHistory && existingHistory.cnt > 0) {
        logger.warn(`[PromotionService] attachRewardToSale: Da co reward_history cho thang ${actualRewardMonth}/${actualRewardYear}, khong gan thuong`);
        return { success: false, error: 'Da co reward history cho thang nay' };
      }
    }

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    const prevMonthDate = new Date(currentYear, currentMonth - 2, 1);
    const finalRewardMonth = (rewardMonth !== undefined && rewardMonth !== null) ? rewardMonth : (prevMonthDate.getMonth() + 1);
    const finalRewardYear = (rewardYear !== undefined && rewardYear !== null) ? rewardYear : (currentMonth === 1 ? currentYear - 1 : currentYear);

    // Bia Inox V2: Tìm product vàng/đen dựa vào yellowReward/blackReward
    const goldProduct = (yellowReward > 0) ? this._findRewardProduct('gold') : null;
    const blackProduct = (blackReward > 0) ? this._findRewardProduct('black') : null;

    if (!goldProduct && !blackProduct) {
      // Fallback: lấy bất kỳ keg nào
      const anyProduct = db.prepare('SELECT id FROM products WHERE archived = 0 AND type = \'keg\' ORDER BY id ASC LIMIT 1').get();
      if (!anyProduct) return { success: false, error: 'Không tìm thấy sản phẩm' };
      return this._doAttachReward(customerId, saleId, anyProduct.id, rewardLiters, tier, finalRewardMonth, finalRewardYear, yellowReward, blackReward);
    }

    return this._doAttachReward(customerId, saleId, null, rewardLiters, tier, finalRewardMonth, finalRewardYear, yellowReward, blackReward, goldProduct, blackProduct);
  }

  /**
   * _doAttachReward — Bia Inox V2: hỗ trợ 2 reward riêng (vàng + đen).
   * @param {object} goldProduct (optional)
   * @param {object} blackProduct (optional)
   */
  _doAttachReward(customerId, saleId, productId, rewardLiters, tier, rewardMonth, rewardYear, yellowReward, blackReward, goldProduct, blackProduct) {
    yellowReward = yellowReward || 0;
    blackReward = blackReward || 0;

    const tx = db.transaction(() => {
      // 1. Thêm item vào sale hiện tại (price=0)
      // Bia Inox V2: tách thành 2 row nếu có cả vàng + đen
      if (yellowReward > 0 && goldProduct) {
        db.prepare(`
          INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price, profit)
          VALUES (?, ?, ?, 0, 0, 0)
        `).run(saleId, goldProduct.id, yellowReward);
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(yellowReward, goldProduct.id);

        const customer = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId);
        db.prepare(`
          INSERT INTO product_audit_log (product_id, type, quantity, reason, ref_id, ref_type, customer_name, note)
          VALUES (?, 'export', ?, 'reward', ?, 'sale', ?, ?)
        `).run(goldProduct.id, yellowReward, saleId, customer?.name || '', `Trả thưởng sản lượng tháng ${rewardMonth}/${rewardYear} - bia vàng`);
      }

      if (blackReward > 0 && blackProduct) {
        db.prepare(`
          INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price, profit)
          VALUES (?, ?, ?, 0, 0, 0)
        `).run(saleId, blackProduct.id, blackReward);
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(blackReward, blackProduct.id);

        const customer = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId);
        db.prepare(`
          INSERT INTO product_audit_log (product_id, type, quantity, reason, ref_id, ref_type, customer_name, note)
          VALUES (?, 'export', ?, 'reward', ?, 'sale', ?, ?)
        `).run(blackProduct.id, blackReward, saleId, customer?.name || '', `Trả thưởng sản lượng tháng ${rewardMonth}/${rewardYear} - bia đen`);
      }

      // Fallback: 1 row nếu không có tách
      if (yellowReward === 0 && blackReward === 0 && productId) {
        db.prepare(`
          INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price, profit)
          VALUES (?, ?, ?, 0, 0, 0)
        `).run(saleId, productId, rewardLiters);
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(rewardLiters, productId);
      }

      // 3. Cập nhật sale: đánh dấu có reward + cập nhật số vỏ giao
      const noteSuffix = yellowReward > 0 && blackReward > 0
        ? ` (${yellowReward}L vàng + ${blackReward}L đen)`
        : '';
      // B19: Cast tháng/năm sang TEXT để tránh concat với REAL (note lỡ có '.0')
      db.prepare(`
        UPDATE sales SET
          promo_type = 'MONTHLY_BONUS',
          reward_liters_used = ?,
          promo_free_liters = COALESCE(promo_free_liters, 0) + ?,
          deliver_kegs = deliver_kegs + ?,
          note = COALESCE(note, '') || ' | Trả thưởng sản lượng tháng ' || CAST(? AS TEXT) || '/' || CAST(? AS TEXT) || ?
        WHERE id = ?
      `).run(rewardLiters, rewardLiters, rewardLiters, rewardMonth, rewardYear, noteSuffix, saleId);

      // 3b. Cập nhật keg_balance và reward_claimed của khách
      db.prepare('UPDATE customers SET keg_balance = keg_balance + ?, reward_claimed = 1, reward_claimed_at = CURRENT_TIMESTAMP WHERE id = ?').run(rewardLiters, customerId);

      // 5. Ghi reward_history (lưu cả 2 phần riêng)
      db.prepare(`
        INSERT INTO reward_history (customer_id, reward_tier, reward_liters, reward_yellow_liters, reward_black_liters, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(customerId, tier, rewardLiters, yellowReward, blackReward, `Trả thưởng sản lượng tháng ${rewardMonth}/${rewardYear} - tự động qua hóa đơn đầu tiên${noteSuffix}`);

      // 6. Cập nhật customer_monthly_stats (cập nhật tháng thưởng)
      const existingStats = db.prepare(`
        SELECT * FROM customer_monthly_stats WHERE customer_id = ? AND year = ? AND month = ?
      `).get(customerId, rewardYear, rewardMonth);

      if (existingStats) {
        const newClaimed = (existingStats.reward_claimed_liters || 0) + rewardLiters;
        db.prepare(`
          UPDATE customer_monthly_stats SET
            reward_claimed = 1,
            reward_claimed_at = CURRENT_TIMESTAMP,
            reward_claimed_liters = ?,
            reward_claimed_sale_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(newClaimed, saleId, existingStats.id);
      } else {
        db.prepare(`
          INSERT INTO customer_monthly_stats
            (customer_id, year, month, reward_claimed, reward_claimed_at, reward_claimed_liters, reward_claimed_sale_id)
          VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?)
        `).run(customerId, rewardYear, rewardMonth, rewardLiters, saleId);
      }

      // 7. Xóa pending reward nếu có
      db.prepare('DELETE FROM pending_rewards WHERE customer_id = ? AND reward_month = ? AND reward_year = ?')
        .run(customerId, rewardMonth, rewardYear);

      return { saleId, rewardLiters, yellowReward, blackReward, tier, rewardMonth, rewardYear };
    });

    try {
      const result = tx();
      logger.info(`[PromotionService] Reward attached: customer=${customerId}, sale=${saleId}, liters=${result.rewardLiters} (y=${result.yellowReward}, b=${result.blackReward}), month=${result.rewardMonth}/${result.rewardYear}`);
      return { success: true, ...result };
    } catch (e) {
      logger.error('attachRewardToSale error:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Reset reward tháng mới (gọi khi sang tháng)
   * Tự động reset vào ngày 1 hàng tháng qua cron
   */
  resetMonthlyRewards() {
    const tx = db.transaction(() => {
      // Reset customer_monthly_stats cho tháng mới
      const now = new Date();
      const newYear = now.getFullYear();
      const newMonth = now.getMonth() + 1;

      // Tạo monthly_stats cho tất cả khách active tháng mới
      const customers = db.prepare('SELECT id FROM customers WHERE archived = 0').all();
      for (const cust of customers) {
        const existing = db.prepare(`
          SELECT id FROM customer_monthly_stats WHERE customer_id = ? AND year = ? AND month = ?
        `).get(cust.id, newYear, newMonth);

        if (!existing) {
          db.prepare(`
            INSERT INTO customer_monthly_stats (customer_id, year, month, purchased_liters)
            VALUES (?, ?, ?, 0)
          `).run(cust.id, newYear, newMonth);
        }
      }

      logger.info(`[PromotionService] Monthly rewards reset for ${customers.length} customers`);
    });
    tx();
  }

  /**
   * Cập nhật sản lượng tháng cho customer (gọi sau mỗi đơn hàng mới)
   * BIA INOX V2: cộng dồn cả yellowVolume và blackVolume riêng.
   * @param {number} customerId
   * @param {number} purchasedLiters - tổng lít
   * @param {number} year
   * @param {number} month
   * @param {number} [yellowLiters] - mặc định = purchasedLiters (nếu là bia vàng)
   * @param {number} [blackLiters] - mặc định = 0
   */
  updateCustomerMonthlyStats(customerId, purchasedLiters, year, month, yellowLiters, blackLiters) {
    if (yellowLiters === undefined) yellowLiters = purchasedLiters || 0;
    if (blackLiters === undefined) blackLiters = 0;

    const existing = db.prepare(`
      SELECT * FROM customer_monthly_stats WHERE customer_id = ? AND year = ? AND month = ?
    `).get(customerId, year, month);

    if (existing) {
      db.prepare(`
        UPDATE customer_monthly_stats SET
          purchased_liters = purchased_liters + ?,
          purchased_yellow_liters = purchased_yellow_liters + ?,
          purchased_black_liters = purchased_black_liters + ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(purchasedLiters, yellowLiters, blackLiters, existing.id);
    } else {
      db.prepare(`
        INSERT INTO customer_monthly_stats
          (customer_id, year, month, purchased_liters, purchased_yellow_liters, purchased_black_liters)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(customerId, year, month, purchasedLiters, yellowLiters, blackLiters);
    }
  }

  /**
   * Quét dữ liệu để phát hiện khách hàng nhận trùng 2 loại khuyến mãi trong cùng tháng
   * Trả về danh sách các trường hợp sai
   * @returns {Array} Danh sách khách hàng có dữ liệu sai
   */
  auditPromotionConflicts() {
    const conflicts = [];

    // Lấy tất cả khách hàng
    const customers = db.prepare('SELECT id, name, created_at FROM customers WHERE archived = 0').all();

    for (const customer of customers) {
      const created = new Date(customer.created_at);
      const createdDay = created.getDate();
      const createdMonth = created.getMonth() + 1;
      const createdYear = created.getFullYear();

      // Với mỗi tháng từ tháng tạo, kiểm tra xem có xung đột không
      const now = new Date();
      let checkMonth = createdMonth;
      let checkYear = createdYear;

      while (checkYear < now.getFullYear() || (checkYear === now.getFullYear() && checkMonth <= now.getMonth())) {
        // Kiểm tra xem tháng này có đơn NEW_SHOP và MONTHLY_BONUS không
        const newShopSales = db.prepare(`
          SELECT COUNT(*) as cnt FROM sales
          WHERE customer_id = ?
            AND promo_type = 'NEW_SHOP'
            AND strftime('%Y', date) = ?
            AND strftime('%m', date) = ?
        `).get(customer.id, String(checkYear), String(checkMonth).padStart(2, '0'));

        const monthlyBonusSales = db.prepare(`
          SELECT COUNT(*) as cnt FROM sales
          WHERE customer_id = ?
            AND promo_type = 'MONTHLY_BONUS'
            AND strftime('%Y', date) = ?
            AND strftime('%m', date) = ?
        `).get(customer.id, String(checkYear), String(checkMonth).padStart(2, '0'));

        // Kiểm tra reward_history
        const rewardHistory = db.prepare(`
          SELECT COUNT(*) as cnt FROM reward_history
          WHERE customer_id = ?
            AND note LIKE ?
        `).get(customer.id, `%tháng ${checkMonth}/${checkYear}%`);

        // Kiểm tra pending_rewards
        const pendingReward = db.prepare(`
          SELECT * FROM pending_rewards
          WHERE customer_id = ? AND reward_month = ? AND reward_year = ?
        `).get(customer.id, checkMonth, checkYear);

        // Xác định chương trình nên áp dụng
        const shouldBeNewCustomer = (checkYear === createdYear && checkMonth === createdMonth && createdDay >= 9);

        // Kiểm tra xung đột
        const hasNewShopSale = newShopSales && newShopSales.cnt > 0;
        const hasMonthlyBonusSale = monthlyBonusSales && monthlyBonusSales.cnt > 0;
        const hasRewardHistory = rewardHistory && rewardHistory.cnt > 0;

        // Xung đột: có cả NEW_SHOP và MONTHLY_BONUS trong cùng tháng
        if (hasNewShopSale && hasMonthlyBonusSale) {
          conflicts.push({
            customerId: customer.id,
            customerName: customer.name,
            year: checkYear,
            month: checkMonth,
            type: 'BOTH_NEW_SHOP_AND_MONTHLY_BONUS',
            message: `Tháng ${checkMonth}/${checkYear}: Có cả đơn NEW_SHOP (${newShopSales.cnt}) và MONTHLY_BONUS (${monthlyBonusSales.cnt})`,
            shouldBeNewCustomer
          });
        }

        // Xung đột: thuộc quán mới nhưng lại có reward_history
        if (shouldBeNewCustomer && hasRewardHistory && !hasNewShopSale && hasMonthlyBonusSale) {
          conflicts.push({
            customerId: customer.id,
            customerName: customer.name,
            year: checkYear,
            month: checkMonth,
            type: 'NEW_CUSTOMER_RECEIVED_MONTHLY_REWARD',
            message: `Tháng ${checkMonth}/${checkYear}: Thuộc chương trình Quán mới nhưng có reward_history (${rewardHistory.cnt} lần)`,
            shouldBeNewCustomer
          });
        }

        // Tăng tháng
        checkMonth++;
        if (checkMonth > 12) {
          checkMonth = 1;
          checkYear++;
        }
      }
    }

    return conflicts;
  }

  // ── 4. LỊCH SỬ THƯỞNG ──────────────────────────────────

  /**
   * Lấy lịch sử nhận thưởng của 1 khách
   */
  getRewardHistory(customerId) {
    return db.prepare(`
      SELECT rh.*, c.name as customer_name
      FROM reward_history rh
      JOIN customers c ON c.id = rh.customer_id
      WHERE rh.customer_id = ?
      ORDER BY rh.claimed_at DESC
    `).all(customerId);
  }

  /**
   * Lấy tổng thưởng đã nhận trong tháng
   */
  getMonthlyRewardSummary(year, month) {
    const y = String(year);
    const m = String(month).padStart(2, '0');
    const result = db.prepare(`
      SELECT COALESCE(SUM(reward_liters), 0) as total_liters,
             COUNT(*) as total_claims
      FROM reward_history
      WHERE strftime('%Y', claimed_at) = ? AND strftime('%m', claimed_at) = ?
    `).get(y, m);
    return result || { total_liters: 0, total_claims: 0 };
  }

  // ── 5. STATS PROMOTION ──────────────────────────────────

  /**
   * Lấy số quán mới trong tháng hiện tại (tạo ngày 09+)
   */
  getActiveNewShopCount() {
    const settings = this.getSystemPromotionSettings();
    if (!settings.newShopEnabled) return 0;

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const monthStr = String(month).padStart(2, '0');

    // Đếm khách tạo trong tháng hiện tại với ngày >= 9
    const result = db.prepare(`
      SELECT COUNT(*) as count
      FROM customers
      WHERE archived = 0
        AND strftime('%Y', created_at) = ?
        AND strftime('%m', created_at) = ?
        AND CAST(strftime('%d', created_at) AS INTEGER) >= 9
        AND promotion_enabled = 1
    `).get(String(year), monthStr);
    return result ? result.count : 0;
  }

  /**
   * Top khách gần đạt mốc tiếp theo
   * BIA INOX V2: Trả cả yellowVolume + blackVolume để UI hiển thị chi tiết.
   */
  getNearRewardCustomers(limit = 10) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const settings = this.getSystemPromotionSettings();
    const tiers = settings.rewardTiers;

    if (!settings.rewardEnabled || tiers.length === 0) return [];

    return db.prepare(`
      SELECT
        c.id, c.name, c.phone,
        COALESCE(cms.purchased_liters, 0) as monthly_liters,
        COALESCE(cms.purchased_yellow_liters, 0) as yellow_volume,
        COALESCE(cms.purchased_black_liters, 0) as black_volume,
        COALESCE(cms.reward_claimed_liters, 0) as claimed_liters
      FROM customers c
      LEFT JOIN customer_monthly_stats cms ON cms.customer_id = c.id AND cms.year = ? AND cms.month = ?
      WHERE c.archived = 0 AND c.promotion_enabled = 1
      ORDER BY COALESCE(cms.purchased_liters, 0) DESC
      LIMIT ?
    `).all(String(year), month, limit);
  }

  // ── 6. LEGACY PROMOTION METHODS ─────────────────────────

  /**
   * Lấy tất cả promotions đang active
   */
  getActivePromotions(date = null) {
    const targetDate = date || db.getVietnamDateStr();
    return db.prepare(`
      SELECT * FROM promotions
      WHERE active = 1
        AND (start_date IS NULL OR start_date <= ?)
        AND (end_date IS NULL OR end_date >= ?)
      ORDER BY priority DESC, created_at DESC
    `).all(targetDate, targetDate);
  }

  /**
   * Tính giảm giá cho 1 đơn hàng
   */
  calculateDiscount(cart) {
    const { customerId, subtotal } = cart;
    const activePromotions = this.getActivePromotions();

    let totalDiscount = 0;
    const promotionsApplied = [];

    for (const promo of activePromotions) {
      if (!this._isEligible(promo, cart)) continue;

      let discount = 0;

      if (promo.type === 'percentage') {
        discount = Math.round(subtotal * (promo.value / 100));
        if (promo.max_discount && discount > promo.max_discount) {
          discount = promo.max_discount;
        }
      } else if (promo.type === 'fixed') {
        discount = promo.value;
      } else if (promo.type === 'buy_x_get_y') {
        discount = this._calculateBuyXGetY(promo, cart);
      }

      if (discount > 0) {
        totalDiscount += discount;
        promotionsApplied.push({
          id: promo.id,
          name: promo.name,
          type: promo.type,
          value: promo.value,
          discount
        });
      }
    }

    return {
      discount: totalDiscount,
      promotionsApplied,
      finalTotal: Math.max(0, subtotal - totalDiscount)
    };
  }

  _isEligible(promo, cart) {
    if (promo.customer_tier && promo.customer_tier !== 'all') {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(cart.customerId);
      if (!customer) return false;
      if (promo.customer_tier === 'vip' && customer.tier !== 'VIP') return false;
    }

    if (promo.min_order_value && cart.subtotal < promo.min_order_value) {
      return false;
    }

    if (promo.customer_segments) {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(cart.customerId);
      if (!customer) return false;
      const segments = JSON.parse(promo.customer_segments);
      if (!segments.includes(customer.segment)) return false;
    }

    return true;
  }

  _calculateBuyXGetY(promo, cart) {
    const buyQty = promo.buy_quantity || 1;
    const getQty = promo.get_quantity || 1;
    const discountPerUnit = promo.value || 0;

    let eligibleQty = 0;
    for (const item of cart.items || []) {
      if (item.type && item.type !== 'keg') continue;
      if (promo.product_id && item.productId !== promo.product_id) continue;
      eligibleQty += item.quantity;
    }

    const times = Math.floor(eligibleQty / (buyQty + getQty));
    return times * getQty * discountPerUnit;
  }

  /**
   * Ghi nhận first_order_date khi khách đặt đơn đầu tiên
   */
  setFirstOrderDate(customerId) {
    const customer = db.prepare('SELECT first_order_date FROM customers WHERE id = ?').get(customerId);
    if (customer && !customer.first_order_date) {
      db.prepare("UPDATE customers SET first_order_date = datetime('now', '+7 hours') WHERE id = ?").run(customerId);
    }
  }

  /**
   * Xác định loại bia (vàng/đen) dựa trên tên sản phẩm
   */
  classifyBeer(productName) {
    if (!productName) return 'gold';
    const name = productName.toLowerCase();
    const blackKeywords = ['guinness', 'kilkenny', 'murphy', 'black', 'đen', 'smithwick'];
    return blackKeywords.some(k => name.includes(k)) ? 'black' : 'gold';
  }

  create(data) {
    const { name, type, value, minOrderValue, maxDiscount,
            startDate, endDate, customerTier, customerSegments,
            productId, buyQuantity, getQuantity, active = 1, priority = 0 } = data;

    const createPromo = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO promotions
        (name, type, value, min_order_value, max_discount,
         start_date, end_date, customer_tier, customer_segments,
         product_id, buy_quantity, get_quantity, active, priority)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        name, type, value || 0, minOrderValue || null, maxDiscount || null,
        startDate || null, endDate || null, customerTier || null,
        customerSegments ? JSON.stringify(customerSegments) : null,
        productId || null, buyQuantity || null, getQuantity || null, active, priority
      );
      return result.lastInsertRowid;
    });

    return { success: true, promotionId: createPromo() };
  }
}

// ============================================================
// ANALYTICS SERVICE - Business logic cho báo cáo
// ============================================================
class AnalyticsService {
  /**
   * Dashboard summary - tất cả KPIs trong 1 query
   */
  getDashboardSummary(period = 'today') {
    const dates = this._getDateRange(period);
    const { startDate, endDate } = dates;

    // Batch query - lấy tất cả trong 1 transaction
    const getData = db.transaction(() => {
      // Revenue & Profit
      const revenue = db.prepare(`
        SELECT
          COALESCE(SUM(total), 0) as total,
          COALESCE(SUM(profit), 0) as profit,
          COUNT(*) as order_count
        FROM sales
        WHERE type = 'sale'
          AND (status IS NULL OR status != 'returned')
          AND archived = 0
          AND date(s.date) >= date(?)
          AND date(s.date) <= date(?)
      `).get(startDate, endDate);

      // Expenses
      const expenses = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM expenses
        WHERE date >= ? AND date <= ?
      `).get(startDate, endDate);

      // Top products
      const topProducts = db.prepare(`
        SELECT p.name, SUM(si.quantity) as qty, SUM(si.profit) as profit
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        JOIN products p ON p.id = si.product_id
        WHERE s.type = 'sale'
          AND (s.status IS NULL OR s.status != 'returned')
          AND date(s.date) >= date(?)
          AND date(s.date) <= date(?)
        GROUP BY p.id
        ORDER BY qty DESC
        LIMIT 5
      `).all(startDate, endDate);

      // Recent sales
      const recentSales = db.prepare(`
        SELECT s.*, COALESCE(c.name, 'Khách lẻ') as customer_name
        FROM sales s
        LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.type = 'sale'
          AND (s.status IS NULL OR s.status != 'returned')
          AND archived = 0
        ORDER BY datetime(s.date) DESC
        LIMIT 10
      `).all();

      // Low stock
      const lowStock = db.prepare(`
        SELECT * FROM products
        WHERE archived = 0 AND stock < 10
        ORDER BY stock ASC
        LIMIT 10
      `).all();

      return { revenue, expenses, topProducts, recentSales, lowStock };
    });

    const data = getData();

    return {
      period,
      startDate,
      endDate,
      revenue: data.revenue.total,
      profit: data.revenue.profit,
      orders: data.revenue.order_count,
      expenses: data.expenses.total,
      netProfit: data.revenue.profit - data.expenses.total,
      topProducts: data.topProducts,
      recentSales: data.recentSales,
      lowStock: data.lowStock
    };
  }

  /**
   * Get date range từ period
   */
  _getDateRange(period) {
    const today = db.getVietnamDateStr();
    let startDate, endDate = today;

    switch (period) {
      case 'today':
        startDate = today;
        break;
      case 'week':
        startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          .toISOString().split('T')[0];
        break;
      case 'month':
        const d = new Date();
        startDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
        break;
      case 'year':
        startDate = `${new Date().getFullYear()}-01-01`;
        break;
      default:
        startDate = today;
    }

    return { startDate, endDate };
  }
}

// ============================================================
// EXPORT
// ============================================================
module.exports = {
  SaleService: new SaleService(),
  InventoryService: new InventoryService(),
  DebtService: new DebtService(),
  PromotionService: new PromotionService(),
  AnalyticsService: new AnalyticsService()
};
