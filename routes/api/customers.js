const express = require('express');
const router = express.Router();
const db = require('../../database');

// Sanitize input to prevent XSS
function sanitizeInput(input) {
  if (typeof input === 'string') {
    return input.replace(/[<>'"]/g, '').trim();
  }
  return input;
}

// Validate ID parameter
function validateId(id) {
  const parsed = parseInt(id);
  if (isNaN(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

// GET /api/customers
router.get('/', (req, res) => {
  try {
    const customers = db.prepare('SELECT * FROM customers ORDER BY name').all();
    res.json(customers);
  } catch (err) {
    console.error('Error fetching customers:', err);
    res.status(500).json({ error: 'Lỗi khi lấy danh sách khách hàng' });
  }
});

// GET /api/customers/:id
router.get('/:id', (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'ID không hợp lệ' });
    }
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!customer) return res.status(404).json({ error: 'Không tìm thấy khách hàng' });
    
    res.json(customer);
  } catch (err) {
    console.error('Error fetching customer:', err);
    res.status(500).json({ error: 'Lỗi khi lấy thông tin khách hàng' });
  }
});

// POST /api/customers
router.post('/', (req, res) => {
  const { name, phone, deposit, prices, horizontal_fridge, vertical_fridge } = req.body;

  // Validate required fields
  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'Tên khách hàng là bắt buộc' });
  }

  // Sanitize inputs
  const sanitizedName = sanitizeInput(name);
  const sanitizedPhone = phone ? sanitizeInput(phone) : null;

  try {
    const stmt = db.prepare('INSERT INTO customers (name, phone, deposit, keg_balance, horizontal_fridge, vertical_fridge) VALUES (?, ?, ?, 0, ?, ?)');
    const result = stmt.run(
      sanitizedName, 
      sanitizedPhone, 
      parseFloat(deposit) || 0,
      parseInt(horizontal_fridge) || 0,
      parseInt(vertical_fridge) || 0
    );
    const customerId = result.lastInsertRowid;

    // Save prices if provided
    if (prices && typeof prices === 'object') {
      const insertPrice = db.prepare('INSERT OR REPLACE INTO prices (customer_id, product_id, price) VALUES (?, ?, ?)');
      for (const [productId, price] of Object.entries(prices)) {
        if (price && !isNaN(parseFloat(price))) {
          insertPrice.run(customerId, parseInt(productId), parseFloat(price));
        }
      }
    }

    res.json({ id: customerId, name: sanitizedName, phone: sanitizedPhone, deposit: parseFloat(deposit) || 0, keg_balance: 0 });
  } catch (err) {
    console.error('Error creating customer:', err);
    res.status(500).json({ error: 'Lỗi khi tạo khách hàng: ' + err.message });
  }
});

// PUT /api/customers/:id - Partial update (supports lat/lng only)
router.put('/:id', (req, res) => {
  const id = req.params.id;
  
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Không tìm thấy khách hàng' });
  }

  const { name, phone, deposit, lat, lng, keg_balance, debt, address, note, horizontal_fridge, vertical_fridge } = req.body;

  // Keep existing values if not provided
  const updated = {
    name:             name             ?? existing.name,
    phone:            phone            ?? existing.phone,
    deposit:          deposit          ?? existing.deposit,
    lat:              lat              ?? existing.lat,
    lng:              lng              ?? existing.lng,
    keg_balance:      keg_balance      ?? existing.keg_balance,
    debt:             debt             ?? existing.debt,
    address:          address          ?? existing.address,
    note:             note             ?? existing.note,
    horizontal_fridge: horizontal_fridge ?? existing.horizontal_fridge,
    vertical_fridge:   vertical_fridge  ?? existing.vertical_fridge,
  };

  db.prepare(`
    UPDATE customers
    SET name = ?, phone = ?, deposit = ?, lat = ?, lng = ?, keg_balance = ?, debt = ?, address = ?, note = ?, horizontal_fridge = ?, vertical_fridge = ?
    WHERE id = ?
  `).run(
    updated.name,
    updated.phone,
    updated.deposit,
    updated.lat,
    updated.lng,
    updated.keg_balance,
    updated.debt,
    updated.address,
    updated.note,
    updated.horizontal_fridge,
    updated.vertical_fridge,
    id
  );

  res.json({ success: true });
});

// DELETE /api/customers/:id
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// POST /api/customers/location - Cập nhật tọa độ
router.post('/location', (req, res) => {
  const { customerId, lat, lng, address } = req.body;

  if (!customerId || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'Thiếu thông tin tọa độ' });
  }

  // Validate coordinates
  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (isNaN(latNum) || isNaN(lngNum)) {
    return res.status(400).json({ error: 'Tọa độ không hợp lệ' });
  }

  try {
    let result;
    if (address) {
      result = db.prepare('UPDATE customers SET lat = ?, lng = ?, address = ? WHERE id = ?').run(latNum, lngNum, address, customerId);
    } else {
      result = db.prepare('UPDATE customers SET lat = ?, lng = ? WHERE id = ?').run(latNum, lngNum, customerId);
    }

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Không tìm thấy khách hàng' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[location] Error:', err.message);
    res.status(500).json({ error: 'Lỗi database: ' + err.message });
  }
});

// POST /api/customer/location - Alias for frontend compatibility
router.post('/customer/location', (req, res) => {
  const { customerId, lat, lng } = req.body;
  if (!customerId || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'Thiếu thông tin' });
  }
  db.prepare('UPDATE customers SET lat = ?, lng = ? WHERE id = ?').run(lat, lng, customerId);
  res.json({ success: true });
});

// GET /api/customers/:id/stats - Get customer stats (total revenue, monthly, last sale)
router.get('/:id/stats', (req, res) => {
  const customerId = parseInt(req.params.id);
  const { year, month } = req.query;
  
  const currentYear = year ? parseInt(year) : new Date().getFullYear();
  const currentMonth = month ? parseInt(month) : new Date().getMonth() + 1;
  
  // Tổng doanh thu (chỉ tính type='sale')
  const totalRevenue = db.prepare(`
    SELECT COALESCE(SUM(total), 0) as revenue FROM sales WHERE customer_id = ? AND type = 'sale'
  `).get(customerId).revenue;
  
  // Doanh thu tháng này (chỉ tính type='sale')
  const monthlyRevenue = db.prepare(`
    SELECT COALESCE(SUM(total), 0) as revenue FROM sales 
    WHERE customer_id = ? AND type = 'sale' AND strftime('%Y', date) = ? AND strftime('%m', date) = ?
  `).get(customerId, currentYear.toString(), currentMonth.toString().padStart(2, '0')).revenue;
  
  // Số bình tháng này (chỉ tính type='sale')
  const monthlyKegs = db.prepare(`
    SELECT COALESCE(SUM(si.quantity), 0) as kegs FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    WHERE s.customer_id = ? AND s.type = 'sale' AND strftime('%Y', s.date) = ? AND strftime('%m', s.date) = ?
  `).get(customerId, currentYear.toString(), currentMonth.toString().padStart(2, '0')).kegs;
  
  // Lần giao gần nhất
  const lastSale = db.prepare(`
    SELECT date, julianday('now') - julianday(date) as days_ago FROM sales 
    WHERE customer_id = ? ORDER BY date DESC LIMIT 1
  `).get(customerId);
  
  res.json({
    kegBalance: db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(customerId).keg_balance,
    totalRevenue,
    monthlyRevenue,
    monthlyKegs,
    lastSaleDate: lastSale ? lastSale.date : null,
    lastSaleDaysAgo: lastSale ? Math.floor(lastSale.days_ago) : null
  });
});

// GET /api/customers/:id/sales - Get customer sales history
router.get('/:id/sales', (req, res) => {
  const customerId = parseInt(req.params.id);
  const { year, month } = req.query;
  
  let query = `
    SELECT s.id, s.date, s.total, s.deliver_kegs, s.return_kegs, s.keg_balance_after, s.type,
      COALESCE(SUM(si.quantity), 0) as item_count
    FROM sales s
    LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE s.customer_id = ?
  `;
  
  const params = [customerId];
  
  if (year && month) {
    query += ` AND strftime('%Y-%m', s.date) = ?`;
    params.push(`${year}-${month.padStart(2, '0')}`);
  }
  
  query += ` GROUP BY s.id ORDER BY s.date DESC`;
  
  const sales = db.prepare(query).all(...params);
  
  // Get monthly totals (only type='sale') - use subquery to avoid duplication
  let monthlyTotal = 0;
  let monthlyQty = 0;
  if (year && month) {
    const monthData = db.prepare(`
      SELECT 
        (SELECT COALESCE(SUM(total), 0) FROM sales WHERE customer_id = ? AND type = 'sale' AND strftime('%Y-%m', date) = ?) as total,
        (SELECT COALESCE(SUM(quantity), 0) FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE customer_id = ? AND type = 'sale' AND strftime('%Y-%m', date) = ?)) as qty
    `).get(customerId, `${year}-${month.padStart(2, '0')}`, customerId, `${year}-${month.padStart(2, '0')}`);
    monthlyTotal = monthData.total;
    monthlyQty = monthData.qty;
  }
  
  res.json({ sales, monthlyTotal, monthlyQty });
});

// GET /api/customer-alerts - Get customers who haven't ordered in 7+ days
router.get('/alerts', (req, res) => {
  const alerts = db.prepare(`
    SELECT id, name, phone, last_order_date,
      CAST(julianday('now') - julianday(last_order_date) AS INTEGER) as days
    FROM customers
    WHERE last_order_date IS NOT NULL
    AND julianday('now') - julianday(last_order_date) >= 7
    ORDER BY days DESC
    LIMIT 10
  `).all();
  
  res.json(alerts);
});

// GET /api/customers/:id/keg-history - Get customer keg history
router.get('/:id/keg-history', (req, res) => {
  const customerId = parseInt(req.params.id);
  const { year, month } = req.query;
  
  // Get current keg balance
  const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(customerId);
  const currentBalance = customer ? customer.keg_balance : 0;
  
  // Get keg history
  let query = `
    SELECT date, deliver_kegs, return_kegs, keg_balance_after
    FROM sales
    WHERE customer_id = ?
  `;
  
  const params = [customerId];
  
  if (year && month) {
    query += ` AND strftime('%Y-%m', date) = ?`;
    params.push(`${year}-${month.padStart(2, '0')}`);
  }
  
  query += ` ORDER BY date DESC LIMIT 20`;
  
  const history = db.prepare(query).all(...params);
  
  res.json({ currentBalance, history });
});

// GET /api/customers/:id/debt - Get customer debt history
router.get('/:id/debt', (req, res) => {
  const customerId = parseInt(req.params.id);
  
  // Get current debt (total unpaid)
  const currentDebt = db.prepare(`
    SELECT COALESCE(SUM(total), 0) as debt 
    FROM sales 
    WHERE customer_id = ? AND payment_status = 'unpaid'
  `).get(customerId).debt;
  
  // Get debt transactions (sales and payments)
  const transactions = db.prepare(`
    SELECT s.id, s.date, s.total as amount, s.payment_status, s.keg_balance_after as balance_after,
      CASE WHEN s.payment_status = 'paid' THEN 'payment' ELSE 'debt' END as type,
      CASE WHEN s.payment_status = 'paid' THEN 'Thanh toán' ELSE 'Ghi nợ' END as note
    FROM sales s
    WHERE s.customer_id = ?
    ORDER BY s.date DESC
    LIMIT 30
  `).all(customerId);
  
  res.json({ currentDebt, transactions });
});

module.exports = router;
