const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');
const socketServer = require('../../src/socket/socketServer');

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

    // Pagination: ?page=1&limit=5 (default 5 per page)
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 5));
    const offset = (page - 1) * limit;

    // PERFORMANCE: ?fields=id,name,phone reduces payload ~75% for list views
    const { fields } = req.query;
    let customerFields = 'c.*';
    if (fields) {
      const requestedFields = fields.split(',').map(f => f.trim()).filter(Boolean);
      const allowed = ['id','name','phone','address','debt','deposit','keg_balance','lat','lng','last_order_date','archived','monthly_expected','exclude_expected','horizontal_fridge','vertical_fridge','note','updated_at'];
      const valid = requestedFields.filter(f => allowed.includes(f));
      if (valid.length > 0) customerFields = 'c.' + valid.join(', c.');
    }

    // Count total (for pagination)
    const totalResult = db.prepare(`
      SELECT COUNT(*) as total
      FROM customers c
      WHERE c.archived = 0
    `).get();
    const total = totalResult.total;
    const totalPages = Math.ceil(total / limit);

    const customers = db.prepare(`
      SELECT ${customerFields}, COALESCE(cm.monthly_kegs, 0) as monthly_liters
      FROM customers c
      LEFT JOIN (
        SELECT customer_id, COALESCE(SUM(si.quantity), 0) as monthly_kegs
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        WHERE s.type = 'sale' AND s.archived = 0 AND strftime('%Y', s.date) = ? AND strftime('%m', s.date) = ?
        GROUP BY customer_id
      ) cm ON cm.customer_id = c.id
      WHERE c.archived = 0
      ORDER BY c.name
      LIMIT ? OFFSET ?
    `).all(currentYear.toString(), currentMonthStr, limit, offset);

    // If page > 1 and no results, return empty array (not an error)
    res.json({ customers, total, page, totalPages, limit });
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
    
    // PERFORMANCE: ?fields= for single customer detail
    const { fields } = req.query;
    if (fields) {
      const requestedFields = fields.split(',').map(f => f.trim()).filter(Boolean);
      const allowed = ['id','name','phone','address','debt','deposit','keg_balance','lat','lng','last_order_date','archived','monthly_expected','exclude_expected','horizontal_fridge','vertical_fridge','note','updated_at'];
      const valid = requestedFields.filter(f => allowed.includes(f));
      if (valid.length > 0) {
        return res.json(valid.reduce((obj, f) => { obj[f] = customer[f]; return obj; }, {}));
      }
    }

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

    // Assign devices (fridges) to the new customer
    const now = new Date().toISOString();
    const numHorizontal = parseInt(horizontal_fridge) || 0;
    const numVertical = parseInt(vertical_fridge) || 0;

    if (numHorizontal > 0) {
      const available = db.prepare(`SELECT id FROM devices WHERE type = 'horizontal' AND status = 'available' LIMIT ?`).all(numHorizontal);
      for (const device of available) {
        db.prepare(`UPDATE devices SET status = 'in_use', customer_id = ?, assigned_date = ? WHERE id = ?`).run(customerId, now, device.id);
      }
    }
    if (numVertical > 0) {
      const available = db.prepare(`SELECT id FROM devices WHERE type = 'vertical' AND status = 'available' LIMIT ?`).all(numVertical);
      for (const device of available) {
        db.prepare(`UPDATE devices SET status = 'in_use', customer_id = ?, assigned_date = ? WHERE id = ?`).run(customerId, now, device.id);
      }
    }

    // Save prices if provided
    // prices: { productId: price } or { productSlug: price } or both
    if (prices && typeof prices === 'object') {
      const insertPrice = db.prepare('INSERT OR REPLACE INTO prices (customer_id, product_id, product_slug, price) VALUES (?, ?, ?, ?)');
      for (const [key, price] of Object.entries(prices)) {
        if (!price || isNaN(parseFloat(price))) continue;

        // Check if key is numeric (product ID) or string (slug)
        const numKey = parseInt(key);
        let prodId = null;
        let prodSlug = null;

        if (!isNaN(numKey) && numKey > 0) {
          // Numeric key = product ID
          const product = db.prepare('SELECT slug FROM products WHERE id = ?').get(numKey);
          if (product) {
            prodId = numKey;
            prodSlug = product.slug;
          }
        } else {
          // String key = product slug
          const product = db.prepare('SELECT id, slug FROM products WHERE slug = ?').get(key);
          if (product) {
            prodId = product.id;
            prodSlug = product.slug;
          }
        }

        if (prodId) {
          insertPrice.run(customerId, prodId, prodSlug, parseFloat(price));
        }
      }
    }

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    socketServer.emitCustomerUpdated(customer);

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

    const updatedCustomer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    socketServer.emitCustomerUpdated(updatedCustomer);

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

  const willArchive = !existing.archived;
  const archived = willArchive ? 1 : 0;
  const { collectKegs } = req.body;

  let kegsToCollect = 0;
  let kegsLost = 0;

  try {
    if (willArchive && existing.keg_balance > 0) {
      const totalKegs = existing.keg_balance;
      const kegsToCollect = (collectKegs !== undefined && collectKegs !== null)
        ? Math.min(Math.max(0, parseInt(collectKegs)), totalKegs)
        : totalKegs;
      const kegsLost = totalKegs - kegsToCollect;

      // Get current stats BEFORE any updates
      const statsBefore = db.prepare('SELECT inventory, empty_collected, customer_holding, lost FROM keg_stats WHERE id = 1').get();
      const currentEmpty = statsBefore?.empty_collected || 0;
      const currentLost = statsBefore?.lost || 0;
      const currentHolding = statsBefore?.customer_holding || 0;

      if (kegsToCollect > 0) {
        db.prepare('UPDATE keg_stats SET empty_collected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
          .run(currentEmpty + kegsToCollect);
      }

      if (kegsLost > 0) {
        db.prepare('UPDATE keg_stats SET lost = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
          .run(currentLost + kegsLost);
      }

      // Update customer_holding (customer keg_balance becomes 0)
      if (totalKegs > 0) {
        db.prepare('UPDATE keg_stats SET customer_holding = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
          .run(Math.max(0, currentHolding - totalKegs));
      }

      // Calculate AFTER values
      // inventory: không đổi (kegs đã ra khỏi kho từ trước)
      const inventoryAfter = statsBefore?.inventory || 0;
      const emptyAfter = currentEmpty + kegsToCollect;
      const holdingAfter = Math.max(0, currentHolding - totalKegs);
      const lostAfter = currentLost + kegsLost;

      // Log collect transaction
      db.prepare(`
        INSERT INTO keg_transactions_log
          (type, quantity, customer_id, customer_name, inventory_after, empty_after, holding_after, lost_after, note)
        VALUES ('collect', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        kegsToCollect,
        id,
        existing.name,
        inventoryAfter,
        emptyAfter,
        holdingAfter,
        lostAfter,
        `Thu vỏ khi lưu trữ khách (mất ${kegsLost})`
      );

      if (kegsLost > 0) {
        // Log lost transaction with same AFTER values
        db.prepare(`
          INSERT INTO keg_transactions_log
            (type, quantity, customer_id, customer_name, inventory_after, empty_after, holding_after, lost_after, note)
          VALUES ('lost', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          kegsLost,
          id,
          existing.name,
          inventoryAfter,
          emptyAfter,
          holdingAfter,
          lostAfter,
          `Vỏ mất khi lưu trữ khách (${kegsLost} vỏ)`
        );
      }

      logger.info(`[Customer Archive] ${existing.name}: total=${totalKegs}, collected=${kegsToCollect}, lost=${kegsLost}, holdingAfter=${holdingAfter}`);
    }

    if (willArchive) {
      db.prepare('UPDATE customers SET keg_balance = 0, archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(id);
    } else {
      db.prepare('UPDATE customers SET archived = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(id);
    }

    const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    socketServer.emitCustomerUpdated(updated);
    socketServer.emitKegUpdated();

    res.json({
      success: true,
      archived,
      kegsCollected: willArchive ? kegsToCollect : 0,
      kegsLost: willArchive ? kegsLost : 0
    });
  } catch (err) {
    logger.error('Error archiving customer', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Lỗi khi lưu trữ khách hàng' });
  }
});

// DELETE /api/customers/:id
router.delete('/:id', (req, res) => {
  const id = req.params.id;
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  socketServer.emitCustomerUpdated({ id, deleted: true });
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

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    socketServer.emitCustomerUpdated(customer);

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
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  socketServer.emitCustomerUpdated(customer);
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
    SELECT COALESCE(SUM(total), 0) as revenue FROM sales WHERE customer_id = ? AND type = 'sale' AND archived = 0
  `).get(customerId).revenue;
  
  // Doanh thu tháng này (chỉ tính type='sale')
  const monthlyRevenue = db.prepare(`
    SELECT COALESCE(SUM(total), 0) as revenue FROM sales 
    WHERE customer_id = ? AND type = 'sale' AND archived = 0 AND strftime('%Y', date) = ? AND strftime('%m', date) = ?
  `).get(customerId, currentYear.toString(), currentMonth.toString().padStart(2, '0')).revenue;
  
  // Số bình tháng này (chỉ tính type='sale')
  const monthlyKegs = db.prepare(`
    SELECT COALESCE(SUM(si.quantity), 0) as kegs FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    WHERE s.customer_id = ? AND s.type = 'sale' AND s.archived = 0 AND strftime('%Y', s.date) = ? AND strftime('%m', s.date) = ?
  `).get(customerId, currentYear.toString(), currentMonth.toString().padStart(2, '0')).kegs;
  
  // Lần giao gần nhất
  const lastSale = db.prepare(`
    SELECT date, julianday('now') - julianday(date) as days_ago FROM sales
    WHERE customer_id = ? AND archived = 0 ORDER BY date DESC LIMIT 1
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
    WHERE s.customer_id = ? AND s.archived = 0
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
        (SELECT COALESCE(SUM(total), 0) FROM sales WHERE customer_id = ? AND type = 'sale' AND archived = 0 AND strftime('%Y-%m', date) = ?) as total,
        (SELECT COALESCE(SUM(quantity), 0) FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE customer_id = ? AND type = 'sale' AND archived = 0 AND strftime('%Y-%m', date) = ?)) as qty
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
    AND (c.exclude_expected IS NULL OR c.exclude_expected = 0)
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

  // Get current debt from customers table (source of truth)
  const customer = db.prepare(`
    SELECT debt FROM customers WHERE id = ? AND archived = 0
  `).get(customerId);
  const currentDebt = customer ? (customer.debt || 0) : 0;

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
