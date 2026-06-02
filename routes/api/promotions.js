/**
 * BeerPOS - Promotions API
 *
 * API endpoints cho hệ thống khuyến mãi:
 * - GET /api/promotions - Lấy danh sách khuyến mãi
 * - GET /api/promotions/active - Lấy khuyến mãi đang active
 * - POST /api/promotions - Tạo khuyến mãi mới
 * - PUT /api/promotions/:id - Cập nhật khuyến mãi
 * - DELETE /api/promotions/:id - Xóa khuyến mãi
 * - POST /api/promotions/calculate - Tính giảm giá cho đơn hàng
 *
 * PROMOTION SYSTEM v3 (New Shop + Monthly Reward + Admin Settings):
 * - GET /api/promotions/settings - Lấy cấu hình hệ thống khuyến mãi
 * - PUT /api/promotions/settings - Lưu cấu hình hệ thống khuyến mãi
 * - GET /api/promotions/new-shop/check/:customerId - Kiểm tra quán mới
 * - GET /api/promotions/new-shop/calculate - Tính lít tặng quán mới
 * - GET /api/promotions/reward/status/:customerId - Trạng thái thưởng tháng
 * - GET /api/promotions/reward/highest/:customerId - Thưởng cao nhất khả dụng
 * - GET /api/promotions/reward/remaining/:customerId - Thưởng còn lại
 * - POST /api/promotions/reward/claim - Nhận thưởng tháng
 * - POST /api/promotions/reward/claim-highest - Nhận thưởng cao nhất
 * - GET /api/promotions/reward/history/:customerId - Lịch sử thưởng
 * - GET /api/promotions/dashboard/stats - Stats dashboard khuyến mãi
 * - GET /api/promotions/near-tier - Khách gần đạt mốc
 * - GET /api/promotions/customer/:customerId/overview - Tổng quan khuyến mãi của 1 khách
 */

const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');
const { PromotionService } = require('../../src/services');
const { cache, cacheKeys } = require('../../src/cache');
const socketServer = require('../../src/socket/socketServer');

/**
 * GET /api/promotions
 * Lấy tất cả khuyến mãi
 */
router.get('/', (req, res) => {
  try {
    const { active } = req.query;

    let sql = 'SELECT * FROM promotions';
    const params = [];

    if (active === '1') {
      const today = db.getVietnamDateStr();
      sql += ' WHERE active = 1 AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?)';
      params.push(today, today);
    }

    sql += ' ORDER BY priority DESC, created_at DESC';

    const promotions = db.prepare(sql).all(...params);

    res.json({
      success: true,
      data: promotions
    });
  } catch (e) {
    console.error('Promotions API error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/promotions/active
 * Lấy khuyến mãi đang active (dùng cho POS)
 */
router.get('/active', (req, res) => {
  try {
    const promotions = PromotionService.getActivePromotions();

    res.json({
      success: true,
      data: promotions
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/promotions/products
 * Lấy danh sách sản phẩm bia để xuất thưởng (chỉ keg, có tồn kho)
 */
router.get('/products', (req, res) => {
  try {
    const products = db.prepare(`
      SELECT id, name, slug, type, stock
      FROM products
      WHERE archived = 0 AND type = 'keg' AND stock > 0
      ORDER BY name
    `).all();
    res.json({ success: true, data: products });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


/**
 * GET /api/promotions/settings
 * Lấy cấu hình hệ thống khuyến mãi
 */
router.get('/settings', (req, res) => {
  try {
    const settings = PromotionService.getSystemPromotionSettings();
    res.json({ success: true, data: settings });
  } catch (e) {
    logger.error('get settings error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * PUT /api/promotions/settings
 * Lưu cấu hình hệ thống khuyến mãi
 * Body: { newShopEnabled, newShopDays, newShopGoldBuy, newShopGoldFree, newShopBlackBuy, newShopBlackFree, rewardEnabled, rewardTiers }
 */
router.put('/settings', (req, res) => {
  try {
    const {
      newShopEnabled,
      newShopDays,
      newShopGoldBuy,
      newShopGoldFree,
      newShopBlackBuy,
      newShopBlackFree,
      rewardEnabled,
      rewardTiers
    } = req.body;

    // Validate rewardTiers
    let parsedTiers = null;
    if (rewardTiers !== undefined) {
      if (typeof rewardTiers === 'string') {
        try { parsedTiers = JSON.parse(rewardTiers); } catch (_) { parsedTiers = null; }
      } else {
        parsedTiers = rewardTiers;
      }
    }

    const settings = PromotionService.saveSystemPromotionSettings({
      newShopEnabled: newShopEnabled !== undefined ? !!newShopEnabled : undefined,
      newShopDays: newShopDays !== undefined ? parseInt(newShopDays) || 30 : undefined,
      newShopGoldBuy: newShopGoldBuy !== undefined ? parseInt(newShopGoldBuy) || 10 : undefined,
      newShopGoldFree: newShopGoldFree !== undefined ? parseInt(newShopGoldFree) || 1 : undefined,
      newShopBlackBuy: newShopBlackBuy !== undefined ? parseInt(newShopBlackBuy) || 20 : undefined,
      newShopBlackFree: newShopBlackFree !== undefined ? parseInt(newShopBlackFree) || 1 : undefined,
      rewardEnabled: rewardEnabled !== undefined ? !!rewardEnabled : undefined,
      rewardTiers: parsedTiers || undefined
    });

    // Emit realtime update to all clients
    try {
      socketServer.forceRefetch(['promotion_settings', 'promotion']);
    } catch (_) {}

    logger.info('[PROMOTION] Settings updated', {
      newShopEnabled, newShopDays, newShopGoldBuy, newShopGoldFree,
      newShopBlackBuy, newShopBlackFree, rewardEnabled, rewardTiers: parsedTiers
    });

    res.json({ success: true, data: settings, message: 'Đã lưu cài đặt khuyến mãi!' });
  } catch (e) {
    logger.error('save settings error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/promotions/:id
 * Lấy chi tiết 1 khuyến mãi
 */
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;

    const promo = db.prepare('SELECT * FROM promotions WHERE id = ?').get(id);

    if (!promo) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy khuyến mãi' });
    }

    res.json({
      success: true,
      data: promo
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/promotions
 * Tạo khuyến mãi mới
 */
router.post('/', (req, res) => {
  try {
    const result = PromotionService.create(req.body);

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Invalidate cache
    cache.delete(cacheKeys.PROMOTIONS);

    res.json({
      success: true,
      data: { promotionId: result.promotionId }
    });
  } catch (e) {
    console.error('Create promotion error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * PUT /api/promotions/:id
 * Cập nhật khuyến mãi
 */
router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, description, type, value, min_order_value, max_discount,
      customer_tier, customer_segments, product_id, buy_quantity, get_quantity,
      active, start_date, end_date, priority
    } = req.body;

    const existing = db.prepare('SELECT * FROM promotions WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy khuyến mãi' });
    }

    db.prepare(`
      UPDATE promotions SET
        name = ?,
        description = ?,
        type = ?,
        value = ?,
        min_order_value = ?,
        max_discount = ?,
        customer_tier = ?,
        customer_segments = ?,
        product_id = ?,
        buy_quantity = ?,
        get_quantity = ?,
        active = ?,
        start_date = ?,
        end_date = ?,
        priority = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name, description, type, value || 0, min_order_value || null,
      max_discount || null, customer_tier || null,
      customer_segments ? JSON.stringify(customer_segments) : null,
      product_id || null, buy_quantity || null, get_quantity || null,
      active !== undefined ? (active ? 1 : 0) : 1,
      start_date || null, end_date || null, priority || 0,
      id
    );

    // Invalidate cache
    cache.delete(cacheKeys.PROMOTIONS);

    res.json({
      success: true,
      message: 'Đã cập nhật khuyến mãi'
    });
  } catch (e) {
    console.error('Update promotion error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * DELETE /api/promotions/:id
 * Xóa khuyến mãi
 */
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;

    const existing = db.prepare('SELECT * FROM promotions WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy khuyến mãi' });
    }

    db.prepare('DELETE FROM promotions WHERE id = ?').run(id);

    // Invalidate cache
    cache.delete(cacheKeys.PROMOTIONS);

    res.json({
      success: true,
      message: 'Đã xóa khuyến mãi'
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/promotions/calculate
 * Tính giảm giá cho đơn hàng
 *
 * Body: {
 *   customerId: number,
 *   items: [{ productId, quantity }],
 *   subtotal: number
 * }
 */
router.post('/calculate', (req, res) => {
  try {
    const { customerId, items, subtotal } = req.body;

    if (!subtotal) {
      return res.status(400).json({ success: false, error: 'Thiếu subtotal' });
    }

    const cart = {
      customerId: customerId ? parseInt(customerId) : null,
      items: items || [],
      subtotal: parseFloat(subtotal)
    };

    const result = PromotionService.calculateDiscount(cart);

    res.json({
      success: true,
      data: result
    });
  } catch (e) {
    console.error('Calculate discount error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/segments
 * Lấy danh sách phân khúc khách hàng
 */
router.get('/segments/list', (req, res) => {
  try {
    const segments = db.prepare(`
      SELECT * FROM customer_segments WHERE active = 1 ORDER BY name
    `).all();

    res.json({
      success: true,
      data: segments
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/segments
 * Tạo phân khúc mới
 */
router.post('/segments', (req, res) => {
  try {
    const { name, code, color, icon, rules, discount_percent } = req.body;

    const result = db.prepare(`
      INSERT INTO customer_segments (name, code, color, icon, rules, discount_percent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      name, code, color || '#3B82F6', icon || '👥',
      rules ? JSON.stringify(rules) : null,
      discount_percent || 0
    );

    res.json({
      success: true,
      data: { segmentId: result.lastInsertRowid }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// PROMOTION SYSTEM v2: NEW SHOP + MONTHLY REWARD
// ============================================================

/**
 * GET /api/promotions/new-shop/check/:customerId
 * Kiểm tra khách hàng có phải "quán mới" không
 */
router.get('/new-shop/check/:customerId', (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (!customerId) return res.status(400).json({ success: false, error: 'ID không hợp lệ' });

    const result = PromotionService.isNewShopEligible(customerId);
    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('new-shop check error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/promotions/new-shop/calculate?gold=25&black=45
 * Tính lít được tặng cho quán mới
 */
router.get('/new-shop/calculate', (req, res) => {
  try {
    const gold = parseInt(req.query.gold) || 0;
    const black = parseInt(req.query.black) || 0;

    const result = PromotionService.calculateNewShopPromotion(gold, black);
    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('new-shop calculate error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/promotions/reward/status/:customerId
 * Lấy trạng thái thưởng tháng của khách
 */
router.get('/reward/status/:customerId', (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (!customerId) return res.status(400).json({ success: false, error: 'ID không hợp lệ' });

    const status = PromotionService.getRewardStatus(customerId);
    if (!status) return res.status(404).json({ success: false, error: 'Không tìm thấy khách hàng' });

    res.json({ success: true, data: status });
  } catch (e) {
    logger.error('reward status error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/promotions/reward/claim
 * Nhận thưởng tháng
 * Body: { customerId, productId }
 */
router.post('/reward/claim', (req, res) => {
  try {
    const { customerId, productId } = req.body;

    if (!customerId) return res.status(400).json({ success: false, error: 'Thiếu customerId' });
    if (!productId) return res.status(400).json({ success: false, error: 'Thiếu productId (sản phẩm để xuất thưởng)' });

    const result = PromotionService.claimMonthlyReward(parseInt(customerId), parseInt(productId));

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    // Emit events để refresh realtime
    try {
      socketServer.emitInventoryUpdated();
      socketServer.emitReportUpdated({ reason: 'reward_claimed', customerId: parseInt(customerId) });
    } catch (_) {}

    res.json({
      success: true,
      data: {
        saleId: result.saleId,
        rewardLiters: result.rewardLiters,
        tier: result.tier,
        message: `Đã xuất thưởng ${result.rewardLiters}L cho khách hàng!`
      }
    });
  } catch (e) {
    logger.error('claim reward error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/promotions/reward/history/:customerId
 * Lấy lịch sử nhận thưởng
 */
router.get('/reward/history/:customerId', (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (!customerId) return res.status(400).json({ success: false, error: 'ID không hợp lệ' });

    const history = PromotionService.getRewardHistory(customerId);
    res.json({ success: true, data: history });
  } catch (e) {
    logger.error('reward history error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/promotions/dashboard/stats
 * Stats dashboard khuyến mãi
 */
router.get('/dashboard/stats', (req, res) => {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const activeNewShops = PromotionService.getActiveNewShopCount();
    const nearTier = PromotionService.getNearRewardCustomers(10);
    const rewardSummary = PromotionService.getMonthlyRewardSummary(year, month);

    // Tổng lít khuyến mãi quán mới trong tháng
    const newShopPromoSummary = db.prepare(`
      SELECT COALESCE(SUM(promo_free_liters), 0) as total_free_liters
      FROM sales
      WHERE promo_type = 'NEW_SHOP'
        AND strftime('%Y', date) = ?
        AND strftime('%m', date) = ?
    `).get(String(year), String(month).padStart(2, '0'));

    res.json({
      success: true,
      data: {
        activeNewShops,
        monthlyRewardClaims: rewardSummary.total_claims,
        monthlyRewardLiters: rewardSummary.total_liters,
        monthlyNewShopFreeLiters: newShopPromoSummary ? newShopPromoSummary.total_free_liters : 0,
        nearTierCustomers: nearTier
      }
    });
  } catch (e) {
    logger.error('promotion dashboard stats error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/promotions/near-tier
 * Danh sách khách gần đạt mốc thưởng
 */
router.get('/near-tier', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const customers = PromotionService.getNearRewardCustomers(limit);
    res.json({ success: true, data: customers });
  } catch (e) {
    logger.error('near-tier error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ================================================================
// PROMOTION SYSTEM v3: ADMIN SETTINGS
// ================================================================





/**
 * GET /api/promotions/reward/highest/:customerId
 * Lấy thưởng cao nhất khách có thể nhận (tier hiện tại - đã nhận)
 */
router.get('/reward/highest/:customerId', (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (!customerId) return res.status(400).json({ success: false, error: 'ID không hợp lệ' });

    const result = PromotionService.getHighestEligibleReward(customerId);
    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('reward highest error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/promotions/reward/remaining/:customerId
 * Lấy số lít thưởng còn lại khách có thể nhận
 */
router.get('/reward/remaining/:customerId', (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (!customerId) return res.status(400).json({ success: false, error: 'ID không hợp lệ' });

    const remaining = PromotionService.getRemainingReward(customerId);
    res.json({ success: true, data: { remaining } });
  } catch (e) {
    logger.error('reward remaining error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/promotions/reward/claim-highest
 * Nhận thưởng cao nhất (tự động tính remaining reward)
 * Body: { customerId, productId }
 */
router.post('/reward/claim-highest', (req, res) => {
  try {
    const { customerId, productId } = req.body;
    if (!customerId) return res.status(400).json({ success: false, error: 'Thiếu customerId' });
    if (!productId) return res.status(400).json({ success: false, error: 'Thiếu productId' });

    const result = PromotionService.claimHighestReward(parseInt(customerId), parseInt(productId));

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    // Emit events
    try {
      socketServer.emitInventoryUpdated();
      socketServer.emitReportUpdated({ reason: 'reward_claimed', customerId: parseInt(customerId) });
      socketServer.emitCustomerUpdated({ id: parseInt(customerId) });
    } catch (_) {}

    res.json({
      success: true,
      data: {
        saleId: result.saleId,
        rewardLiters: result.rewardLiters,
        tier: result.tier,
        message: `Đã xuất thưởng ${result.rewardLiters}L!`
      }
    });
  } catch (e) {
    logger.error('claim highest reward error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/promotions/customer/:customerId/overview
 * Tổng quan khuyến mãi của 1 khách (quán mới + thưởng tháng)
 * Dùng cho POS khi chọn khách
 */
router.get('/customer/:customerId/overview', (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId);
    if (!customerId) return res.status(400).json({ success: false, error: 'ID không hợp lệ' });

    const customer = db.prepare('SELECT id, name, promotion_enabled, created_at FROM customers WHERE id = ?').get(customerId);
    if (!customer) return res.status(404).json({ success: false, error: 'Không tìm thấy khách hàng' });

    const settings = PromotionService.getSystemPromotionSettings();

    let newShopInfo = null;
    let isInNewShopPeriod = false;
    if (customer.promotion_enabled !== 0) {
      newShopInfo = PromotionService.isNewShopEligible(customerId);
      isInNewShopPeriod = PromotionService.isInNewShopPeriod(customerId);
    }

    let rewardInfo = null;
    let canReceiveReward = false;
    if (customer.promotion_enabled !== 0) {
      rewardInfo = PromotionService.calculateMonthlyReward(customerId);
      // Khách chỉ có thể nhận thưởng tháng nếu KHÔNG đang trong thời gian quán mới
      canReceiveReward = !isInNewShopPeriod && settings.rewardEnabled;
    }

    res.json({
      success: true,
      data: {
        customerId,
        customerName: customer.name,
        promotionEnabled: customer.promotion_enabled !== 0,
        systemNewShopEnabled: settings.newShopEnabled,
        systemRewardEnabled: settings.rewardEnabled,
        isInNewShopPeriod,
        canReceiveReward,
        newShop: newShopInfo,
        monthlyReward: rewardInfo
      }
    });
  } catch (e) {
    logger.error('customer overview error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * PUT /api/customers/:id/promotion
 * Bật/tắt khuyến mãi cho khách
 * Body: { enabled: boolean }
 */
router.put('/customer/:id/promotion', (req, res) => {
  try {
    const customerId = parseInt(req.params.id);
    if (!customerId) return res.status(400).json({ success: false, error: 'ID không hợp lệ' });

    const { enabled } = req.body;
    const promotionEnabled = enabled ? 1 : 0;

    const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId);
    if (!customer) return res.status(404).json({ success: false, error: 'Không tìm thấy khách hàng' });

    db.prepare('UPDATE customers SET promotion_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(promotionEnabled, customerId);

    // Emit realtime update
    try {
      socketServer.emitCustomerUpdated({ id: customerId, promotion_enabled: promotionEnabled });
    } catch (_) {}

    logger.info(`[PROMOTION] Customer ${customerId} promotion_enabled set to ${promotionEnabled}`);

    res.json({
      success: true,
      message: enabled ? 'Đã bật khuyến mãi cho khách' : 'Đã tắt khuyến mãi cho khách'
    });
  } catch (e) {
    try { logger.error('update customer promotion error:', e); } catch (_) {}
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
