/**
 * BeerPOS Service Layer
 *
 * Service Layer chứa business logic, tách biệt khỏi routes.
 * Các service được thiết kế để:
 * 1. Tái sử dụng logic giữa nhiều routes
 * 2. Dễ test và maintain
 * 3. Cache data ở memory để tránh query DB nhiều lần
 *
 * CÁCH DÙNG:
 * const SaleService = require('./services/SaleService');
 * SaleService.create(req.body);
 */

const db = require('../database');
const logger = require('../utils/logger');

// ============================================================
// SALE SERVICE - Business logic cho sales
// ============================================================
class SaleService {
  constructor() {
    // Memory cache cho request hiện tại (singleton pattern)
    this._saleCache = new Map();
  }

  /**
   * Tạo sale mới với validation đầy đủ
   * @param {Object} data - { customerId, items, deliverKegs, returnKegs }
   * @returns {Object} { success, saleId, total, profit }
   */
  create(data) {
    const { customerId, items, deliverKegs = 0, returnKegs = 0 } = data;

    // Validate input
    const errors = this._validateSaleInput(data);
    if (errors.length > 0) {
      return { success: false, errors };
    }

    // Pre-load data một lần (tránh N+1 queries)
    const productMap = this._loadProducts();
    const priceMap = customerId ? this._loadCustomerPrices(customerId) : { byId: {}, bySlug: {} };

    // Calculate totals
    let total = 0;
    let profit = 0;
    const saleItems = [];

    for (const item of items) {
      const product = productMap[item.productId] || productMap[item.productSlug];
      if (!product) {
        return { success: false, errors: [`Không tìm thấy sản phẩm: ${item.productId || item.productSlug}`] };
      }

      const price = this._getEffectivePrice(product, priceMap);
      const costPrice = product.cost_price || 0;
      const itemProfit = (price - costPrice) * item.quantity;

      total += price * item.quantity;
      profit += itemProfit;

      saleItems.push({
        productId: product.id,
        productSlug: product.slug,
        productName: product.name,
        quantity: item.quantity,
        price,
        costPrice,
        profit: itemProfit,
        type: product.type || 'keg'
      });
    }

    // Calculate keg quantity
    const kegQuantity = saleItems
      .filter(i => i.type !== 'pet')
      .reduce((sum, i) => sum + i.quantity, 0);
    const finalDeliverKegs = deliverKegs > 0 ? deliverKegs : kegQuantity;

    // Customer keg balance
    let newKegBalance = 0;
    if (customerId) {
      const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(customerId);
      const currentBalance = customer ? customer.keg_balance : 0;
      newKegBalance = currentBalance + finalDeliverKegs - returnKegs;
    }

    // Transaction
    const createSale = db.transaction(() => {
      const saleDate = db.getVietnamDateStr();
      const result = db.prepare(`
        INSERT INTO sales (customer_id, date, total, profit, deliver_kegs, return_kegs, keg_balance_after, type)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'sale')
      `).run(customerId, saleDate, total, profit, finalDeliverKegs, returnKegs, newKegBalance);
      const saleId = result.lastInsertRowid;

      if (!saleId) throw new Error('Sale creation failed');

      // Update customer last order
      if (customerId) {
        db.prepare("UPDATE customers SET last_order_date = datetime('now', '+7 hours') WHERE id = ?").run(customerId);
      }

      // Insert items + update stock
      for (const item of saleItems) {
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(item.quantity, item.productId);
        db.prepare(`
          INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit, price_at_time)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(saleId, item.productId, item.productSlug, item.quantity, item.price, item.costPrice, item.profit, item.price);
      }

      // Update customer keg balance
      if (customerId && (finalDeliverKegs !== 0 || returnKegs !== 0)) {
        this._updateCustomerKegBalance(customerId, finalDeliverKegs, returnKegs);
      }

      // Update keg stats
      this._syncKegInventory();

      return saleId;
    });

    const saleId = createSale();
    return { success: true, saleId, total, profit };
  }

  /**
   * Validate sale input
   */
  _validateSaleInput(data) {
    const errors = [];
    if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
      errors.push('Danh sách sản phẩm trống');
    } else {
      data.items.forEach((item, i) => {
        if (!item.productId && !item.productSlug) {
          errors.push(`Sản phẩm thứ ${i + 1}: Thiếu mã sản phẩm`);
        }
        if (!item.quantity || item.quantity <= 0) {
          errors.push(`Sản phẩm thứ ${i + 1}: Số lượng phải > 0`);
        }
      });
    }
    return errors;
  }

  /**
   * Load all products vào Map (cache in-memory)
   */
  _loadProducts() {
    const cacheKey = '_products';
    if (this._saleCache.has(cacheKey)) {
      return this._saleCache.get(cacheKey);
    }

    const map = {};
    const products = db.prepare('SELECT * FROM products').all();
    products.forEach(p => {
      map[p.id] = p;
      if (p.slug) map[p.slug] = p;
    });

    this._saleCache.set(cacheKey, map);
    return map;
  }

  /**
   * Load customer prices
   */
  _loadCustomerPrices(customerId) {
    const cacheKey = `_prices_${customerId}`;
    if (this._saleCache.has(cacheKey)) {
      return this._saleCache.get(cacheKey);
    }

    const byId = {};
    const bySlug = {};
    const prices = db.prepare(`
      SELECT product_id, product_slug, price FROM prices WHERE customer_id = ?
    `).all(customerId);

    prices.forEach(p => {
      if (p.product_id) byId[p.product_id] = p.price;
      if (p.product_slug) bySlug[p.product_slug] = p.price;
    });

    const result = { byId, bySlug };
    this._saleCache.set(cacheKey, result);
    return result;
  }

  /**
   * Get effective price cho sản phẩm
   */
  _getEffectivePrice(product, priceMap) {
    if (priceMap.byId[product.id] !== undefined) {
      return priceMap.byId[product.id];
    }
    if (product.slug && priceMap.bySlug[product.slug] !== undefined) {
      return priceMap.bySlug[product.slug];
    }
    return product.sell_price || product.price || 0;
  }

  /**
   * Update customer keg balance
   */
  _updateCustomerKegBalance(customerId, deliver, returnKegs) {
    db.prepare(`
      UPDATE customers SET keg_balance = keg_balance + ? - ? WHERE id = ?
    `).run(deliver, returnKegs, customerId);
  }

  /**
   * Sync keg inventory stats
   */
  _syncKegInventory() {
    const inventory = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get();
    const holding = db.prepare('SELECT COALESCE(SUM(keg_balance), 0) as t FROM customers').get();
    db.prepare(`
      UPDATE keg_stats SET inventory = ?, customer_holding = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1
    `).run(inventory.total, holding.t);
  }

  /**
   * Clear request cache (gọi sau mỗi request)
   */
  clearCache() {
    this._saleCache.clear();
  }
}

// ============================================================
// INVENTORY SERVICE - Business logic cho inventory
// ============================================================
class InventoryService {
  /**
   * Get stock summary
   */
  getStockSummary() {
    const products = db.prepare(`
      SELECT id, name, stock, damaged_stock, cost_price, sell_price, type
      FROM products WHERE archived = 0
    `).all();

    const totalStock = products.reduce((sum, p) => sum + (p.stock > 0 ? p.stock : 0), 0);
    const totalDamaged = products.reduce((sum, p) => sum + (p.damaged_stock || 0), 0);

    return { products, totalStock, totalDamaged };
  }

  /**
   * Import stock (nhập hàng)
   */
  import(data) {
    const { items, note } = data;
    if (!items || items.length === 0) {
      return { success: false, error: 'Danh sách trống' };
    }

    let totalAmount = 0;
    const createImport = db.transaction(() => {
      const date = db.getVietnamDateStr();
      const result = db.prepare(`
        INSERT INTO purchases (date, total_amount, note) VALUES (?, 0, ?)
      `).run(date, note || '');
      const purchaseId = result.lastInsertRowid;

      for (const item of items) {
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
        if (!product) continue;

        const totalPrice = item.quantity * item.unitPrice;
        totalAmount += totalPrice;

        db.prepare(`
          INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_price, total_price)
          VALUES (?, ?, ?, ?, ?)
        `).run(purchaseId, item.productId, item.quantity, item.unitPrice, totalPrice);

        // Update stock
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.productId);

        // Audit log
        db.prepare(`
          INSERT INTO product_audit_log (product_id, type, quantity, reason, ref_id, ref_type, note)
          VALUES (?, 'import', ?, 'purchase', ?, 'purchase', ?)
        `).run(item.productId, item.quantity, purchaseId, note || '');
      }

      // Update purchase total
      db.prepare('UPDATE purchases SET total_amount = ? WHERE id = ?').run(totalAmount, purchaseId);

      return purchaseId;
    });

    const purchaseId = createImport();
    return { success: true, purchaseId, totalAmount };
  }
}

// ============================================================
// DEBT SERVICE - Business logic cho công nợ
// ============================================================
class DebtService {
  /**
   * Lấy công nợ của tất cả khách hàng
   */
  getAllDebts(filters = {}) {
    let sql = `
      SELECT
        c.id, c.name, c.phone,
        c.debt,
        COALESCE(c.deposit, 0) as deposit,
        (SELECT COALESCE(SUM(total), 0) FROM sales
         WHERE customer_id = c.id AND status != 'returned' AND type = 'sale') as total_spent,
        (SELECT COALESCE(SUM(amount), 0) FROM payments
         WHERE customer_id = c.id) as total_paid,
        c.last_order_date,
        c.created_at
      FROM customers c
      WHERE c.archived = 0
    `;

    const params = [];

    // Filter: chỉ khách có nợ
    if (filters.hasDebt) {
      sql += ' AND c.debt > 0';
    }

    // Filter: khách quá hạn (nợ > 30 ngày không mua)
    if (filters.overdue) {
      sql += " AND c.debt > 0 AND (c.last_order_date IS NULL OR date(c.last_order_date) < date('now', '-30 days'))";
    }

    sql += ' ORDER BY c.debt DESC, c.name ASC';

    // Pagination
    if (filters.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
      if (filters.offset) {
        sql += ' OFFSET ?';
        params.push(filters.offset);
      }
    }

    return db.prepare(sql).all(...params);
  }

  /**
   * Lấy công nợ chi tiết của 1 khách
   */
  getCustomerDebt(customerId) {
    const customer = db.prepare(`
      SELECT * FROM customers WHERE id = ? AND archived = 0
    `).get(customerId);

    if (!customer) return null;

    // Lịch sử thanh toán
    const payments = db.prepare(`
      SELECT * FROM payments
      WHERE customer_id = ?
      ORDER BY date DESC
      LIMIT 50
    `).all(customerId);

    // Đơn hàng chưa thanh toán đầy đủ
    const unpaidSales = db.prepare(`
      SELECT id, date, total, profit, payment_status
      FROM sales
      WHERE customer_id = ? AND type = 'sale' AND archived = 0
      AND (payment_status != 'paid' OR payment_status IS NULL)
      ORDER BY date DESC
    `).all(customerId);

    return {
      customer,
      payments,
      unpaidSales,
      totalDebt: customer.debt || 0,
      totalPaid: payments.reduce((sum, p) => sum + p.amount, 0),
      totalSpent: unpaidSales.reduce((sum, s) => sum + s.total, 0)
    };
  }

  /**
   * Thêm thanh toán công nợ
   */
  addPayment(data) {
    const { customerId, amount, note } = data;

    if (!customerId || !amount || amount <= 0) {
      return { success: false, error: 'Dữ liệu không hợp lệ' };
    }

    // Verify customer
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) {
      return { success: false, error: 'Không tìm thấy khách hàng' };
    }

    const addPayment = db.transaction(() => {
      // Insert payment
      const date = db.getVietnamDateStr();
      const result = db.prepare(`
        INSERT INTO payments (customer_id, amount, date, note)
        VALUES (?, ?, ?, ?)
      `).run(customerId, amount, date, note || '');
      const paymentId = result.lastInsertRowid;

      // Update customer debt
      const newDebt = Math.max(0, (customer.debt || 0) - amount);
      db.prepare('UPDATE customers SET debt = ? WHERE id = ?').run(newDebt, customerId);

      return { paymentId, newDebt };
    });

    const result = addPayment();
    return { success: true, ...result };
  }

  /**
   * Tạo công nợ (khi bán chịu)
   */
  createDebt(data) {
    const { customerId, amount, saleId, note } = data;

    if (!customerId || !amount) {
      return { success: false, error: 'Dữ liệu không hợp lệ' };
    }

    const addDebt = db.transaction(() => {
      // Update customer debt
      db.prepare(`
        UPDATE customers SET debt = COALESCE(debt, 0) + ? WHERE id = ?
      `).run(amount, customerId);

      // Update sale payment_status
      if (saleId) {
        db.prepare(`
          UPDATE sales SET payment_status = 'partial' WHERE id = ? AND type = 'sale'
        `).run(saleId);
      }

      return { success: true };
    });

    return addDebt();
  }
}

// ============================================================
// PROMOTION SERVICE - Business logic cho khuyến mãi
// ============================================================
class PromotionService {
  /**
   * Lấy tất cả promotions đang active
   */
  getActivePromotions(date = null) {
    const targetDate = date || db.getVietnamDateStr();
    return db.prepare(`
      SELECT * FROM promotions
      WHERE active = 1
        AND (start_date IS NULL OR start_date <= ?)
        AND (end_date IS NULL OR end_date >= ?)
      ORDER BY priority DESC, created_at DESC
    `).all(targetDate, targetDate);
  }

  /**
   * Tính giảm giá cho 1 đơn hàng
   * @param {Object} cart - { customerId, items, subtotal }
   * @returns {Object} { discount, promotionsApplied, finalTotal }
   */
  calculateDiscount(cart) {
    const { customerId, subtotal } = cart;
    const activePromotions = this.getActivePromotions();

    let totalDiscount = 0;
    const promotionsApplied = [];

    for (const promo of activePromotions) {
      if (!this._isEligible(promo, cart)) continue;

      let discount = 0;

      if (promo.type === 'percentage') {
        // % giảm
        discount = Math.round(subtotal * (promo.value / 100));
        if (promo.max_discount && discount > promo.max_discount) {
          discount = promo.max_discount;
        }
      } else if (promo.type === 'fixed') {
        // Số tiền cố định
        discount = promo.value;
      } else if (promo.type === 'buy_x_get_y') {
        // Mua X tặng Y (tính giá trị Y)
        discount = this._calculateBuyXGetY(promo, cart);
      }

      if (discount > 0) {
        totalDiscount += discount;
        promotionsApplied.push({
          id: promo.id,
          name: promo.name,
          type: promo.type,
          value: promo.value,
          discount
        });
      }
    }

    return {
      discount: totalDiscount,
      promotionsApplied,
      finalTotal: Math.max(0, subtotal - totalDiscount)
    };
  }

  /**
   * Kiểm tra khách hàng có đủ điều kiện không
   */
  _isEligible(promo, cart) {
    // Check customer tier
    if (promo.customer_tier && promo.customer_tier !== 'all') {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(cart.customerId);
      if (!customer) return false;
      if (promo.customer_tier === 'vip' && customer.tier !== 'VIP') return false;
    }

    // Check min order value
    if (promo.min_order_value && cart.subtotal < promo.min_order_value) {
      return false;
    }

    // Check customer segments
    if (promo.customer_segments) {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(cart.customerId);
      if (!customer) return false;
      const segments = JSON.parse(promo.customer_segments);
      if (!segments.includes(customer.segment)) return false;
    }

    return true;
  }

  /**
   * Tính giảm giá mua X tặng Y
   */
  _calculateBuyXGetY(promo, cart) {
    const buyQty = promo.buy_quantity || 1;
    const getQty = promo.get_quantity || 1;
    const discountPerUnit = promo.value || 0;

    // Tìm sản phẩm áp dụng
    let eligibleQty = 0;
    for (const item of cart.items || []) {
      if (promo.product_id && item.productId !== promo.product_id) continue;
      eligibleQty += item.quantity;
    }

    // Số lần áp dụng = floor(eligibleQty / (buyQty + getQty))
    const times = Math.floor(eligibleQty / (buyQty + getQty));
    return times * getQty * discountPerUnit;
  }

  /**
   * Tạo promotion mới
   */
  create(data) {
    const { name, type, value, minOrderValue, maxDiscount,
            startDate, endDate, customerTier, customerSegments,
            productId, buyQuantity, getQuantity, active = 1, priority = 0 } = data;

    const createPromo = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO promotions
        (name, type, value, min_order_value, max_discount,
         start_date, end_date, customer_tier, customer_segments,
         product_id, buy_quantity, get_quantity, active, priority)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        name, type, value || 0, minOrderValue || null, maxDiscount || null,
        startDate || null, endDate || null, customerTier || null,
        customerSegments ? JSON.stringify(customerSegments) : null,
        productId || null, buyQuantity || null, getQuantity || null, active, priority
      );
      return result.lastInsertRowid;
    });

    return { success: true, promotionId: createPromo() };
  }
}

// ============================================================
// ANALYTICS SERVICE - Business logic cho báo cáo
// ============================================================
class AnalyticsService {
  /**
   * Dashboard summary - tất cả KPIs trong 1 query
   */
  getDashboardSummary(period = 'today') {
    const dates = this._getDateRange(period);
    const { startDate, endDate } = dates;

    // Batch query - lấy tất cả trong 1 transaction
    const getData = db.transaction(() => {
      // Revenue & Profit
      const revenue = db.prepare(`
        SELECT
          COALESCE(SUM(total), 0) as total,
          COALESCE(SUM(profit), 0) as profit,
          COUNT(*) as order_count
        FROM sales
        WHERE type = 'sale'
          AND (status IS NULL OR status != 'returned')
          AND archived = 0
          AND date(s.date) >= date(?)
          AND date(s.date) <= date(?)
      `).get(startDate, endDate);

      // Expenses
      const expenses = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM expenses
        WHERE date >= ? AND date <= ?
      `).get(startDate, endDate);

      // Top products
      const topProducts = db.prepare(`
        SELECT p.name, SUM(si.quantity) as qty, SUM(si.profit) as profit
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        JOIN products p ON p.id = si.product_id
        WHERE s.type = 'sale'
          AND (s.status IS NULL OR s.status != 'returned')
          AND date(s.date) >= date(?)
          AND date(s.date) <= date(?)
        GROUP BY p.id
        ORDER BY qty DESC
        LIMIT 5
      `).all(startDate, endDate);

      // Recent sales
      const recentSales = db.prepare(`
        SELECT s.*, COALESCE(c.name, 'Khách lẻ') as customer_name
        FROM sales s
        LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.type = 'sale'
          AND (s.status IS NULL OR s.status != 'returned')
          AND archived = 0
        ORDER BY datetime(s.date) DESC
        LIMIT 10
      `).all();

      // Low stock
      const lowStock = db.prepare(`
        SELECT * FROM products
        WHERE archived = 0 AND stock < 10
        ORDER BY stock ASC
        LIMIT 10
      `).all();

      return { revenue, expenses, topProducts, recentSales, lowStock };
    });

    const data = getData();

    return {
      period,
      startDate,
      endDate,
      revenue: data.revenue.total,
      profit: data.revenue.profit,
      orders: data.revenue.order_count,
      expenses: data.expenses.total,
      netProfit: data.revenue.profit - data.expenses.total,
      topProducts: data.topProducts,
      recentSales: data.recentSales,
      lowStock: data.lowStock
    };
  }

  /**
   * Get date range từ period
   */
  _getDateRange(period) {
    const today = db.getVietnamDateStr();
    let startDate, endDate = today;

    switch (period) {
      case 'today':
        startDate = today;
        break;
      case 'week':
        startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          .toISOString().split('T')[0];
        break;
      case 'month':
        const d = new Date();
        startDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
        break;
      case 'year':
        startDate = `${new Date().getFullYear()}-01-01`;
        break;
      default:
        startDate = today;
    }

    return { startDate, endDate };
  }
}

// ============================================================
// EXPORT
// ============================================================
module.exports = {
  SaleService: new SaleService(),
  InventoryService: new InventoryService(),
  DebtService: new DebtService(),
  PromotionService: new PromotionService(),
  AnalyticsService: new AnalyticsService()
};
