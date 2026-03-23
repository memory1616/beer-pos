const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');

// Sanitize input to prevent XSS — encode HTML entities
function sanitizeInput(input) {
  if (typeof input === 'string') {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .trim();
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
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    const currentMonthStr = currentMonth.toString().padStart(2, '0');
    
    const customers = db.prepare(`
      SELECT c.*, COALESCE(cm.monthly_kegs, 0) as monthly_liters
      FROM customers c
      LEFT JOIN (
        SELECT customer_id, COALESCE(SUM(si.quantity), 0) as monthly_kegs
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        WHERE s.type = 'sale' AND strftime('%Y', s.date) = ? AND strftime('%m', s.date) = ?
        GROUP BY customer_id
      ) cm ON cm.customer_id = c.id
      WHERE c.archived = 0
      ORDER BY c.name
    `).all(currentYear.toString(), currentMonthStr);
    
    res.json(customers);
  } catch (err) {
    logger.error('Error fetching customers', { error: err.message });
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
    logger.error('Error fetching customer', { error: err.message });
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
    logger.error('Error creating customer', { error: err.message });
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

  const { name, phone, deposit, lat, lng, keg_balance, debt, address, note, horizontal_fridge, vertical_fridge, exclude_expected } = req.body;

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
    exclude_expected:  exclude_expected !== undefined ? exclude_expected : existing.exclude_expected,
  };

  // Calculate fridge difference
  const oldHorizontal = existing.horizontal_fridge || 0;
  const newHorizontal = updated.horizontal_fridge || 0;
  const oldVertical = existing.vertical_fridge || 0;
  const newVertical = updated.vertical_fridge || 0;

  const horizontalDiff = newHorizontal - oldHorizontal;
  const verticalDiff = newVertical - oldVertical;

  try {
    // Update customer info
    db.prepare(`
      UPDATE customers
      SET name = ?, phone = ?, deposit = ?, lat = ?, lng = ?, keg_balance = ?, debt = ?, address = ?, note = ?, horizontal_fridge = ?, vertical_fridge = ?, exclude_expected = ?, updated_at = CURRENT_TIMESTAMP
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
      updated.exclude_expected,
      id
    );

    // Update devices (fridges) - assign or release based on difference
    const now = new Date().toISOString();
    
    // Handle horizontal fridge (tủ nằm)
    if (horizontalDiff > 0) {
      // Need to assign more devices: find available horizontal devices
      const availableDevices = db.prepare(`
        SELECT id FROM devices 
        WHERE type = 'horizontal' AND status = 'available' 
        LIMIT ?
      `).all(horizontalDiff);
      
      for (const device of availableDevices) {
        db.prepare(`
          UPDATE devices SET status = 'in_use', customer_id = ?, assigned_date = ? WHERE id = ?
        `).run(id, now, device.id);
      }
    } else if (horizontalDiff < 0) {
      // Release devices: find devices assigned to this customer
      const assignedDevices = db.prepare(`
        SELECT id FROM devices 
        WHERE type = 'horizontal' AND customer_id = ? AND status = 'in_use'
        LIMIT ?
      `).all(id, Math.abs(horizontalDiff));
      
      for (const device of assignedDevices) {
        db.prepare(`
          UPDATE devices SET status = 'available', customer_id = NULL, assigned_date = NULL WHERE id = ?
        `).run(device.id);
      }
    }

    // Handle vertical fridge (tủ đứng)
    if (verticalDiff > 0) {
      const availableDevices = db.prepare(`
        SELECT id FROM devices 
        WHERE type = 'vertical' AND status = 'available' 
        LIMIT ?
      `).all(verticalDiff);
      
      for (const device of availableDevices) {
        db.prepare(`
          UPDATE devices SET status = 'in_use', customer_id = ?, assigned_date = ? WHERE id = ?
        `).run(id, now, device.id);
      }
    } else if (verticalDiff < 0) {
      const assignedDevices = db.prepare(`
        SELECT id FROM devices 
        WHERE type = 'vertical' AND customer_id = ? AND status = 'in_use'
        LIMIT ?
      `).all(id, Math.abs(verticalDiff));
      
      for (const device of assignedDevices) {
        db.prepare(`
          UPDATE devices SET status = 'available', customer_id = NULL, assigned_date = NULL WHERE id = ?
        `).run(device.id);
      }
    }

    res.json({ success: true });
  } catch (err) {
    logger.error('Error updating customer', { error: err.message });
    res.status(500).json({ error: 'Lỗi cập nhật khách hàng' });
  }
});

// PUT /api/customers/:id/archive - Archive/unarchive a customer
router.put('/:id/archive', (req, res) => {
  const id = validateId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'ID không hợp lệ' });
  }

  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Không tìm thấy khách hàng' });
  }

  const archived = existing.archived ? 0 : 1;
  try {
    db.prepare('UPDATE customers SET archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(archived, id);
    res.json({ success: true, archived });
  } catch (err) {
    logger.error('Error archiving customer', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi lưu trữ khách hàng' });
  }
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
      result = db.prepare('UPDATE customers SET lat = ?, lng = ?, address = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(latNum, lngNum, address, customerId);
    } else {
      result = db.prepare('UPDATE customers SET lat = ?, lng = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(latNum, lngNum, customerId);
    }

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Không tìm thấy khách hàng' });
    }

    res.json({ success: true });
  } catch (err) {
    logger.error('Location update error', { error: err.message });
    res.status(500).json({ error: 'Lỗi database: ' + err.message });
  }
});

// POST /api/customer/location - Alias for frontend compatibility
router.post('/customer/location', (req, res) => {
  const { customerId, lat, lng } = req.body;
  if (!customerId || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'Thiếu thông tin' });
  }
    db.prepare('UPDATE customers SET lat = ?, lng = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(lat, lng, customerId);
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

  // Lấy keg_balance trong 1 query duy nhất (thay vì query riêng ở res.json)
  const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(customerId);

  res.json({
    kegBalance: customer ? customer.keg_balance : 0,
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

// GET /api/customer-alerts - Khách dưới mức kỳ vọng bình/tháng
router.get('/alerts', (req, res) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const monthStartStr = `${year}-${month}-01`;

  const monthlyExpectedSetting = db.prepare("SELECT value FROM settings WHERE key = 'monthly_expected'").get();
  const monthlyExpected = monthlyExpectedSetting ? parseFloat(monthlyExpectedSetting.value) : 300;
  const daysElapsed = now.getDate();
  const daysInMonth = new Date(year, now.getMonth() + 1, 0).getDate();
  const expectedUnits = monthlyExpected * daysElapsed / daysInMonth;

  const alerts = db.prepare(`
    SELECT c.id, c.name, c.phone, c.last_order_date,
      COALESCE(mc.monthly_qty, 0) as monthly_qty,
      ROUND(?) - COALESCE(mc.monthly_qty, 0) as shortfall
    FROM customers c
    LEFT JOIN (
      SELECT s.customer_id, SUM(si.quantity) as monthly_qty
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE s.type = 'sale' AND s.date >= ?
      GROUP BY s.customer_id
    ) mc ON mc.customer_id = c.id
    WHERE c.archived = 0
    AND c.exclude_expected = 0
    AND ROUND(?) - COALESCE(mc.monthly_qty, 0) > 0
    ORDER BY shortfall DESC
    LIMIT 10
  `).all(expectedUnits, monthStartStr, expectedUnits);

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
