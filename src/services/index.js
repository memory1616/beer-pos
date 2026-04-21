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

const db = require('../../database');
const logger = require('../utils/logger');

function formatCurrency(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(amount || 0);
}

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
// DEBT SERVICE - Core business logic cho công nợ (v2)
// Đảm bảo: transaction, audit trail, không âm, idempotent
// ============================================================
class DebtService {
  // ── Core CRUD ────────────────────────────────────────────────

  /**
   * Tạo công nợ cho 1 đơn hàng (bán chịu)
   * @param {number} customerId
   * @param {number} amount - số tiền nợ
   * @param {number} saleId - ID đơn hàng
   * @param {string} note
   * @returns {{ success, debtTransactionId, orderDebtId, newDebt }}
   */
  createDebt(customerId, amount, saleId, note) {
    if (!customerId || !amount || amount <= 0) {
      return { success: false, error: 'Dữ liệu không hợp lệ' };
    }

    const tx = db.transaction(() => {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND archived = 0').get(customerId);
      if (!customer) {
        throw new Error('Không tìm thấy khách hàng');
      }

      const balanceBefore = customer.debt || 0;
      const balanceAfter = balanceBefore + amount;

      // 1. Ghi audit log
      const debtTxResult = db.prepare(`
        INSERT INTO debt_transactions (customer_id, type, amount, balance_before, balance_after, sale_id, note)
        VALUES (?, 'increase', ?, ?, ?, ?, ?)
      `).run(customerId, amount, balanceBefore, balanceAfter, saleId || null, note || `Nợ đơn hàng #${saleId}`);

      // 2. Cập nhật tổng nợ khách
      db.prepare('UPDATE customers SET debt = ? WHERE id = ?').run(balanceAfter, customerId);

      // 3. Tạo record order_debt nếu có saleId
      let orderDebtId = null;
      if (saleId) {
        // Kiểm tra đã có chưa (idempotent)
        const existing = db.prepare('SELECT id FROM order_debts WHERE sale_id = ?').get(saleId);
        if (!existing) {
          const odResult = db.prepare(`
            INSERT INTO order_debts (sale_id, customer_id, original_amount, remaining_amount, status)
            VALUES (?, ?, ?, ?, 'pending')
          `).run(saleId, customerId, amount, amount);
          orderDebtId = odResult.lastInsertRowid;

          // Cập nhật payment_status đơn hàng
          db.prepare("UPDATE sales SET payment_status = 'partial' WHERE id = ? AND type = 'sale'").run(saleId);
        } else {
          orderDebtId = existing.id;
        }
      }

      return { debtTransactionId: debtTxResult.lastInsertRowid, orderDebtId, newDebt: balanceAfter };
    });

    try {
      const result = tx();
      return { success: true, ...result };
    } catch (e) {
      logger.error('DebtService.createDebt error:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Thanh toán công nợ
   * @param {number} customerId
   * @param {number} amount - số tiền trả
   * @param {string} note
   * @param {number|null} saleId - nếu trả cho đơn cụ thể
   * @returns {{ success, paymentId, debtTransactionId, newDebt, appliedToSale }}
   */
  payDebt(customerId, amount, note, saleId = null) {
    if (!customerId || !amount || amount <= 0) {
      return { success: false, error: 'Dữ liệu không hợp lệ' };
    }

    const tx = db.transaction(() => {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND archived = 0').get(customerId);
      if (!customer) {
        throw new Error('Không tìm thấy khách hàng');
      }

      const balanceBefore = customer.debt || 0;
      const appliedAmount = Math.min(amount, balanceBefore); // Không trả quá nợ
      const balanceAfter = Math.max(0, balanceBefore - appliedAmount);

      // 1. Insert payment
      const paymentResult = db.prepare(`
        INSERT INTO payments (customer_id, amount, date, note)
        VALUES (?, ?, ?, ?)
      `).run(customerId, appliedAmount, db.getVietnamDateStr(), note || `Thu tiền${saleId ? ` đơn #${saleId}` : ''}`);
      const paymentId = paymentResult.lastInsertRowid;

      // 2. Ghi audit log
      const debtTxResult = db.prepare(`
        INSERT INTO debt_transactions (customer_id, type, amount, balance_before, balance_after, sale_id, payment_id, note)
        VALUES (?, 'decrease', ?, ?, ?, ?, ?, ?)
      `).run(customerId, -appliedAmount, balanceBefore, balanceAfter, saleId || null, paymentId, note || `Thu tiền${saleId ? ` đơn #${saleId}` : ''}`);
      const debtTransactionId = debtTxResult.lastInsertRowid;

      // 3. Cập nhật customer.debt
      db.prepare('UPDATE customers SET debt = ? WHERE id = ?').run(balanceAfter, customerId);

      // 4. Cập nhật order_debts nếu có saleId
      let appliedToSale = null;
      if (saleId) {
        const orderDebt = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleId);
        if (orderDebt) {
          const newPaid = orderDebt.paid_amount + appliedAmount;
          const newRemaining = Math.max(0, orderDebt.original_amount - newPaid);
          const status = newRemaining <= 0 ? 'paid' : 'partial';
          db.prepare('UPDATE order_debts SET paid_amount = ?, remaining_amount = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(newPaid, newRemaining, status, orderDebt.id);

          // Cập nhật sales.payment_status
          db.prepare("UPDATE sales SET payment_status = ? WHERE id = ?").run(status, saleId);
          appliedToSale = { saleId, newRemaining, status };
        }
      } else {
        // Trả không chỉ định đơn → phân bổ FIFO cho các đơn nợ
        const unpaidOrders = db.prepare(`
          SELECT * FROM order_debts WHERE customer_id = ? AND status != 'paid' ORDER BY created_at ASC
        `).all(customerId);

        let remaining = appliedAmount;
        for (const od of unpaidOrders) {
          if (remaining <= 0) break;
          const stillOwed = od.remaining_amount;
          const toApply = Math.min(remaining, stillOwed);
          const newPaid = od.paid_amount + toApply;
          const newRemaining = Math.max(0, od.original_amount - newPaid);
          const status = newRemaining <= 0 ? 'paid' : 'partial';
          db.prepare('UPDATE order_debts SET paid_amount = ?, remaining_amount = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(newPaid, newRemaining, status, od.id);
          db.prepare("UPDATE sales SET payment_status = ? WHERE id = ?").run(status, od.sale_id);
          remaining -= toApply;
          appliedToSale = { saleId: od.sale_id, newRemaining, status };
        }
      }

      return { paymentId, debtTransactionId, newDebt: balanceAfter, appliedAmount, appliedToSale };
    });

    try {
      const result = tx();
      return { success: true, ...result };
    } catch (e) {
      logger.error('DebtService.payDebt error:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Xoá đơn hàng → hoàn tiền công nợ đã ghi
   * @param {number} saleId
   * @returns {{ success, refundedAmount }}
   */
  reverseDebtForSale(saleId) {
    if (!saleId) {
      return { success: false, error: 'Thiếu saleId' };
    }

    const tx = db.transaction(() => {
      // Lấy order_debt record
      const orderDebt = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleId);
      if (!orderDebt) {
        return { success: true, refundedAmount: 0 }; // Không có nợ → không cần hoàn
      }

      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(orderDebt.customer_id);
      if (!customer) {
        throw new Error('Không tìm thấy khách hàng');
      }

      const refundAmount = orderDebt.remaining_amount; // Chỉ hoàn số còn nợ
      const balanceBefore = customer.debt || 0;
      const balanceAfter = Math.max(0, balanceBefore - refundAmount);

      // 1. Ghi audit log
      db.prepare(`
        INSERT INTO debt_transactions (customer_id, type, amount, balance_before, balance_after, sale_id, note)
        VALUES (?, 'cancel', ?, ?, ?, ?, ?)
      `).run(orderDebt.customer_id, -refundAmount, balanceBefore, balanceAfter, saleId, `Huỷ đơn #${saleId}, hoàn ${formatCurrency(refundAmount)}`);

      // 2. Cập nhật customer.debt
      db.prepare('UPDATE customers SET debt = ? WHERE id = ?').run(balanceAfter, orderDebt.customer_id);

      // 3. Xoá order_debt
      db.prepare('DELETE FROM order_debts WHERE sale_id = ?').run(saleId);

      // 4. Cập nhật sales.payment_status
      db.prepare("UPDATE sales SET payment_status = 'cancelled' WHERE id = ?").run(saleId);

      return { refundedAmount: refundAmount };
    });

    try {
      const result = tx();
      return { success: true, ...result };
    } catch (e) {
      logger.error('DebtService.reverseDebtForSale error:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Điều chỉnh công nợ thủ công (admin)
   * @param {number} customerId
   * @param {number} amount - số dương = thêm nợ, số âm = giảm nợ
   * @param {string} reason
   * @returns {{ success, newDebt }}
   */
  adjustDebt(customerId, amount, reason) {
    if (!customerId) {
      return { success: false, error: 'Thiếu customerId' };
    }

    const tx = db.transaction(() => {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND archived = 0').get(customerId);
      if (!customer) {
        throw new Error('Không tìm thấy khách hàng');
      }

      const balanceBefore = customer.debt || 0;
      let balanceAfter = balanceBefore + amount;
      if (balanceAfter < 0) balanceAfter = 0; // Không cho âm

      db.prepare(`
        INSERT INTO debt_transactions (customer_id, type, amount, balance_before, balance_after, note)
        VALUES (?, 'adjust', ?, ?, ?, ?)
      `).run(customerId, amount < 0 ? amount : -Math.abs(amount), balanceBefore, balanceAfter, reason || 'Điều chỉnh thủ công');

      db.prepare('UPDATE customers SET debt = ? WHERE id = ?').run(balanceAfter, customerId);
      return { newDebt: balanceAfter };
    });

    try {
      const result = tx();
      return { success: true, ...result };
    } catch (e) {
      logger.error('DebtService.adjustDebt error:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Tính lại công nợ từ đầu (verify/rebuild)
   * @param {number} customerId
   * @returns {{ success, calculatedDebt, actualDebt, diff }}
   */
  recalcDebt(customerId) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) return { success: false, error: 'Không tìm thấy khách' };

    const orderDebts = db.prepare('SELECT * FROM order_debts WHERE customer_id = ?').all(customerId);
    const calculatedDebt = orderDebts.reduce((sum, od) => sum + (od.remaining_amount || 0), 0);
    const actualDebt = customer.debt || 0;
    const diff = actualDebt - calculatedDebt;

    return { success: true, calculatedDebt, actualDebt, diff, orderDebts };
  }

  // ── Read methods ─────────────────────────────────────────────

  /**
   * Lấy tất cả khách có công nợ
   */
  getAllDebts(filters = {}) {
    let sql = `
      SELECT
        c.id, c.name, c.phone, c.tier,
        c.debt,
        COALESCE(c.deposit, 0) as deposit,
        c.last_order_date, c.created_at,
        (SELECT COUNT(*) FROM order_debts WHERE customer_id = c.id AND status != 'paid') as unpaid_orders
      FROM customers c
      WHERE c.archived = 0
    `;

    const params = [];
    if (filters.hasDebt) sql += ' AND c.debt > 0';
    if (filters.overdue) {
      sql += " AND c.debt > 0 AND (c.last_order_date IS NULL OR date(c.last_order_date) < date('now', '-30 days'))";
    }
    sql += ' ORDER BY c.debt DESC, c.name ASC';

    if (filters.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
      if (filters.offset) { sql += ' OFFSET ?'; params.push(filters.offset); }
    }

    return db.prepare(sql).all(...params);
  }

  /**
   * Lấy chi tiết công nợ 1 khách
   */
  getCustomerDebt(customerId) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND archived = 0').get(customerId);
    if (!customer) return null;

    const orderDebts = db.prepare('SELECT * FROM order_debts WHERE customer_id = ? ORDER BY created_at DESC').all(customerId);
    const payments = db.prepare('SELECT * FROM payments WHERE customer_id = ? ORDER BY date DESC LIMIT 50').all(customerId);
    const history = db.prepare(`
      SELECT * FROM debt_transactions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(customerId);

    return {
      customer,
      orderDebts,
      payments,
      history,
      totalDebt: customer.debt || 0,
      unpaidCount: orderDebts.filter(od => od.status !== 'paid').length
    };
  }

  /**
   * Lấy số đã trả cho 1 đơn cụ thể
   */
  getSalePayments(saleId) {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) return null;

    const orderDebt = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleId);
    const payments = db.prepare(`
      SELECT p.* FROM payments p
      JOIN debt_transactions dt ON dt.payment_id = p.id
      WHERE dt.sale_id = ?
      ORDER BY p.date DESC
    `).all(saleId);

    const totalPaid = orderDebt ? orderDebt.paid_amount : 0;
    const remaining = orderDebt ? orderDebt.remaining_amount : sale.total;

    return {
      sale,
      orderDebt,
      totalPaid,
      remaining,
      payments,
      customerDebt: sale.customer_id
        ? (db.prepare('SELECT debt FROM customers WHERE id = ?').get(sale.customer_id)?.debt || 0)
        : 0
    };
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
