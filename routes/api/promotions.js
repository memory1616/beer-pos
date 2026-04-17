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
 */

const express = require('express');
const router = express.Router();

const { PromotionService } = require('../../src/services');
const { cache, cacheKeys } = require('../../src/cache');

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

module.exports = router;
