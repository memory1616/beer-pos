const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');
const { updateCustomerKegBalanceTx } = require('../../src/keg/service');

// ========== HELPER: Update customer keg_balance & sync keg_stats.customer_holding ==========
function updateCustomerKegBalance(customerId, deliverKegs = 0, returnKegs = 0) {
  const custId = parseInt(customerId);
  if (!custId) return false;

  const oldCustomer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(custId);
  if (!oldCustomer) return false;

  const oldBalance = oldCustomer.keg_balance || 0;
  // Luôn tính balance mới từ số dư THỰC TẾ trong DB
  const newBalance = Math.max(0, oldBalance + deliverKegs - returnKegs);
  
  // Update customer
  db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(newBalance, custId);
  
  // Sync keg_stats.customer_holding = sum of all customer keg_balance
  const totalHolding = db.prepare('SELECT COALESCE(SUM(keg_balance), 0) as total FROM customers').get();
  db.prepare('UPDATE keg_stats SET customer_holding = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(totalHolding.total);
  
  return { oldBalance, newBalance, change: newBalance - oldBalance };
}

// Export for other routes
module.exports.updateCustomerKegBalance = updateCustomerKegBalance;

// Validate ID parameter
function validateId(id) {
  const parsed = parseInt(id);
  if (isNaN(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

// Validate payment input
function validatePaymentInput(body) {
  const errors = [];

  if (!body) {
    errors.push('Dữ liệu yêu cầu trống');
    return { valid: false, errors };
  }

  const { customerId, amount } = body;

  const custId = validateId(customerId);
  if (!custId) {
    errors.push('ID khách hàng không hợp lệ');
  }

  const amountValue = parseFloat(amount);
  if (isNaN(amountValue) || amountValue <= 0) {
    errors.push('Số tiền phải lớn hơn 0');
  }

  return { valid: errors.length === 0, errors };
}

// GET /api/payments/debt - Lấy danh sách công nợ
router.get('/debt', (req, res) => {
  try {
    const customers = db.prepare(`
      SELECT
        c.id,
        c.name,
        c.phone,
        c.debt,
        c.deposit,
        c.keg_balance,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE customer_id = c.id) as total_paid,
        (SELECT MAX(date) FROM payments WHERE customer_id = c.id) as last_payment_date,
        (SELECT MAX(date) FROM sales WHERE customer_id = c.id AND type = 'sale') as last_order_date
      FROM customers c
      WHERE (c.debt > 0 OR c.deposit > 0) AND c.archived = 0
      ORDER BY c.debt DESC
    `).all();

    res.json(customers);
  } catch (err) {
    logger.error('Error fetching debt', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi lấy danh sách công nợ' });
  }
});

// GET /api/payments/history - Lịch sử thanh toán
router.get('/history', (req, res) => {
  try {
    const customerId = req.query.customerId;
    const limit = parseInt(req.query.limit) || 20;

    if (customerId) {
      const custId = validateId(customerId);
      if (!custId) {
        return res.status(400).json({ error: 'ID khách hàng không hợp lệ' });
      }

      const payments = db.prepare(`
        SELECT * FROM payments
        WHERE customer_id = ?
        ORDER BY date DESC
        LIMIT ?
      `).all(custId, limit);

      return res.json(payments);
    }

    res.json([]);
  } catch (err) {
    logger.error('Error fetching payment history', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi lấy lịch sử thanh toán' });
  }
});

// POST /api/payments - Thanh toán công nợ
router.post('/', (req, res) => {
  const validation = validatePaymentInput(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.errors.join(', ') });
  }

  try {
    const { customerId, amount, note } = req.body;
    const custId = validateId(customerId);
    const amountValue = parseFloat(amount);

    // Check if customer exists
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(custId);
    if (!customer) {
      return res.status(404).json({ error: 'Không tìm thấy khách hàng' });
    }

    // Insert payment using transaction
    const createPayment = db.transaction(() => {
      // Insert payment record
      db.prepare('INSERT INTO payments (customer_id, amount, note) VALUES (?, ?, ?)').run(
        custId,
        amountValue,
        note || 'Thanh toán công nợ'
      );

      // Update customer debt (reduce debt)
      const newDebt = Math.max(0, (customer.debt || 0) - amountValue);
      db.prepare('UPDATE customers SET debt = ? WHERE id = ?').run(newDebt, custId);

      return newDebt;
    });

    const newDebt = createPayment();

    res.json({
      success: true,
      newDebt: newDebt,
      message: `Đã thanh toán ${amountValue.toLocaleString('vi-VN')} VNĐ`
    });
  } catch (err) {
    logger.error('Payment error', { error: err.message });
    res.status(500).json({ error: 'Thanh toán thất bại: ' + err.message });
  }
});

// POST /api/payments/customer/location - Cập nhật vị trí khách hàng
router.post('/customer/location', (req, res) => {
  const { id, lat, lng, address } = req.body;

  const custId = validateId(id);
  if (!custId) {
    return res.status(400).json({ error: 'ID khách hàng không hợp lệ' });
  }

  if (!lat || !lng) {
    return res.status(400).json({ error: 'Thiếu tọa độ' });
  }

  try {
    // Check if customer exists
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(custId);
    if (!customer) {
      return res.status(404).json({ error: 'Không tìm thấy khách hàng' });
    }

    if (address) {
      db.prepare('UPDATE customers SET lat = ?, lng = ?, address = ? WHERE id = ?').run(lat, lng, address, custId);
    } else {
      db.prepare('UPDATE customers SET lat = ?, lng = ? WHERE id = ?').run(lat, lng, custId);
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('Error updating location', { error: err.message });
    res.status(500).json({ error: 'Cập nhật vị trí thất bại' });
  }
});

// POST /api/payments/keg/update-balance - Cập nhật số bình (thủ công)
router.post('/keg/update-balance', (req, res) => {
  const { customerId, balance, note } = req.body;

  const custId = validateId(customerId);
  if (!custId) {
    return res.status(400).json({ error: 'ID khách hàng không hợp lệ' });
  }

  if (balance === undefined || balance === null || isNaN(parseInt(balance))) {
    return res.status(400).json({ error: 'Số bình không hợp lệ' });
  }

  try {
    // Check if customer exists
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(custId);
    if (!customer) {
      return res.status(404).json({ error: 'Không tìm thấy khách hàng' });
    }

    const oldBalance = customer.keg_balance || 0;
    const newBalance = parseInt(balance);
    const delta = newBalance - oldBalance;

    if (delta !== 0) {
      updateCustomerKegBalanceTx(custId, delta > 0 ? delta : 0, delta < 0 ? Math.abs(delta) : 0, 'adjust', null);
    }

    res.json({ success: true, newBalance, change: delta });
  } catch (err) {
    logger.error('Error updating keg balance', { error: err.message });
    res.status(500).json({ error: 'Cập nhật thất bại' });
  }
});

module.exports = router;
