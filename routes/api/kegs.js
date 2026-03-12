const express = require('express');
const router = express.Router();
const db = require('../../database');

// POST /api/kegs - Trả vỏ (giảm số bình)
router.post('/', (req, res) => {
  const { customerId, quantity, note } = req.body;
  if (!customerId || !quantity || quantity < 1) {
    return res.status(400).json({ error: 'Invalid data' });
  }
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (customer.keg_balance < quantity) {
    return res.status(400).json({ error: 'Not enough kegs' });
  }
  db.prepare('UPDATE customers SET keg_balance = keg_balance - ? WHERE id = ?').run(quantity, customerId);
  db.prepare('INSERT INTO keg_log (customer_id, change, note) VALUES (?, ?, ?)').run(customerId, -quantity, note || 'Return');
  db.prepare('INSERT INTO keg_transactions (customer_id, type, quantity, note) VALUES (?, ?, ?, ?)').run(customerId, 'return', quantity, note || 'Thu vỏ');
  res.json({ success: true });
});

// POST /api/kegs/return - Thu vỏ mới
router.post('/return', (req, res) => {
  const { customerId, quantity, note } = req.body;
  if (!customerId || !quantity || quantity < 1) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  }
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) return res.status(404).json({ error: 'Khách hàng không tồn tại' });
  
  db.prepare('UPDATE customers SET keg_balance = keg_balance - ? WHERE id = ?').run(quantity, customerId);
  db.prepare('INSERT INTO keg_transactions (customer_id, type, quantity, note) VALUES (?, ?, ?, ?)').run(customerId, 'return', quantity, note || 'Thu vỏ');
  db.prepare('INSERT INTO keg_log (customer_id, change, note) VALUES (?, ?, ?)').run(customerId, -quantity, note || 'Thu vỏ');
  
  res.json({ success: true, message: 'Thu vỏ thành công' });
});

// POST /api/kegs/delivery - Giao vỏ
router.post('/delivery', (req, res) => {
  const { customerId, quantity, note } = req.body;
  if (!customerId || !quantity || quantity < 1) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  }
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) return res.status(404).json({ error: 'Khách hàng không tồn tại' });
  
  db.prepare('UPDATE customers SET keg_balance = keg_balance + ? WHERE id = ?').run(quantity, customerId);
  db.prepare('INSERT INTO keg_transactions (customer_id, type, quantity, note) VALUES (?, ?, ?, ?)').run(customerId, 'delivery', quantity, note || 'Giao vỏ');
  db.prepare('INSERT INTO keg_log (customer_id, change, note) VALUES (?, ?, ?)').run(customerId, quantity, note || 'Giao vỏ');
  
  res.json({ success: true, message: 'Giao vỏ thành công' });
});

// GET /api/kegs/history - Lịch sử vỏ
router.get('/history', (req, res) => {
  const history = db.prepare(`
    SELECT k.*, c.name as customer_name
    FROM keg_transactions k
    JOIN customers c ON c.id = k.customer_id
    ORDER BY k.date DESC
    LIMIT 100
  `).all();
  res.json(history);
});

// GET /api/kegs/stats - Thống kê vỏ
router.get('/stats', (req, res) => {
  const totalAtCustomers = db.prepare('SELECT COALESCE(SUM(keg_balance), 0) as total FROM customers').get();
  const customerCount = db.prepare('SELECT COUNT(*) as count FROM customers WHERE keg_balance > 0').get();
  const recentTransactions = db.prepare(`
    SELECT COUNT(*) as count FROM keg_transactions 
    WHERE date >= datetime('now', '-7 days')
  `).get();
  
  res.json({
    totalAtCustomers: totalAtCustomers.total,
    customerCount: customerCount.count,
    recentWeek: recentTransactions.count
  });
});

module.exports = router;
