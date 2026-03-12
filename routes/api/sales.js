const express = require('express');
const router = express.Router();
const db = require('../../database');

// Helper function to validate sale input
function validateSaleInput(body) {
  const errors = [];

  if (!body) {
    errors.push('Dữ liệu yêu cầu trống');
    return { valid: false, errors };
  }

  const { customerId, items } = body;

  // Validate items
  if (!items) {
    errors.push('Danh sách sản phẩm trống');
  } else if (!Array.isArray(items)) {
    errors.push('Danh sách sản phẩm phải là mảng');
  } else if (items.length === 0) {
    errors.push('Danh sách sản phẩm trống');
  } else {
    // Validate each item
    items.forEach((item, index) => {
      if (!item.productId) {
        errors.push(`Sản phẩm thứ ${index + 1}: Thiếu mã sản phẩm`);
      }
      if (!item.quantity || item.quantity <= 0) {
        errors.push(`Sản phẩm thứ ${index + 1}: Số lượng phải lớn hơn 0`);
      }
      if (item.price !== undefined && item.price < 0) {
        errors.push(`Sản phẩm thứ ${index + 1}: Giá không được âm`);
      }
    });
  }

  // Validate kegs (optional)
  if (body.deliverKegs !== undefined && body.deliverKegs < 0) {
    errors.push('Số vỏ giao không được âm');
  }
  if (body.returnKegs !== undefined && body.returnKegs < 0) {
    errors.push('Số vỏ trả không được âm');
  }

  return { valid: errors.length === 0, errors };
}

// POST /api/sales - Tạo hóa đơn mới (với transaction)
router.post('/', (req, res) => {
  const { customerId, items, deliverKegs = 0, returnKegs = 0 } = req.body;

  // Validate input
  const validation = validateSaleInput(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.errors.join(', ') });
  }

  try {
    let total = 0;
    let profit = 0;
    const saleItems = [];

    // Get customer's current keg balance (if customerId is provided)
    let currentKegBalance = 0;
    let newKegBalance = 0;
    
    if (customerId) {
      const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(customerId);
      currentKegBalance = customer ? customer.keg_balance : 0;
      newKegBalance = currentKegBalance + deliverKegs - returnKegs;
    }

    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
      if (!product) return res.status(400).json({ error: 'Product not found: ' + item.productId });
      if (product.stock < item.quantity) {
        return res.status(400).json({ error: 'Insufficient stock: ' + product.name });
      }

      // Use provided price or fallback to sell_price
      let price = item.price || product.sell_price || 0;
      
      // If customer has custom price, use that instead
      if (customerId) {
        const priceRecord = db.prepare('SELECT * FROM prices WHERE customer_id = ? AND product_id = ?').get(customerId, item.productId);
        if (priceRecord) {
          price = priceRecord.price;
        }
      }
      
      const costPrice = product.cost_price || 0;
      const itemProfit = (price - costPrice) * item.quantity;
      
      total += price * item.quantity;
      profit += itemProfit;

      // Include product type for keg calculation (exclude PET)
      saleItems.push({ 
        productId: item.productId, 
        productName: product.name, 
        quantity: item.quantity, 
        price: price, 
        cost_price: costPrice, 
        profit: itemProfit,
        type: product.type || 'keg'
      });
    }

    // Calculate keg quantity (exclude PET products)
    const kegQuantity = saleItems
      .filter(item => item.type !== 'pet')
      .reduce((sum, item) => sum + item.quantity, 0);

    // Use deliverKegs from request, or default to calculated keg quantity
    const finalDeliverKegs = deliverKegs > 0 ? deliverKegs : kegQuantity;

    // Use transaction for atomic operations
    const createSale = db.transaction(() => {
      // Insert sale with calculated keg quantity
      const saleResult = db.prepare('INSERT INTO sales (customer_id, total, profit, deliver_kegs, return_kegs, keg_balance_after, type) VALUES (?, ?, ?, ?, ?, ?, ?)').run(customerId, total, profit, finalDeliverKegs, returnKegs, newKegBalance, 'sale');
      const saleId = saleResult.lastInsertRowid;

      // Update customer last_order_date (if customerId)
      if (customerId) {
        db.prepare('UPDATE customers SET last_order_date = CURRENT_TIMESTAMP WHERE id = ?').run(customerId);
      }

      // Update customer monthly summary (if customerId) - only for sales, not replacements
      if (customerId && total > 0) {
        const saleDate = new Date();
        const year = saleDate.getFullYear();
        const month = saleDate.getMonth() + 1;
        // Exclude PET products from quantity
        const totalQuantity = saleItems
          .filter(item => item.type !== 'pet')
          .reduce((sum, item) => sum + item.quantity, 0);
        db.prepare(`
          INSERT INTO customer_monthly (customer_id, year, month, quantity, revenue, orders)
          VALUES (?, ?, ?, ?, ?, 1)
          ON CONFLICT(customer_id, year, month) DO UPDATE SET
            quantity = quantity + excluded.quantity,
            revenue = revenue + excluded.revenue,
            orders = orders + 1
        `).run(customerId, year, month, totalQuantity, total);
      }

      // Update products and insert sale_items
      for (const item of items) {
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(item.quantity, item.productId);
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
        const priceRecord = customerId ? db.prepare('SELECT * FROM prices WHERE customer_id = ? AND product_id = ?').get(customerId, item.productId) : null;
        const price = priceRecord ? priceRecord.price : (item.price || product.sell_price || 0);
        const costPrice = product.cost_price || 0;
        const itemProfit = (price - costPrice) * item.quantity;
        db.prepare('INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price, profit) VALUES (?, ?, ?, ?, ?, ?)').run(saleId, item.productId, item.quantity, price, costPrice, itemProfit);
      }

      // Update keg balance (only for registered customers)
      if (customerId && (deliverKegs !== 0 || returnKegs !== 0)) {
        db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(newKegBalance, customerId);
        
        if (deliverKegs > 0) {
          db.prepare('INSERT INTO keg_log (customer_id, change, note) VALUES (?, ?, ?)').run(customerId, deliverKegs, 'Giao vỏ - Đơn #' + saleId);
        }
        if (returnKegs > 0) {
          db.prepare('INSERT INTO keg_log (customer_id, change, note) VALUES (?, ?, ?)').run(customerId, -returnKegs, 'Thu vỏ - Đơn #' + saleId);
        }
      }

      return saleId;
    });

    const saleId = createSale();

    res.json({ success: true, id: saleId, total, profit });
  } catch (err) {
    console.error('Sale error:', err);
    res.status(500).json({ error: 'Sale failed: ' + err.message });
  }
});

// POST /api/sales/update-kegs - Cập nhật vỏ (với transaction)
router.post('/update-kegs', (req, res) => {
  const { saleId, customerId, deliver = 0, returned = 0 } = req.body;
  
  if (!saleId || !customerId) {
    return res.status(400).json({ error: 'Thiếu thông tin' });
  }
  
  try {
    const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(customerId);
    const currentKegBalance = customer ? customer.keg_balance : 0;
    const newKegBalance = currentKegBalance + deliver - returned;
    
    // Use transaction for atomic operations
    const updateKegs = db.transaction(() => {
      db.prepare('UPDATE sales SET deliver_kegs = ?, return_kegs = ?, keg_balance_after = ? WHERE id = ?')
        .run(deliver, returned, newKegBalance, saleId);
      
      db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(newKegBalance, customerId);
      
      if (deliver > 0) {
        db.prepare('INSERT INTO keg_log (customer_id, change, note) VALUES (?, ?, ?)').run(customerId, deliver, 'Cập nhật vỏ - Đơn #' + saleId);
      }
      if (returned > 0) {
        db.prepare('INSERT INTO keg_log (customer_id, change, note) VALUES (?, ?, ?)').run(customerId, -returned, 'Thu vỏ - Đơn #' + saleId);
      }
    });
    
    updateKegs();
    
    res.json({ success: true, message: 'Đã cập nhật vỏ' });
  } catch (err) {
    console.error('Update kegs error:', err);
    res.status(500).json({ error: 'Cập nhật thất bại: ' + err.message });
  }
});

// GET /api/sales - Lấy danh sách hóa đơn (phân trang, mặc định tháng hiện tại)
router.get('/', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 5;
  const month = req.query.month; // format: YYYY-MM, e.g. "2026-03"
  
  let whereClause = "WHERE s.type = 'sale'";
  let params = [];
  
  if (month) {
    whereClause += " AND strftime('%Y-%m', s.date) = ?";
    params.push(month);
  }
  
  // Get total count
  const totalCount = db.prepare(`SELECT COUNT(*) as count FROM sales s ${whereClause}`).get(...params);
  
  // Get paginated sales
  const offset = (page - 1) * limit;
  const sales = db.prepare(`
    SELECT s.*, COALESCE(c.name, 'Khách lẻ') as customer_name 
    FROM sales s 
    LEFT JOIN customers c ON s.customer_id = c.id 
    ${whereClause}
    ORDER BY s.date DESC 
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  
  res.json({ 
    sales, 
    total: totalCount.count,
    page,
    limit,
    totalPages: Math.ceil(totalCount.count / limit)
  });
});

// GET /api/sales/:id - Lấy chi tiết hóa đơn
router.get('/:id', (req, res) => {
  const sale = db.prepare(`SELECT s.*, COALESCE(c.name, 'Khách lẻ') as customer_name FROM sales s LEFT JOIN customers c ON s.customer_id = c.id WHERE s.id = ?`).get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare(`
    SELECT si.*, p.name, p.type
    FROM sale_items si
    JOIN products p ON p.id = si.product_id
    WHERE si.sale_id = ?
  `).all(req.params.id);
  res.json({ ...sale, items });
});

// POST /api/sales/replacement - Đổi bia lỗi (xuất bù, không tính tiền)
router.post('/replacement', (req, res) => {
  const { customer_id, product_id, quantity, reason } = req.body;
  
  if (!customer_id || !product_id || !quantity || quantity <= 0) {
    return res.status(400).json({ error: 'Thiếu thông tin cần thiết' });
  }

  try {
    // Check product stock
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
    if (!product) {
      return res.status(400).json({ error: 'Không tìm thấy sản phẩm' });
    }
    if (product.stock < quantity) {
      return res.status(400).json({ error: 'Không đủ hàng trong kho' });
    }

    // Create replacement sale (type = 'replacement', total = 0)
    const result = db.prepare(`
      INSERT INTO sales (customer_id, total, type, note, date)
      VALUES (?, 0, 'replacement', ?, datetime('now'))
    `).run(customer_id, reason || 'Đổi bia lỗi');
    
    const saleId = result.lastInsertRowid;

    // Add sale item
    db.prepare(`
      INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price, profit)
      VALUES (?, ?, ?, 0, ?, 0)
    `).run(saleId, product_id, quantity, product.cost_price);

    // Decrease product stock
    db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(quantity, product_id);

    res.json({ 
      success: true, 
      message: 'Đã tạo đơn đổi bia lỗi',
      saleId: saleId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Tạo đơn đổi bia thất bại' });
  }
});

// DELETE /api/sales/:id - Xóa hóa đơn
router.delete('/:id', (req, res) => {
  const saleId = req.params.id;
  
  try {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) return res.status(404).json({ error: 'Không tìm thấy hóa đơn' });
    
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
    
    for (const item of items) {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
    }
    
    db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(saleId);
    db.prepare('DELETE FROM sales WHERE id = ?').run(saleId);
    
    res.json({ success: true, message: 'Đã xóa hóa đơn và hoàn kho' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Xóa hóa đơn thất bại' });
  }
});

// PUT /api/sales/:id - Cập nhật hóa đơn
router.put('/:id', (req, res) => {
  const saleId = req.params.id;
  const { items, customerId } = req.body;
  
  try {
    const currentSale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!currentSale) return res.status(404).json({ error: 'Không tìm thấy hóa đơn' });
    
    const oldItems = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
    
    // Hoàn kho cũ
    for (const item of oldItems) {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
    }
    
    // Xóa các sale_items cũ
    db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(saleId);
    
    // Thêm các sản phẩm mới
    let newTotal = 0;
    let newProfit = 0;
    
    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
      if (!product || product.stock < item.quantity) {
        return res.status(400).json({ error: 'Không đủ hàng: ' + (product ? product.name : 'Unknown') });
      }
      
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(item.quantity, item.productId);
      
      // Use provided price or fallback to sell_price
      let price = item.price || product.sell_price || 0;
      
      // If customer has custom price, use that instead
      if (customerId) {
        const priceRecord = db.prepare('SELECT * FROM prices WHERE customer_id = ? AND product_id = ?').get(customerId, item.productId);
        if (priceRecord) {
          price = priceRecord.price;
        }
      }
      
      const costPrice = product.cost_price || 0;
      const itemProfit = (price - costPrice) * item.quantity;
      
      newTotal += price * item.quantity;
      newProfit += itemProfit;
      
      db.prepare('INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price, profit) VALUES (?, ?, ?, ?, ?, ?)').run(saleId, item.productId, item.quantity, price, costPrice, itemProfit);
    }
    
    // Cập nhật hóa đơn
    db.prepare('UPDATE sales SET customer_id = ?, total = ?, profit = ? WHERE id = ?').run(customerId, newTotal, newProfit, saleId);
    
    res.json({ success: true, total: newTotal, profit: newProfit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Cập nhật thất bại' });
  }
});

module.exports = router;
