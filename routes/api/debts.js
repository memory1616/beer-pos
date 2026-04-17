/**
 * BeerPOS - Debt Tracking API
 *
 * API endpoints cho hệ thống công nợ:
 * - GET /api/debts - Lấy danh sách công nợ
 * - GET /api/debts/:customerId - Lấy chi tiết công nợ 1 khách
 * - POST /api/debts/payment - Thêm thanh toán
 * - POST /api/debts/create - Tạo công nợ mới
 * - GET /api/debts/history/:customerId - Lịch sử công nợ
 */

const express = require('express');
const router = express.Router();

const { DebtService } = require('../../src/services');
const { cache, cacheKeys } = require('../../src/cache');

/**
 * GET /api/debts
 * Lấy danh sách công nợ tất cả khách hàng
 *
 * Query params:
 * - hasDebt: 1 - chỉ khách có nợ
 * - overdue: 1 - khách quá hạn (30 ngày không mua)
 * - limit: số lượng
 */
router.get('/', (req, res) => {
  try {
    const { hasDebt, overdue, limit } = req.query;

    const filters = {};
    if (hasDebt === '1') filters.hasDebt = true;
    if (overdue === '1') filters.overdue = true;
    if (limit) filters.limit = parseInt(limit);

    const debts = DebtService.getAllDebts(filters);

    // Summary stats
    const totalDebt = debts.reduce((sum, d) => sum + (d.debt || 0), 0);
    const totalDeposit = debts.reduce((sum, d) => sum + (d.deposit || 0), 0);

    res.json({
      success: true,
      data: debts,
      summary: {
        totalDebt,
        totalDeposit,
        customerCount: debts.length,
        overdueCount: debts.filter(d => {
          if (!d.last_order_date || d.debt <= 0) return false;
          const lastOrder = new Date(d.last_order_date);
          const daysSince = (Date.now() - lastOrder.getTime()) / (1000 * 60 * 60 * 24);
          return daysSince > 30;
        }).length
      }
    });
  } catch (e) {
    console.error('Debts API error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/debts/summary
 * Dashboard summary về công nợ
 */
router.get('/summary', (req, res) => {
  try {
    const today = db.getVietnamDateStr();
    const monthStart = new Date();
    monthStart.setDate(1);
    const monthStartStr = monthStart.toISOString().split('T')[0];

    const summary = db.prepare(`
      SELECT
        (SELECT COALESCE(SUM(debt), 0) FROM customers WHERE archived = 0) as total_debt,
        (SELECT COALESCE(SUM(deposit), 0) FROM customers WHERE archived = 0) as total_deposit,
        (SELECT COUNT(*) FROM customers WHERE debt > 0 AND archived = 0) as debt_customers,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE date >= ?) as payments_this_month
    `).get(monthStartStr);

    // Top 5 khách nợ nhiều nhất
    const topDebts = db.prepare(`
      SELECT id, name, phone, debt, last_order_date
      FROM customers
      WHERE debt > 0 AND archived = 0
      ORDER BY debt DESC
      LIMIT 5
    `).all();

    res.json({
      success: true,
      data: {
        ...summary,
        topDebts
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/debts/:customerId
 * Lấy chi tiết công nợ của 1 khách hàng
 */
router.get('/:customerId', (req, res) => {
  try {
    const { customerId } = req.params;

    const debtDetail = DebtService.getCustomerDebt(parseInt(customerId));

    if (!debtDetail) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy khách hàng' });
    }

    // Invalidate cache
    cache.delete(cacheKeys.CUSTOMER(customerId));

    res.json({
      success: true,
      data: debtDetail
    });
  } catch (e) {
    console.error('Debt detail error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/debts/:customerId/history
 * Lấy lịch sử giao dịch công nợ
 */
router.get('/:customerId/history', (req, res) => {
  try {
    const { customerId } = req.params;

    const history = db.prepare(`
      SELECT
        'payment' as type,
        p.id,
        p.amount,
        p.date,
        p.note,
        NULL as sale_id,
        NULL as sale_total
      FROM payments p
      WHERE p.customer_id = ?

      UNION ALL

      SELECT
        'sale' as type,
        NULL as id,
        0 as amount,
        s.date,
        s.note,
        s.id as sale_id,
        s.total as sale_total
      FROM sales s
      WHERE s.customer_id = ? AND s.type = 'sale'

      ORDER BY date DESC
      LIMIT 100
    `).all(customerId, customerId);

    res.json({
      success: true,
      data: history
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/debts/payment
 * Thêm thanh toán công nợ
 *
 * Body: { customerId, amount, note }
 */
router.post('/payment', (req, res) => {
  try {
    const { customerId, amount, note } = req.body;

    if (!customerId || !amount) {
      return res.status(400).json({ success: false, error: 'Thiếu thông tin bắt buộc' });
    }

    const result = DebtService.addPayment({
      customerId: parseInt(customerId),
      amount: parseFloat(amount),
      note
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Invalidate caches
    cache.delete(cacheKeys.CUSTOMERS);
    cache.delete(cacheKeys.CUSTOMER(customerId));

    res.json({
      success: true,
      data: {
        paymentId: result.paymentId,
        newDebt: result.newDebt
      }
    });
  } catch (e) {
    console.error('Add payment error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/debts/create
 * Tạo công nợ mới (khi bán chịu)
 *
 * Body: { customerId, amount, saleId, note }
 */
router.post('/create', (req, res) => {
  try {
    const { customerId, amount, saleId, note } = req.body;

    if (!customerId || !amount) {
      return res.status(400).json({ success: false, error: 'Thiếu thông tin bắt buộc' });
    }

    const result = DebtService.createDebt({
      customerId: parseInt(customerId),
      amount: parseFloat(amount),
      saleId: saleId ? parseInt(saleId) : null,
      note
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Log debt transaction
    db.prepare(`
      INSERT INTO debt_transactions (customer_id, type, amount, balance_before, balance_after, sale_id, note)
      SELECT
        c.id,
        'increase',
        ?,
        COALESCE(c.debt, 0) - ?,
        COALESCE(c.debt, 0),
        ?,
        ?
      FROM customers c WHERE c.id = ?
    `).run(amount, amount, saleId, note, customerId);

    // Invalidate caches
    cache.delete(cacheKeys.CUSTOMERS);
    cache.delete(cacheKeys.CUSTOMER(customerId));

    res.json({
      success: true,
      message: 'Đã tạo công nợ'
    });
  } catch (e) {
    console.error('Create debt error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
