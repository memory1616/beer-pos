const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');
const { syncKegInventory } = require('./products');
const { updateCustomerKegBalance } = require('./payments');
const { deleteSaleRestoringInventory } = require('../../src/services/saleDelete');
const socketServer = require('../../src/socket/socketServer');

// ========== HELPER: Resolve product by id (numeric) or slug ==========
function resolveProduct(query) {
  if (!query) return null;
  const numId = parseInt(query);
  if (!isNaN(numId) && numId > 0) {
    return db.prepare('SELECT * FROM products WHERE id = ?').get(numId);
  }
  return db.prepare('SELECT * FROM products WHERE slug = ?').get(String(query));
}

// ========== HELPER: Build priceMap for a customer (productId → price) ==========
// Returns { [productId]: price, [productSlug]: price }
function buildPriceMapForCustomer(customerId, productIds) {
  if (!customerId || !productIds || productIds.length === 0) return { byId: {}, bySlug: {} };
  const placeholders = productIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT pr.product_id, pr.product_slug, pr.price
    FROM prices pr
    WHERE pr.customer_id = ? AND pr.product_id IN (${placeholders})
  `).all(customerId, ...productIds);
  const byId = {};
  const bySlug = {};
  rows.forEach(r => {
    if (r.product_id) byId[r.product_id] = r.price;
    if (r.product_slug) bySlug[r.product_slug] = r.price;
  });
  return { byId, bySlug };
}

// ========== HELPER: Get effective price ==========
// Priority: 1. customer priceMap by id → 2. customer priceMap by slug → 3. product.sell_price
function getEffectivePrice(product, priceMap) {
  // 1. Customer price by numeric product ID
  if (priceMap.byId[product.id] !== undefined) {
    return priceMap.byId[product.id];
  }
  // 2. Customer price by product slug
  if (product.slug && priceMap.bySlug[product.slug] !== undefined) {
    return priceMap.bySlug[product.slug];
  }
  // 3. Fallback to product's base retail price
  const basePrice = product.sell_price || product.price || 0;
  return basePrice;
}

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

  // ========== PRE-VALIDATION ==========
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Danh sách sản phẩm trống' });
  }
  for (let i = 0; i < items.length; i++) {
    if (!items[i].productId && !items[i].productSlug) {
      return res.status(400).json({ error: `Sản phẩm thứ ${i + 1}: Thiếu mã sản phẩm (productId hoặc productSlug)` });
    }
    if (!items[i].quantity || items[i].quantity <= 0) {
      return res.status(400).json({ error: `Sản phẩm thứ ${i + 1}: Số lượng phải lớn hơn 0` });
    }
  }

  console.log('[SALE CREATE]', { customerId, itemsCount: items.length, items: items });

  try {
    let total = 0;
    let profit = 0;
    const saleItems = [];

    // Pre-load all products in ONE query (resolve by id or slug)
    const productQueries = items.map(i => i.productId || i.productSlug).filter(Boolean);
    const productMap = {};
    if (productQueries.length > 0) {
      // Build OR condition: id IN (...) OR slug IN (...)
      const uniqueQueries = [...new Set(productQueries)];
      const conditions = uniqueQueries.map(() => {
        const num = parseInt(q => q);
        return !isNaN(num) && num > 0 ? 'id = ?' : 'slug = ?';
      });
      // Actually let's do a simple approach: get all products, filter in memory
      const allProducts = db.prepare('SELECT * FROM products').all();
      allProducts.forEach(p => { productMap[p.id] = p; productMap[p.slug] = p; });
    }

    // Pre-load customer prices in ONE query
    const productIds = items.map(i => {
      const prod = productMap[i.productId || i.productSlug];
      return prod ? prod.id : null;
    }).filter(Boolean);
    const priceMap = customerId ? buildPriceMapForCustomer(customerId, productIds) : { byId: {}, bySlug: {} };

    // Get customer's current keg balance (if customerId is provided)
    let currentKegBalance = 0;
    let newKegBalance = 0;

    for (const item of items) {
      const queryKey = item.productId || item.productSlug;
      const product = productMap[queryKey];
      if (!product) return res.status(400).json({ error: 'Không tìm thấy sản phẩm: ' + queryKey });

      // Determine effective price: customer price > product sell_price > 0
      const price = item.price !== undefined && item.price !== null && item.price > 0
        ? item.price
        : getEffectivePrice(product, priceMap);

      const costPrice = product.cost_price || 0;
      const itemProfit = (price - costPrice) * item.quantity;

      total += price * item.quantity;
      profit += itemProfit;

      saleItems.push({
        productId: product.id,
        productSlug: product.slug,
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

    const finalDeliverKegs = deliverKegs > 0 ? deliverKegs : kegQuantity;

    if (customerId) {
      const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(customerId);
      currentKegBalance = customer ? customer.keg_balance : 0;
      newKegBalance = currentKegBalance + finalDeliverKegs - returnKegs;
    }

    // ========== STRICT TRANSACTION ==========
    const createSale = db.transaction(() => {
      // Insert sale with Vietnam-local date
      const saleDate = db.getVietnamDateStr();
      const saleResult = db.prepare('INSERT INTO sales (customer_id, date, total, profit, deliver_kegs, return_kegs, keg_balance_after, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(customerId, saleDate, total, profit, finalDeliverKegs, returnKegs, newKegBalance, 'sale');
      const saleId = saleResult.lastInsertRowid;

      if (!saleId) throw new Error('Sale creation failed — no lastInsertRowid');

      // Update customer last_order_date (if customerId)
      if (customerId) {
        db.prepare("UPDATE customers SET last_order_date = datetime('now', '+7 hours') WHERE id = ?").run(customerId);
      }

      // Update products and insert sale_items (reuse pre-loaded data — no extra queries)
      for (const item of saleItems) {
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(item.quantity, item.productId);
        db.prepare('INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit, price_at_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(saleId, item.productId, item.productSlug, item.quantity, item.price, item.cost_price, item.profit, item.price);
      }

      // ========== HARD VALIDATION: verify ALL sale_items were inserted ==========
      const insertedCount = db.prepare('SELECT COUNT(*) as count FROM sale_items WHERE sale_id = ?').get(saleId);
      if (insertedCount.count !== saleItems.length) {
        throw new Error(`CRITICAL: sale_items insert mismatch — expected ${saleItems.length}, got ${insertedCount.count}`);
      }

      // Update customer keg balance (only for registered customers)
      if (customerId && (finalDeliverKegs !== 0 || returnKegs !== 0)) {
        updateCustomerKegBalance(customerId, finalDeliverKegs, returnKegs);
      }

      // Get synced totals from source tables
      const inventoryResult = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get();
      const totalHolding = db.prepare("SELECT COALESCE(SUM(keg_balance), 0) as total FROM customers").get();

      db.prepare(`
        UPDATE keg_stats
        SET inventory = ?, customer_holding = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run(inventoryResult.total, totalHolding.total);

      return saleId;
    });

    const saleId = createSale();

    if (!saleId) throw new Error('Sale creation returned null');

    console.log('[SALE CREATED]', { saleId, itemsInserted: saleItems.length, total, profit });

    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    socketServer.emitOrderCreated(sale);
    res.json({ success: true, id: saleId, total, profit });
  } catch (err) {
    console.error('[SALE ERROR]', err);
    logger.error('Sale error', { error: err.message, stack: err.stack });
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
    const sale = db.prepare('SELECT deliver_kegs, return_kegs FROM sales WHERE id = ?').get(saleId);
    if (!sale) return res.status(404).json({ error: 'Không tìm thấy hóa đơn' });

    const prevDeliver = sale.deliver_kegs || 0;
    const prevReturned = sale.return_kegs || 0;

    const deltaDeliver = deliver - prevDeliver;
    const deltaReturn  = returned - prevReturned;

    // Validation: cannot return more than customer holds.
    // customer holds = current_balance + (newDeliver - prevDeliver)
    // because prevDeliver is ALREADY included in currentKegBalance
    const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(customerId);
    if (!customer) return res.status(404).json({ error: 'Không tìm thấy khách hàng' });

    const currentKegBalance = customer.keg_balance || 0;
    const netNewDeliver = deliver - prevDeliver;
    const maxAllowedReturn = currentKegBalance + netNewDeliver;
    if (returned > maxAllowedReturn) {
      return res.status(400).json({
        error: `Không thể thu ${returned} vỏ. Khách chỉ giữ tối đa ${maxAllowedReturn} vỏ (${currentKegBalance} hiện tại + ${netNewDeliver} giao thêm).`
      });
    }

    const newKegBalance = currentKegBalance + deltaDeliver - deltaReturn;

    // Thunk: deltaReturn > 0 → thu thêm → cộng vào empty_collected
    //       deltaReturn < 0 → giảm thu → trừ khỏi empty_collected
    const newlyCollected = Math.max(0, deltaReturn);
    const newlyReturnedToCustomer = Math.max(0, -deltaReturn); // giảm thu → trả vỏ lại cho khách

    const updateKegs = db.transaction(() => {
      // 1. Update hóa đơn
      db.prepare('UPDATE sales SET deliver_kegs = ?, return_kegs = ?, keg_balance_after = ? WHERE id = ?')
        .run(deliver, returned, newKegBalance, saleId);

      // 2. Update balance khách
      updateCustomerKegBalance(customerId, deltaDeliver, deltaReturn);

      // 3. Update keg_stats.empty_collected
      //    newlyCollected > 0   → thu thêm → empty_collected += newlyCollected
      //    newlyReturnedToCustomer > 0 → giảm thu → empty_collected -= newlyReturnedToCustomer
      if (newlyCollected > 0 || newlyReturnedToCustomer > 0) {
        const stats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
        const currentEmpty = stats?.empty_collected || 0;
        const newEmpty = Math.max(0, currentEmpty + newlyCollected - newlyReturnedToCustomer);
        db.prepare('UPDATE keg_stats SET empty_collected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
          .run(newEmpty);
      }

      // 4. Ghi log thu vỏ (chỉ khi thu thêm, không ghi khi giảm thu)
      if (newlyCollected > 0) {
        const updatedStats = db.prepare('SELECT inventory, empty_collected, customer_holding FROM keg_stats WHERE id = 1').get();
        const customer2 = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId);
        db.prepare(`
          INSERT INTO keg_transactions_log
            (type, quantity, customer_id, customer_name, inventory_after, empty_after, holding_after, note)
          VALUES ('collect', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          newlyCollected,
          customerId,
          customer2?.name || '',
          updatedStats?.inventory || 0,
          updatedStats?.empty_collected || 0,
          updatedStats?.customer_holding || 0,
          `Thu vỏ qua đơn hàng #${saleId}`
        );
      }
    });

    updateKegs();

    socketServer.emitKegUpdated();
    socketServer.emitOrderUpdated({ id: saleId, returned: true });
    res.json({ success: true, message: 'Đã cập nhật vỏ', newBalance: newKegBalance });
  } catch (err) {
    logger.error('Update kegs error', { error: err.message });
    res.status(500).json({ error: 'Cập nhật thất bại: ' + err.message });
  }
});

// GET /api/sales - Lấy danh sách hóa đơn (phân trang, mặc định tháng hiện tại)
router.get('/', (req, res) => {
  // PERFORMANCE: ?fields=id,date,total,profit reduces payload for list views
  const { fields, page, limit, month, status } = req.query;
  let saleFields = 's.*';
  if (fields) {
    const requestedFields = fields.split(',').map(f => f.trim()).filter(Boolean);
    const allowed = ['id','date','total','profit','customer_id','deliver_kegs','return_kegs','keg_balance_after','type','status','note','payment_status','distance_km','duration_min','route_index','route_polyline','returned_amount','returned_quantity','returned_profit'];
    const valid = requestedFields.filter(f => allowed.includes(f));
    if (valid.length > 0) saleFields = 's.' + valid.join(', s.');
  }
  
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
    SELECT ${saleFields}, COALESCE(c.name, 'Khách lẻ') as customer_name,
      (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id) as items_qty
    FROM sales s
    LEFT JOIN customers c ON s.customer_id = c.id
    ${whereClause}
    ORDER BY datetime(s.date) DESC, s.id DESC
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
    SELECT si.*, p.name, p.slug as product_slug, p.type
    FROM sale_items si
    JOIN products p ON p.id = si.product_id
    WHERE si.sale_id = ?
  `).all(req.params.id);
  res.json({ ...sale, items });
});

// POST /api/sales/replacement - Đổi bia lỗi (xuất bù, không tính tiền)
// gift=true: toàn bộ số lượng là tặng uống thử → trừ stock + cộng vỏ keg vào kho vỏ rỗng ngay
router.post('/replacement', (req, res) => {
  const { customer_id, product_id, quantity, reason, gift, giftGuestName } = req.body;
  logger.info('[replacement] request', { customer_id, product_id, quantity, isGift: !!gift });

  if (!product_id || !quantity || quantity <= 0) {
    return res.status(400).json({ error: 'Thiếu thông tin cần thiết' });
  }

  const isGift = !!gift;
  const isGuest = !customer_id;

  if (!isGift && isGuest) {
    return res.status(400).json({ error: 'Vui lòng chọn khách hàng' });
  }

  try {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
    logger.info('[replacement] product found', { productId: product?.id, name: product?.name });
    if (!product) {
      return res.status(400).json({ error: 'Không tìm thấy sản phẩm' });
    }

    // Lấy tên khách hàng từ database
    let customerName = null;
    if (customer_id) {
      const customer = db.prepare('SELECT name FROM customers WHERE id = ?').get(customer_id);
      customerName = customer?.name || null;
    } else if (isGift && giftGuestName) {
      customerName = giftGuestName;
    }

    const note = isGift
      ? `${reason || 'Bia hư'} — 🎁 Tặng uống thử`
      : reason || 'Đổi bia lỗi';

    const doReplacement = db.transaction(() => {
      const saleDate = db.getVietnamDateStr();
      const result = db.prepare(`
        INSERT INTO sales (customer_id, total, type, note, date)
        VALUES (?, 0, 'replacement', ?, ?)
      `).run(customer_id || null, note, saleDate);
      const saleId = result.lastInsertRowid;
      logger.info('[replacement] sale inserted', { saleId });

      db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price, profit)
        VALUES (?, ?, ?, 0, ?, 0)
      `).run(saleId, product_id, quantity, product.cost_price);

      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(quantity, product_id);

      // Cộng vỏ bình vào kho vỏ rỗng (khách mang vỏ lại)
      const stats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
      const newEmpty = (stats?.empty_collected || 0) + quantity;
      db.prepare('UPDATE keg_stats SET empty_collected = ? WHERE id = 1').run(newEmpty);
      db.prepare(`
        INSERT INTO keg_transactions_log
          (type, quantity, exchanged, purchased, customer_id, customer_name, inventory_after, empty_after, holding_after, note)
        VALUES (?, ?, ?, 0, ?, ?, ?, ?, 0, ?)
      `).run(isGift ? 'gift' : 'replacement', quantity, quantity, 0, customer_id || null, customerName, product.stock - quantity, newEmpty, note);

      return saleId;
    });

    const saleId = doReplacement();
    logger.info('[replacement] transaction done', { saleId });

    // syncKegInventory MUST be outside transaction to avoid rollback on failure
    try {
      syncKegInventory();
    } catch (syncErr) {
      logger.error('syncKegInventory failed after replacement', { error: syncErr.message, saleId });
    }

    socketServer.emitInventoryUpdated();
    socketServer.emitReportUpdated({ reason: 'replacement', saleId });

    const message = isGift
      ? `Đã đổi ${quantity} bia + tặng uống thử — vỏ keg đã vào kho vỏ rỗng`
      : `Đã đổi ${quantity} bia lỗi cho khách — vỏ đổi đã vào kho vỏ rỗng`;

    logger.info('[replacement] success', { saleId, message });
    res.json({ success: true, message });
  } catch (err) {
    logger.error('Create replacement error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Tạo đơn đổi bia thất bại: ' + err.message });
  }
});

// POST /api/sales/:id/return - Trả hàng (hoàn tiền, hoàn kho, điều chỉnh vỏ)
router.post('/:id/return', (req, res) => {
  const saleId = req.params.id;
  const { returnType = 'stock_return', reason, addToInventory = true } = req.body; // 'stock_return' hoặc 'damage_return'
  
  try {
    // Lấy thông tin hóa đơn
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) return res.status(404).json({ error: 'Không tìm thấy hóa đơn' });
    
    // Kiểm tra nếu đã trả hàng rồi
    if (sale.status === 'returned') {
      return res.status(400).json({ error: 'Hóa đơn này đã được trả hàng' });
    }
    
    // Lấy chi tiết sản phẩm trong hóa đơn
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
    
    let totalReturnProfit = 0;
    
    if (returnType === 'stock_return') {
      // Trả lại kho - cộng lại tồn kho sản phẩm
      for (const item of items) {
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
        totalReturnProfit += item.profit || 0;
      }
    } else if (returnType === 'damage_return') {
      // Bia lỗi - ghi nhận vào bảng hàng lỗi, không cộng kho
      for (const item of items) {
        db.prepare('UPDATE products SET damaged_stock = damaged_stock + ? WHERE id = ?').run(item.quantity, item.product_id);
        db.prepare('INSERT INTO damaged_products (product_id, quantity, reason) VALUES (?, ?, ?)').run(
          item.product_id, item.quantity, reason || 'Bia lỗi/hư'
        );
        totalReturnProfit += item.profit || 0;
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
        updateCustomerKegBalance(sale.customer_id, -deliverKegs, returnKegs);
      }
    }
    
    // THÊM MỚI: Cộng vỏ vào kho vỏ rỗng nếu addToInventory = true
    let inventoryBalance = null;
    if (addToInventory && deliverKegs > 0) {
      // Lấy số vỏ rỗng hiện tại từ keg_stats
      const stats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
      const currentEmpty = stats?.empty_collected || 0;
      const newEmpty = currentEmpty + deliverKegs;
      
      // Cập nhật kho vỏ rỗng
      db.prepare('UPDATE keg_stats SET empty_collected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(newEmpty);
      
      // Ghi log kho vỏ
      db.prepare(`
        INSERT INTO keg_transactions_log (type, quantity, inventory_after, empty_after, holding_after, note)
        VALUES ('collect_return', ?, 0, ?, 0, ?)
      `).run(
        deliverKegs,
        newEmpty,
        reason || 'Thu vỏ từ đơn trả hàng'
      );
      
      inventoryBalance = newEmpty;
    }
    
    // Cập nhật trạng thái hóa đơn với loại return (bao gồm cập nhật lợi nhuận)
    db.prepare("UPDATE sales SET status = 'returned', type = ?, total = 0, profit = 0 WHERE id = ?").run(returnType, saleId);

    socketServer.emitInventoryUpdated();
    socketServer.emitReportUpdated({ reason: 'sale_return', saleId });
    res.json({
      success: true,
      message: returnType === 'stock_return' ? 'Đã trả hàng (trả lại kho)' : 'Đã ghi nhận bia lỗi',
      returnedAmount: sale.total,
      returnedItems: items.length,
      returnedKegs: deliverKegs,
      returnType,
      inventoryBalance
    });
  } catch (err) {
    logger.error('Create replacement error', { error: err.message });
    res.status(500).json({ error: 'Trả hàng thất bại' });
  }
});

// POST /api/sales/:id/return-items - Trả một phần hàng (chọn sản phẩm và số lượng)
router.post('/:id/return-items', (req, res) => {
  const saleId = req.params.id;
  const { items: returnItems, returnType = 'stock_return', reason, addToInventory = true } = req.body;
  
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
        updateCustomerKegBalance(sale.customer_id, 0, returnedKegs);
      }
    }
    
    // THÊM MỚI: Cộng vỏ vào kho vỏ rỗng nếu addToInventory = true
    let inventoryBalance = null;
    if (addToInventory && returnedKegs > 0) {
      // Lấy số vỏ rỗng hiện tại từ keg_stats
      const stats = db.prepare('SELECT empty_collected FROM keg_stats WHERE id = 1').get();
      const currentEmpty = stats?.empty_collected || 0;
      const newEmpty = currentEmpty + returnedKegs;
      
      // Cập nhật kho vỏ rỗng
      db.prepare('UPDATE keg_stats SET empty_collected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(newEmpty);
      
      // Ghi log kho vỏ
      db.prepare(`
        INSERT INTO keg_transactions_log (type, quantity, inventory_after, empty_after, holding_after, note)
        VALUES ('collect_return', ?, 0, ?, 0, ?)
      `).run(
        returnedKegs,
        newEmpty,
        reason || 'Thu vỏ từ đơn trả hàng'
      );
      
      inventoryBalance = newEmpty;
    }
    
    // Cập nhật hóa đơn gốc: trừ tiền, trừ lợi nhuận và đánh dấu có partial return
    const currentReturnAmount = sale.returned_amount || 0;
    const currentReturnQty = sale.returned_quantity || 0;
    const currentReturnProfit = sale.returned_profit || 0;
    
    // Tính lợi nhuận của hàng trả
    let totalReturnProfit = 0;
    for (const returnItem of returnItems) {
      const saleItem = saleItems.find(si => si.product_id === returnItem.productId);
      if (saleItem) {
        const ratio = returnItem.quantity / saleItem.quantity;
        totalReturnProfit += (saleItem.profit || 0) * ratio;
      }
    }
    
    db.prepare(`
      UPDATE sales 
      SET total = total - ?, 
          profit = profit - ?,
          returned_amount = ?,
          returned_quantity = ?,
          returned_profit = ?,
          status = CASE WHEN (returned_amount + ?) >= total THEN 'returned' ELSE status END
      WHERE id = ?
    `).run(
      totalReturnAmount, 
      totalReturnProfit,
      currentReturnAmount + totalReturnAmount, 
      currentReturnQty + totalReturnQty,
      currentReturnProfit + totalReturnProfit,
      totalReturnAmount, 
      saleId
    );

    socketServer.emitInventoryUpdated();
    socketServer.emitReportUpdated({ reason: 'partial_return', saleId });
    res.json({
      success: true,
      message: returnType === 'stock_return' ? 'Đã trả hàng (trả lại kho)' : 'Đã ghi nhận bia lỗi',
      returnedAmount: totalReturnAmount,
      returnedQuantity: totalReturnQty,
      returnedKegs,
      inventoryBalance
    });
  } catch (err) {
    logger.error('Create replacement error', { error: err.message });
    res.status(500).json({ error: 'Trả hàng thất bại: ' + err.message });
  }
});

// GET /api/export - Backup: full export of all sales and sale_items
router.get('/export', (req, res) => {
  try {
    const sales = db.prepare('SELECT * FROM sales ORDER BY datetime(date) DESC').all();
    const saleItems = db.prepare('SELECT * FROM sale_items').all();
    res.json({ sales, sale_items: saleItems });
  } catch (err) {
    console.error('[EXPORT ERROR]', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// DELETE /api/sales/:id - Xóa hóa đơn
router.delete('/:id', (req, res) => {
  const saleId = req.params.id;

  try {
    const result = deleteSaleRestoringInventory(saleId);
    if (!result.ok) {
      if (result.code === 'not_found') {
        return res.status(404).json({ error: 'Không tìm thấy hóa đơn' });
      }
      if (result.code === 'returned') {
        return res.status(400).json({ error: 'Không thể xóa đơn đã trả hàng' });
      }
      return res.status(500).json({ error: 'Xóa hóa đơn thất bại' });
    }

    socketServer.emitOrderDeleted(parseInt(saleId, 10));
    res.json({ success: true, message: 'Đã xóa hóa đơn' });
  } catch (err) {
    logger.error('Delete sale error', { error: err.message });
    res.status(500).json({ error: 'Xóa hóa đơn thất bại' });
  }
});

// PUT /api/sales/:id - Cập nhật hóa đơn
router.put('/:id', (req, res) => {
  const saleId = req.params.id;
  logger.info(`[api/sales] PUT /${saleId} called, body has items=${Array.isArray(req.body?.items) ? req.body.items.length : 'N/A'}`);
  const { items, customerId } = req.body;

  try {
    const currentSale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!currentSale) {
      logger.warn(`[api/sales] Sale not found: ${saleId}`);
      return res.status(404).json({ error: 'Không tìm thấy hóa đơn' });
    }
    logger.info(`[api/sales] Sale found: type=${currentSale.type}, current total=${currentSale.total}`);

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
      const queryKey = item.productId || item.productSlug;
      const product = resolveProduct(queryKey);
      if (!product) {
        logger.warn(`[api/sales] Product not found: ${queryKey}`);
        return res.status(400).json({ error: 'Không tìm thấy sản phẩm: ' + queryKey });
      }

      // Trừ kho (chỉ với hóa đơn bán)
      if (currentSale.type === 'sale') {
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(item.quantity, product.id);
      }

      // Luôn dùng item.price từ frontend — đây là giá đã được UI tính theo khách hàng
      let price = item.price || product.sell_price || 0;

      const costPrice = product.cost_price || 0;
      const itemProfit = (price - costPrice) * item.quantity;

      newTotal += price * item.quantity;
      newProfit += itemProfit;

      db.prepare('INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit, price_at_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(saleId, product.id, product.slug, item.quantity, price, costPrice, itemProfit, price);
    }

    // Cập nhật hóa đơn
    db.prepare('UPDATE sales SET customer_id = ?, total = ?, profit = ? WHERE id = ?').run(customerId, newTotal, newProfit, saleId);

    const updatedSale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    logger.info(`[api/sales] Sale updated successfully: id=${saleId}, newTotal=${newTotal}`);
    socketServer.emitOrderUpdated(updatedSale);
    res.json({ success: true, total: newTotal, profit: newProfit });
  } catch (err) {
    logger.error('Update sale error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Cập nhật thất bại: ' + err.message });
  }
});

module.exports = router;
