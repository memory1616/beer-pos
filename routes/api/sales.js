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
  const status = req.query.status; // 'completed', 'returned', 'cancelled', hoặc 'all'
  
  let whereClause = "WHERE s.type IN ('sale', 'replacement', 'damage_return')";
  let params = [];
  
  if (month) {
    whereClause += " AND strftime('%Y-%m', s.date) = ?";
    params.push(month);
  }
  
  // Filter theo status (mặc định chỉ lấy completed)
  if (status && status !== 'all') {
    whereClause += " AND s.status = ?";
    params.push(status);
  } else if (!status) {
    // Mặc định hiển thị hóa đơn chưa trả + đơn đổi bia lỗi
    whereClause += " AND (s.status IS NULL OR s.status != 'returned' OR s.type IN ('replacement', 'damage_return'))";
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

// POST /api/sales/:id/return - Trả hàng (hoàn tiền, hoàn kho, điều chỉnh vỏ)
router.post('/:id/return', (req, res) => {
  const saleId = req.params.id;
  const { returnType = 'stock_return', reason } = req.body; // 'stock_return' hoặc 'damage_return'
  
  try {
    // Lấy thông tin hóa đơn
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) return res.status(404).json({ error: 'Không tìm thấy hóa đơn' });
    
    // Kiểm tra nếu đã trả hàng rồi
    if (sale.status === 'returned') {
      return res.status(400).json({ error: 'Hóa đơn này đã được trả hàng' });
    }
    
    // Lấy chi tiết sản phẩm trong hóa đơn
    const items = db.prepare('SELECT * WHERE sale_id = ?').all(saleId);
    
    if (returnType === 'stock_return') {
      // Trả lại kho - cộng lại tồn kho sản phẩm
      for (const item of items) {
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
      }
    } else if (returnType === 'damage_return') {
      // Bia lỗi - ghi nhận vào bảng hàng lỗi, không cộng kho
      for (const item of items) {
        db.prepare('UPDATE products SET damaged_stock = damaged_stock + ? WHERE id = ?').run(item.quantity, item.product_id);
        db.prepare('INSERT INTO damaged_products (product_id, quantity, reason) VALUES (?, ?, ?)').run(
          item.product_id, item.quantity, reason || 'Bia lỗi/hư'
        );
      }
    }
    
    // Cập nhật số vỏ: khách trả lại vỏ đã giao, thu hồi vỏ đã thu trước đó
    const deliverKegs = sale.deliver_kegs || 0;
    const returnKegs = sale.return_kegs || 0;
    
    // Cập nhật tồn kho vỏ của khách hàng nếu có
    if (sale.customer_id) {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(sale.customer_id);
      if (customer) {
        const currentKegBalance = customer.keg_balance || 0;
        // Trừ đi số vỏ đã giao, cộng lại số vỏ đã thu
        const newKegBalance = currentKegBalance - deliverKegs + returnKegs;
        db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(newKegBalance, sale.customer_id);
      }
    }
    
    // Cập nhật trạng thái hóa đơn với loại return
    db.prepare("UPDATE sales SET status = 'returned', type = ? WHERE id = ?").run(returnType, saleId);
    
    res.json({ 
      success: true, 
      message: returnType === 'stock_return' ? 'Đã trả hàng (trả lại kho)' : 'Đã ghi nhận bia lỗi',
      returnedAmount: sale.total,
      returnedItems: items.length,
      returnedKegs: deliverKegs,
      returnType
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Trả hàng thất bại' });
  }
});

// POST /api/sales/:id/return-items - Trả một phần hàng (chọn sản phẩm và số lượng)
router.post('/:id/return-items', (req, res) => {
  const saleId = req.params.id;
  const { items: returnItems, returnType = 'stock_return', reason } = req.body;
  
  if (!returnItems || !Array.isArray(returnItems) || returnItems.length === 0) {
    return res.status(400).json({ error: 'Danh sách sản phẩm trống' });
  }
  
  try {
    // Lấy thông tin hóa đơn
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) return res.status(404).json({ error: 'Không tìm thấy hóa đơn' });
    
    // Lấy chi tiết sản phẩm trong hóa đơn
    const saleItems = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
    
    let totalReturnAmount = 0;
    let totalReturnQty = 0;
    let returnedKegs = 0;
    
    for (const returnItem of returnItems) {
      const { productId, quantity } = returnItem;
      
      // Tìm sản phẩm trong hóa đơn
      const saleItem = saleItems.find(si => si.product_id === productId);
      if (!saleItem) {
        return res.status(400).json({ error: 'Sản phẩm không có trong hóa đơn' });
      }
      
      // Kiểm tra số lượng trả không vượt quá số lượng đã mua
      const maxQty = saleItem.quantity;
      if (quantity > maxQty) {
        return res.status(400).json({ error: `Số lượng trả (${quantity}) vượt quá số lượng mua (${maxQty})` });
      }
      
      // Tính tiền hoàn
      const itemAmount = saleItem.price * quantity;
      totalReturnAmount += itemAmount;
      totalReturnQty += quantity;
      
      // Xử lý kho tùy loại return
      if (returnType === 'stock_return') {
        // Trả lại kho - cộng lại tồn kho
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(quantity, productId);
      } else if (returnType === 'damage_return') {
        // Bia lỗi - ghi nhận vào bảng hàng lỗi
        db.prepare('UPDATE products SET damaged_stock = damaged_stock + ? WHERE id = ?').run(quantity, productId);
        db.prepare('INSERT INTO damaged_products (product_id, quantity, reason) VALUES (?, ?, ?)').run(
          productId, quantity, reason || 'Bia lỗi/hư'
        );
      }
    }
    
    // Tính số vỏ tương ứng với tỷ lệ trả
    const returnRatio = totalReturnQty / saleItems.reduce((sum, si) => sum + si.quantity, 0);
    returnedKegs = Math.round((sale.deliver_kegs || 0) * returnRatio);
    
    // Cập nhật tồn kho vỏ của khách hàng
    if (sale.customer_id && returnedKegs > 0) {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(sale.customer_id);
      if (customer) {
        const currentKegBalance = customer.keg_balance || 0;
        const newKegBalance = currentKegBalance - returnedKegs;
        db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(newKegBalance, sale.customer_id);
      }
    }
    
    // Cập nhật hóa đơn gốc: trừ tiền và đánh dấu có partial return
    const currentReturnAmount = sale.returned_amount || 0;
    const currentReturnQty = sale.returned_quantity || 0;
    db.prepare(`
      UPDATE sales 
      SET total = total - ?, 
          returned_amount = ?,
          returned_quantity = ?,
          status = CASE WHEN (returned_amount + ?) >= total THEN 'returned' ELSE status END
      WHERE id = ?
    `).run(totalReturnAmount, currentReturnAmount + totalReturnAmount, currentReturnQty + totalReturnQty, totalReturnAmount, saleId);
    
    res.json({ 
      success: true, 
      message: returnType === 'stock_return' ? 'Đã trả hàng (trả lại kho)' : 'Đã ghi nhận bia lỗi',
      returnedAmount: totalReturnAmount,
      returnedQuantity: totalReturnQty,
      returnedKegs
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Trả hàng thất bại: ' + err.message });
  }
});

// DELETE /api/sales/:id - Xóa hóa đơn
router.delete('/:id', (req, res) => {
  const saleId = req.params.id;
  
  try {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) return res.status(404).json({ error: 'Không tìm thấy hóa đơn' });
    
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
    
    // Chỉ restore stock cho hóa đơn bán (không restore cho đơn đổi bia lỗi)
    if (sale.type === 'sale') {
      for (const item of items) {
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
      }
    }
    
    db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(saleId);
    db.prepare('DELETE FROM sales WHERE id = ?').run(saleId);
    
    res.json({ success: true, message: 'Đã xóa hóa đơn' + (sale.type === 'sale' ? ' và hoàn kho' : '') });
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
    
    // Hoàn kho cũ (chỉ với hóa đơn bán, không với đổi bia lỗi)
    if (currentSale.type === 'sale') {
      for (const item of oldItems) {
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
      }
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
      
      // Trừ kho (chỉ với hóa đơn bán)
      if (currentSale.type === 'sale') {
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(item.quantity, item.productId);
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
