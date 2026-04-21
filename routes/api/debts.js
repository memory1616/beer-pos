/**
 * BeerPOS - Debt Tracking API v2
 *
 * Sử dụng DebtService làm Single Source of Truth.
 * Tất cả thay đổi công nợ đều qua DebtService.
 */

const express = require('express');
const router = express.Router();

const db = require('../../database');
const { DebtService } = require('../../src/services');
const { cache, cacheKeys } = require('../../src/cache');

// ── In-memory request deduplication (chống double-click) ──────
// Key: requestId → { timer, resolve, reject }
// Dùng: header 'X-Request-Id' từ client, hoặc tạo tự động
const _pending = new Map();
const PENDING_TTL = 10000; // 10s

function _dedup(key, fn) {
  if (_pending.has(key)) {
    return _pending.get(key);
  }
  const p = fn();
  _pending.set(key, p);
  const timer = setTimeout(() => _pending.delete(key), PENDING_TTL);
  p.then(() => clearTimeout(timer)).catch(() => _pending.delete(key));
  return p;
}

// ── Helpers ────────────────────────────────────────────────────

function clearDebtCache(customerId) {
  cache.delete(cacheKeys.CUSTOMERS);
  cache.delete(cacheKeys.CUSTOMER(customerId));
  cache.delete('debts:summary');
}

// ── GET /api/debts ─────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const { hasDebt, overdue, limit, offset } = req.query;

    const filters = {};
    if (hasDebt === '1') filters.hasDebt = true;
    if (overdue === '1') filters.overdue = true;
    if (limit) filters.limit = parseInt(limit);
    if (offset) filters.offset = parseInt(offset);

    const debts = DebtService.getAllDebts(filters);
    const totalDebt = debts.reduce((sum, d) => sum + (d.debt || 0), 0);

    res.json({ success: true, data: debts, summary: { totalDebt, count: debts.length } });
  } catch (e) {
    console.error('Debts API error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/debts/summary ─────────────────────────────────────
router.get('/summary', (req, res) => {
  try {
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

    const topDebts = db.prepare(`
      SELECT id, name, phone, debt, last_order_date
      FROM customers WHERE debt > 0 AND archived = 0
      ORDER BY debt DESC LIMIT 5
    `).all();

    res.json({ success: true, data: { ...summary, topDebts } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/debts/sale/:saleId ────────────────────────────────
// Route phải nằm TRƯỚC /:customerId để tránh conflict
router.get('/sale/:saleId', (req, res) => {
  try {
    const saleId = parseInt(req.params.saleId);
    const data = DebtService.getSalePayments(saleId);

    if (!data) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
    }

    res.json({ success: true, data });
  } catch (e) {
    console.error('Get sale payments error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/debts/:customerId ─────────────────────────────────
router.get('/:customerId', (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId);
    const debtDetail = DebtService.getCustomerDebt(customerId);

    if (!debtDetail) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy khách hàng' });
    }

    res.json({ success: true, data: debtDetail });
  } catch (e) {
    console.error('Debt detail error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/debts/:customerId/history ─────────────────────────
router.get('/:customerId/history', (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId);
    const detail = DebtService.getCustomerDebt(customerId);
    if (!detail) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy khách hàng' });
    }
    res.json({ success: true, data: detail.history || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── GET /api/debts/:customerId/orders ──────────────────────────
// Lấy danh sách đơn nợ của khách
router.get('/:customerId/orders', (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId);
    const detail = DebtService.getCustomerDebt(customerId);
    if (!detail) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy khách hàng' });
    }
    res.json({ success: true, data: detail.orderDebts || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/debts/payment ────────────────────────────────────
// Thanh toán công nợ (idempotent qua X-Request-Id)
router.post('/payment', (req, res) => {
  const requestId = req.headers['x-request-id'] || `${Date.now()}-${Math.random()}`;

  const doPay = () => new Promise((resolve, reject) => {
    try {
      const { customerId, amount, note, saleId } = req.body;

      if (!customerId || !amount) {
        return resolve({ status: 400, body: { success: false, error: 'Thiếu thông tin bắt buộc' } });
      }

      const result = DebtService.payDebt(
        parseInt(customerId),
        parseFloat(amount),
        note || '',
        saleId ? parseInt(saleId) : null
      );

      if (!result.success) {
        return resolve({ status: 400, body: { success: false, error: result.error } });
      }

      clearDebtCache(customerId);

      // Broadcast realtime
      const io = req.app.get('io');
      if (io) {
        io.to('admin').emit('debt:updated', {
          customerId: parseInt(customerId),
          newDebt: result.newDebt,
          paymentId: result.paymentId,
          appliedToSale: result.appliedToSale
        });
      }

      resolve({
        status: 200,
        body: {
          success: true,
          data: {
            paymentId: result.paymentId,
            debtTransactionId: result.debtTransactionId,
            newDebt: result.newDebt,
            appliedAmount: result.appliedAmount,
            appliedToSale: result.appliedToSale
          }
        }
      });
    } catch (e) {
      reject(e);
    }
  });

  _dedup(`pay:${requestId}`, doPay)
    .then(result => res.status(result.status).json(result.body))
    .catch(e => {
      console.error('Add payment error:', e);
      res.status(500).json({ success: false, error: e.message });
    });
});

// ── POST /api/debts/create ─────────────────────────────────────
router.post('/create', (req, res) => {
  try {
    const { customerId, amount, saleId, note } = req.body;

    if (!customerId || !amount) {
      return res.status(400).json({ success: false, error: 'Thiếu thông tin bắt buộc' });
    }

    const result = DebtService.createDebt(
      parseInt(customerId),
      parseFloat(amount),
      saleId ? parseInt(saleId) : null,
      note || ''
    );

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    clearDebtCache(customerId);

    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('debt:updated', {
        customerId: parseInt(customerId),
        newDebt: result.newDebt,
        action: 'increase',
        saleId
      });
    }

    res.json({ success: true, data: result });
  } catch (e) {
    console.error('Create debt error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/debts/adjust ─────────────────────────────────────
// Điều chỉnh công nợ thủ công (admin)
router.post('/adjust', (req, res) => {
  try {
    const { customerId, amount, reason } = req.body;

    if (!customerId) {
      return res.status(400).json({ success: false, error: 'Thiếu customerId' });
    }

    const result = DebtService.adjustDebt(
      parseInt(customerId),
      parseFloat(amount) || 0,
      reason || 'Điều chỉnh thủ công'
    );

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    clearDebtCache(customerId);

    res.json({ success: true, data: { newDebt: result.newDebt } });
  } catch (e) {
    console.error('Adjust debt error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/debts/recalc ─────────────────────────────────────
// Tính lại công nợ từ đầu (verify)
router.post('/recalc', (req, res) => {
  try {
    const { customerId } = req.body;

    if (!customerId) {
      return res.status(400).json({ success: false, error: 'Thiếu customerId' });
    }

    const result = DebtService.recalcDebt(parseInt(customerId));
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('Recalc debt error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── POST /api/debts/reverse-sale ───────────────────────────────
// Hoàn công nợ khi xoá đơn
router.post('/reverse-sale', (req, res) => {
  try {
    const { saleId } = req.body;

    if (!saleId) {
      return res.status(400).json({ success: false, error: 'Thiếu saleId' });
    }

    // Lấy customerId trước
    const sale = db.prepare('SELECT customer_id FROM sales WHERE id = ?').get(saleId);
    if (!sale) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đơn hàng' });
    }

    const result = DebtService.reverseDebtForSale(parseInt(saleId));

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    if (sale.customer_id) {
      clearDebtCache(sale.customer_id);

      const io = req.app.get('io');
      if (io) {
        io.to('admin').emit('debt:updated', {
          customerId: sale.customer_id,
          action: 'reversed',
          saleId: parseInt(saleId),
          refundedAmount: result.refundedAmount
        });
      }
    }

    res.json({ success: true, data: result });
  } catch (e) {
    console.error('Reverse sale debt error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
