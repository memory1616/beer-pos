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
// Bao gồm: khuyến mãi quán mới (30 ngày) và thưởng doanh số theo tháng
//
// QUY TẮC QUAN TRỌNG:
// - CHỈ NHẬN MỨC THƯỞNG CAO NHẤT: đã nhận 10L → đạt 500L → chỉ nhận thêm 10L
// - Free liters: trừ kho thật, KHÔNG cộng doanh thu, KHÔNG cộng công nợ, KHÔNG cộng sản lượng xét thưởng
// - Changing settings: KHÔNG làm sai dữ liệu cũ, KHÔNG reset history, KHÔNG recalculate order cũ
//   Chỉ áp dụng cho order mới
// ============================================================
class PromotionService {
  constructor() {
    this.NEW_SHOP_DAYS = 30;
    this.GOLD_BUY = 10;
    this.GOLD_FREE = 1;
    this.BLACK_BUY = 20;
    this.BLACK_FREE = 1;
    this.TIER_NONE = 'NONE';
    this.TIER_BONUS_10L = 'BONUS_10L';
    this.TIER_BONUS_20L = 'BONUS_20L';
  }

  // ── 0. SYSTEM PROMOTION SETTINGS ─────────────────────────

  /**
   * Lấy toàn bộ cấu hình khuyến mãi hệ thống
   * @returns {Object} promotion settings
   */
  getSystemPromotionSettings() {
    try {
      const settings = db.prepare('SELECT * FROM promotion_settings WHERE id = 1').get();
      if (!settings) {
        return this._getDefaultSettings();
      }
      return {
        newShopEnabled: !!settings.new_shop_enabled,
        newShopDays: settings.new_shop_days || 30,
        newShopGoldBuy: settings.new_shop_gold_buy || 10,
        newShopGoldFree: settings.new_shop_gold_free || 1,
        newShopBlackBuy: settings.new_shop_black_buy || 20,
        newShopBlackFree: settings.new_shop_black_free || 1,
        rewardEnabled: !!settings.reward_enabled,
        rewardTiers: this._parseRewardTiers(settings.reward_tiers),
        updatedAt: settings.updated_at
      };
    } catch (e) {
      logger.error('getSystemPromotionSettings error:', e);
      return this._getDefaultSettings();
    }
  }

  _getDefaultSettings() {
    return {
      newShopEnabled: true,
      newShopDays: 30,
      newShopGoldBuy: 10,
      newShopGoldFree: 1,
      newShopBlackBuy: 20,
      newShopBlackFree: 1,
      rewardEnabled: true,
      rewardTiers: [
        { threshold: 300, reward: 10 },
        { threshold: 500, reward: 20 }
      ],
      updatedAt: null
    };
  }

  _parseRewardTiers(tiersJson) {
    try {
      const tiers = JSON.parse(tiersJson || '[]');
      return tiers.sort((a, b) => a.threshold - b.threshold);
    } catch (e) {
      return [
        { threshold: 300, reward: 10 },
        { threshold: 500, reward: 20 }
      ];
    }
  }

  /**
   * Lưu cấu hình khuyến mãi hệ thống
   */
  saveSystemPromotionSettings(data) {
    const settings = this.getSystemPromotionSettings();
    const merged = { ...settings, ...data };

    const newShopEnabled = merged.newShopEnabled ? 1 : 0;
    const rewardEnabled = merged.rewardEnabled ? 1 : 0;
    const rewardTiers = JSON.stringify(merged.rewardTiers || []);

    db.prepare(`
      UPDATE promotion_settings SET
        new_shop_enabled = ?,
        new_shop_days = ?,
        new_shop_gold_buy = ?,
        new_shop_gold_free = ?,
        new_shop_black_buy = ?,
        new_shop_black_free = ?,
        reward_enabled = ?,
        reward_tiers = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(
      newShopEnabled,
      merged.newShopDays || 30,
      merged.newShopGoldBuy || 10,
      merged.newShopGoldFree || 1,
      merged.newShopBlackBuy || 20,
      merged.newShopBlackFree || 1,
      rewardEnabled,
      rewardTiers
    );

    logger.info('[PromotionService] Saved system promotion settings');
    return this.getSystemPromotionSettings();
  }

  // ── 1. KHUYẾN MÃI QUÁN MỚI ──────────────────────────────

  /**
   * Kiểm tra khách hàng có phải "quán mới" (tạo trong N ngày đầu, config được)
   * Dùng created_at thay vì first_order_date
   */
  isNewShopEligible(customerId) {
    const settings = this.getSystemPromotionSettings();
    if (!settings.newShopEnabled) {
      return { eligible: false, reason: 'Khuyến mãi quán mới đã bị tắt' };
    }

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) return { eligible: false, reason: 'Không tìm thấy khách hàng' };

    if (customer.promotion_enabled === 0) {
      return { eligible: false, reason: 'Khách đã tắt tham gia CTKM', promotionEnabled: false };
    }

    const createdDate = new Date(customer.created_at);
    const now = new Date();
    const diffTime = now.getTime() - createdDate.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    const daysRemaining = settings.newShopDays - diffDays;

    if (daysRemaining > 0) {
      return {
        eligible: true,
        daysRemaining,
        firstOrderDate: customer.created_at,
        newShopDays: settings.newShopDays,
        promotionEnabled: true
      };
    }
    return { eligible: false, daysRemaining: 0, reason: 'Đã hết hạn ưu đãi quán mới', promotionEnabled: true };
  }

  /**
   * Kiểm tra khách có đang trong thời gian quán mới (dùng cho trường hợp không muốn áp dụng thưởng tháng)
   * @returns {boolean} true nếu khách đang trong thời gian quán mới
   */
  isInNewShopPeriod(customerId) {
    const newShopInfo = this.isNewShopEligible(customerId);
    return newShopInfo.eligible && newShopInfo.daysRemaining > 0;
  }

  /**
   * Tính lít được tặng cho quán mới theo từng loại bia
   * @param {number} quantityGold - số lít bia vàng mua
   * @param {number} quantityBlack - số lít bia đen mua
   * @returns {{ freeGold, freeBlack, totalFree, promoType }}
   */
  calculateNewShopPromotion(quantityGold = 0, quantityBlack = 0) {
    const settings = this.getSystemPromotionSettings();
    if (!settings.newShopEnabled) {
      return { freeGold: 0, freeBlack: 0, totalFree: 0, promoType: null };
    }

    const freeGold = Math.floor(quantityGold / settings.newShopGoldBuy) * settings.newShopGoldFree;
    const freeBlack = Math.floor(quantityBlack / settings.newShopBlackBuy) * settings.newShopBlackFree;
    return {
      freeGold,
      freeBlack,
      totalFree: freeGold + freeBlack,
      promoType: 'NEW_SHOP'
    };
  }

  // ── 2. THƯỞNG DOANH SỐ THÁNG ────────────────────────────

  /**
   * Tính sản lượng tháng hiện tại (CHỈ tính lít MUA thực trả, KHÔNG tính lít tặng)
   * Bia tặng khuyến mãi có si.price = 0 nên được lọc ra
   * LUÔN query real-time để đảm bảo đúng sau khi sửa/xóa đơn hàng
   * CHỈ tính: keg (bia vàng/đen) và pet (bia chai nhựa), KHÔNG tính bottle
   */
  calculateMonthlyPurchasedLiters(customerId) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    // Luôn query real-time từ sale_items để đảm bảo data mới nhất
    // Chỉ tính keg và pet, không tính bottle
    const result = db.prepare(`
      SELECT COALESCE(SUM(si.quantity), 0) as total
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      JOIN products p ON p.id = si.product_id
      WHERE s.customer_id = ?
        AND s.type = 'sale'
        AND s.archived = 0
        AND s.promo_type IS DISTINCT FROM 'MONTHLY_BONUS'
        AND si.price > 0
        AND p.type IN ('keg', 'pet')
        AND strftime('%Y', s.date) = ?
        AND strftime('%m', s.date) = ?
    `).get(customerId, String(year), String(month).padStart(2, '0'));

    return result ? result.total : 0;
  }

  /**
   * Lấy reward tier cao nhất mà khách đã nhận (từ lịch sử)
   * @returns {number} Số lít reward cao nhất đã nhận
   */
  _getHighestRewardClaimed(customerId) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const history = db.prepare(`
      SELECT reward_claimed_liters FROM customer_monthly_stats
      WHERE customer_id = ? AND year = ? AND month = ? AND reward_claimed = 1
    `).get(customerId, year, month);

    return history ? (history.reward_claimed_liters || 0) : 0;
  }

  /**
   * Xác định reward tier dựa trên sản lượng tháng
   * QUY TẮC: CHỈ NHẬN MỨC CAO NHẤT - đã nhận 10L → đạt 500L → chỉ nhận thêm 10L
   * @returns {{ tier, liters, nextTier, nextTierLiters, progressToNext, litersToNext }}
   */
  calculateMonthlyReward(customerId) {
    const settings = this.getSystemPromotionSettings();
    if (!settings.rewardEnabled) {
      return {
        tier: this.TIER_NONE,
        liters: 0,
        nextTier: null,
        nextTierLiters: 0,
        progressToNext: 0,
        litersToNext: 0,
        totalRewardEarned: 0,
        remainingReward: 0
      };
    }

    // Nếu khách tắt CTKM thì không có thưởng
    const customer = db.prepare('SELECT promotion_enabled FROM customers WHERE id = ?').get(customerId);
    if (customer && customer.promotion_enabled === 0) {
      return {
        tier: this.TIER_NONE,
        liters: 0,
        nextTier: null,
        nextTierLiters: 0,
        progressToNext: 0,
        litersToNext: 0,
        totalRewardEarned: 0,
        remainingReward: 0
      };
    }

    const liters = this.calculateMonthlyPurchasedLiters(customerId);
    const tiers = settings.rewardTiers;

    // Tìm tier cao nhất đạt được
    let eligibleTier = null;
    for (let i = tiers.length - 1; i >= 0; i--) {
      if (liters >= tiers[i].threshold) {
        eligibleTier = tiers[i];
        break;
      }
    }

    // Lấy tier cao nhất đã nhận
    const claimedLiters = this._getHighestRewardClaimed(customerId);
    const nextTierInfo = this._getNextTier(tiers, liters);

    if (eligibleTier) {
      const remainingReward = Math.max(0, eligibleTier.reward - claimedLiters);
      return {
        tier: eligibleTier.tier || `BONUS_${eligibleTier.reward}L`,
        liters: eligibleTier.reward,
        nextTier: nextTierInfo ? (nextTierInfo.tier || `BONUS_${nextTierInfo.reward}L`) : null,
        nextTierLiters: nextTierInfo ? nextTierInfo.threshold : 0,
        progressToNext: nextTierInfo
          ? Math.min(100, Math.round((liters / nextTierInfo.threshold) * 100))
          : 100,
        litersToNext: nextTierInfo ? Math.max(0, nextTierInfo.threshold - liters) : 0,
        totalRewardEarned: claimedLiters,
        remainingReward,
        monthlyLiters: liters,
        hasRemaining: remainingReward > 0
      };
    }

    return {
      tier: this.TIER_NONE,
      liters: 0,
      nextTier: tiers.length > 0 ? (tiers[0].tier || `BONUS_${tiers[0].reward}L`) : null,
      nextTierLiters: tiers.length > 0 ? tiers[0].threshold : 0,
      progressToNext: tiers.length > 0 ? Math.round((liters / tiers[0].threshold) * 100) : 0,
      litersToNext: tiers.length > 0 ? Math.max(0, tiers[0].threshold - liters) : 0,
      totalRewardEarned: claimedLiters,
      remainingReward: 0,
      monthlyLiters: liters,
      hasRemaining: false
    };
  }

  _getNextTier(tiers, currentLiters) {
    for (const tier of tiers) {
      if (tier.threshold > currentLiters) {
        return tier;
      }
    }
    return null; // Đã đạt tier cao nhất
  }

  /**
   * Lấy thưởng cao nhất khách có thể nhận (tier hiện tại - đã nhận)
   * @returns {number} Số lít còn lại có thể nhận
   */
  getHighestEligibleReward(customerId) {
    const reward = this.calculateMonthlyReward(customerId);
    return {
      tier: reward.tier,
      eligibleLiters: reward.liters,
      alreadyClaimed: reward.totalRewardEarned,
      remaining: reward.remainingReward,
      hasRemaining: reward.hasRemaining
    };
  }

  /**
   * Lấy số lít thưởng còn lại khách có thể nhận
   * @returns {number} Số lít còn lại
   */
  getRemainingReward(customerId) {
    const reward = this.calculateMonthlyReward(customerId);
    return reward.remainingReward;
  }

  // ── 3. NHẬN THƯỞNG ──────────────────────────────────────

  /**
   * Lấy thông tin reward hiện tại của khách (từ DB)
   */
  getRewardStatus(customerId) {
    const customer = db.prepare('SELECT reward_tier, reward_claimed, reward_claimed_at FROM customers WHERE id = ?').get(customerId);
    if (!customer) return null;

    const monthlyLiters = this.calculateMonthlyPurchasedLiters(customerId);
    const rewardInfo = this.calculateMonthlyReward(customerId);

    return {
      tier: customer.reward_tier || this.TIER_NONE,
      claimed: customer.reward_claimed === 1,
      claimedAt: customer.reward_claimed_at,
      monthlyLiters,
      ...rewardInfo
    };
  }

  /**
   * Nhận thưởng: tạo phiếu xuất kho 0đ + trừ kho
   * INVENTORY RULES: trừ kho thật, KHÔNG cộng doanh thu, KHÔNG cộng công nợ
   * @returns {{ success, saleId, rewardLiters, tier }}
   */
  claimMonthlyReward(customerId, productId) {
    const status = this.getRewardStatus(customerId);
    if (!status) return { success: false, error: 'Không tìm thấy khách hàng' };
    if (!status.hasRemaining) return { success: false, error: 'Đã nhận đủ thưởng hoặc chưa đủ điều kiện' };

    const rewardLiters = status.remainingReward;
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const tx = db.transaction(() => {
      // 1. Tạo phiếu xuất kho thưởng (sale type='sale', total=0)
      // KHÔNG cộng doanh thu, KHÔNG cộng công nợ
      const saleDate = db.getVietnamDateStr();
      const result = db.prepare(`
        INSERT INTO sales (customer_id, date, total, profit, type, promo_type, reward_liters_used, note)
        VALUES (?, ?, ?, 0, 'sale', 'MONTHLY_BONUS', ?, ?)
      `).run(customerId, saleDate, 0, rewardLiters, `Thưởng doanh số tháng ${rewardLiters}L miễn phí`);

      const saleId = result.lastInsertRowid;

      // 2. Ghi nhận chi tiết sản phẩm thưởng (price=0, profit=0)
      db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price, profit)
        VALUES (?, ?, ?, 0, 0, 0)
      `).run(saleId, productId, rewardLiters);

      // 3. TRỪ KHO SẢN PHẨM (inventory rule: trừ kho thật)
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(rewardLiters, productId);

      // 4. Audit log (export, KHÔNG cộng doanh thu)
      const customer = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId);
      db.prepare(`
        INSERT INTO product_audit_log (product_id, type, quantity, reason, ref_id, ref_type, customer_name, note)
        VALUES (?, 'export', ?, 'reward', ?, 'sale', ?, ?)
      `).run(productId, rewardLiters, saleId, customer?.name || '', `Thưởng doanh số tháng`);

      // 5. Ghi reward_history
      db.prepare(`
        INSERT INTO reward_history (customer_id, reward_tier, reward_liters, note)
        VALUES (?, ?, ?, ?)
      `).run(customerId, status.tier, rewardLiters, `Nhận thưởng tháng ${month}/${year} - lần tiếp theo`);

      // 6. Cập nhật customer_monthly_stats
      const existingStats = db.prepare(`
        SELECT * FROM customer_monthly_stats WHERE customer_id = ? AND year = ? AND month = ?
      `).get(customerId, year, month);

      if (existingStats) {
        const newClaimed = (existingStats.reward_claimed_liters || 0) + rewardLiters;
        db.prepare(`
          UPDATE customer_monthly_stats SET
            reward_claimed = 1,
            reward_claimed_at = CURRENT_TIMESTAMP,
            reward_claimed_liters = ?,
            reward_claimed_sale_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(newClaimed, saleId, existingStats.id);
      } else {
        db.prepare(`
          INSERT INTO customer_monthly_stats
            (customer_id, year, month, reward_claimed, reward_claimed_at, reward_claimed_liters, reward_claimed_sale_id)
          VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?)
        `).run(customerId, year, month, rewardLiters, saleId);
      }

      return { saleId, rewardLiters, tier: status.tier };
    });

    try {
      const result = tx();
      logger.info(`[PromotionService] Reward claimed: customer=${customerId}, liters=${result.rewardLiters}, tier=${result.tier}`);
      return { success: true, ...result };
    } catch (e) {
      logger.error('claimMonthlyReward error:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Claim reward với logic "chỉ nhận mức cao nhất" - overload của claimMonthlyReward
   * Sử dụng khi cần tính lại claim logic
   */
  claimHighestReward(customerId, productId) {
    const remaining = this.getRemainingReward(customerId);
    if (remaining <= 0) {
      return { success: false, error: 'Không còn thưởng để nhận' };
    }
    return this.claimMonthlyReward(customerId, productId);
  }

  /**
   * Tự động trả thưởng cho đơn hàng đầu tiên trong tháng
   * Thưởng dựa trên sản lượng tháng TRƯỚC (tháng trả thưởng)
   * Ví dụ: tháng 5 đạt 500L → đơn hàng đầu tiên tháng 6 sẽ được thưởng
   * @returns {{ success, saleId, rewardLiters, tier } | null}
   */
  autoClaimMonthlyReward(customerId) {
    const settings = this.getSystemPromotionSettings();
    if (!settings.rewardEnabled) return null;

    // Kiểm tra khách có bật CTKM không
    const customer = db.prepare('SELECT promotion_enabled FROM customers WHERE id = ?').get(customerId);
    if (customer && customer.promotion_enabled === 0) return null;

    // Xác định tháng trả thưởng (tháng trước)
    const now = new Date();
    const rewardMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1); // Tháng trước
    const rewardYear = rewardMonth.getFullYear();
    const rewardMonthNum = rewardMonth.getMonth() + 1;
    const rewardMonthStr = String(rewardMonthNum).padStart(2, '0');
    const rewardMonthStart = `${rewardYear}-${rewardMonthStr}-01`;

    // Tính sản lượng của khách trong tháng trả thưởng
    const purchasedLiters = db.prepare(`
      SELECT COALESCE(SUM(si.quantity), 0) as total
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      JOIN products p ON p.id = si.product_id
      WHERE s.customer_id = ?
        AND s.type = 'sale'
        AND s.archived = 0
        AND s.promo_type IS DISTINCT FROM 'MONTHLY_BONUS'
        AND si.price > 0
        AND p.type = 'keg'
        AND strftime('%Y', datetime(s.date, '+7 hours')) = ?
        AND strftime('%m', datetime(s.date, '+7 hours')) = ?
    `).get(customerId, String(rewardYear), rewardMonthStr);

    const liters = purchasedLiters ? purchasedLiters.total : 0;

    // Tìm tier cao nhất đạt được trong tháng trả thưởng
    const tiers = settings.rewardTiers || [];
    let eligibleTier = null;
    for (let i = tiers.length - 1; i >= 0; i--) {
      if (liters >= tiers[i].threshold) {
        eligibleTier = tiers[i];
        break;
      }
    }

    if (!eligibleTier) return null; // Không đạt mốc nào

    // Kiểm tra đã nhận thưởng tháng trả thưởng chưa
    const alreadyClaimed = db.prepare(`
      SELECT COUNT(*) as cnt FROM sales
      WHERE customer_id = ?
        AND type = 'sale'
        AND archived = 0
        AND promo_type = 'MONTHLY_BONUS'
        AND strftime('%Y', datetime(date, '+7 hours')) = ?
        AND strftime('%m', datetime(date, '+7 hours')) = ?
    `).get(customerId, String(rewardYear), rewardMonthStr);

    if (alreadyClaimed && alreadyClaimed.cnt > 0) return null; // Đã nhận rồi

    // Kiểm tra đơn hàng đầu tiên trong tháng hiện tại
    const currentYear = now.getFullYear();
    const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
    const currentMonthStart = `${currentYear}-${currentMonth}-01`;

    const orderCount = db.prepare(`
      SELECT COUNT(*) as cnt FROM sales
      WHERE customer_id = ?
        AND type = 'sale'
        AND archived = 0
        AND promo_type IS DISTINCT FROM 'MONTHLY_BONUS'
        AND datetime(date, '+7 hours') >= ?
    `).get(customerId, currentMonthStart);

    if (!orderCount || orderCount.cnt > 1) return null; // Không phải đơn đầu

    console.log(`[AUTO REWARD] Tháng ${rewardMonthStr}/${rewardYear} khách ${customerId} đạt ${liters}L → thưởng ${eligibleTier.reward}L`);

    // Lấy sản phẩm bia vàng mặc định để xuất thưởng
    const defaultProduct = db.prepare(`
      SELECT id, name, slug, cost_price FROM products
      WHERE archived = 0 AND type = 'keg'
        AND (name LIKE '%Vàng%' OR name LIKE '%VANG%' OR name LIKE '%vàng%' OR name LIKE '%Gold%' OR name LIKE '%gold%')
        AND (name NOT LIKE '%Đen%' AND name NOT LIKE '%DEN%' AND name NOT LIKE '%den%')
      ORDER BY id ASC LIMIT 1
    `).get();

    if (!defaultProduct) {
      const anyProduct = db.prepare('SELECT id, name, slug, cost_price FROM products WHERE archived = 0 AND type = \'keg\' ORDER BY id ASC LIMIT 1').get();
      if (!anyProduct) return null;
      return this.claimMonthlyReward(customerId, anyProduct.id);
    }

    return this.claimMonthlyReward(customerId, defaultProduct.id);
  }

  /**
   * Lấy thông tin thưởng dựa trên sản lượng tháng trước
   * @returns {{ eligible, rewardLiters, tier, alreadyClaimed }}
   */
  getRewardForPrevMonth(customerId) {
    const settings = this.getSystemPromotionSettings();
    if (!settings.rewardEnabled) return { eligible: false, rewardLiters: 0, tier: null, alreadyClaimed: false };

    const customer = db.prepare('SELECT promotion_enabled FROM customers WHERE id = ?').get(customerId);
    if (customer && customer.promotion_enabled === 0) return { eligible: false, rewardLiters: 0, tier: null, alreadyClaimed: false };

    // Tháng trả thưởng (tháng trước)
    const now = new Date();
    const rewardMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const rewardYear = rewardMonth.getFullYear();
    const rewardMonthNum = rewardMonth.getMonth() + 1;
    const rewardMonthStr = String(rewardMonthNum).padStart(2, '0');

    // Tính sản lượng tháng trước
    const purchasedLiters = db.prepare(`
      SELECT COALESCE(SUM(si.quantity), 0) as total
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      JOIN products p ON p.id = si.product_id
      WHERE s.customer_id = ?
        AND s.type = 'sale'
        AND s.archived = 0
        AND s.promo_type IS DISTINCT FROM 'MONTHLY_BONUS'
        AND si.price > 0
        AND p.type = 'keg'
        AND strftime('%Y', datetime(s.date, '+7 hours')) = ?
        AND strftime('%m', datetime(s.date, '+7 hours')) = ?
    `).get(customerId, String(rewardYear), rewardMonthStr);

    const liters = purchasedLiters ? purchasedLiters.total : 0;

    // Tìm tier cao nhất
    const tiers = settings.rewardTiers || [];
    let eligibleTier = null;
    for (let i = tiers.length - 1; i >= 0; i--) {
      if (liters >= tiers[i].threshold) {
        eligibleTier = tiers[i];
        break;
      }
    }

    if (!eligibleTier) return { eligible: false, rewardLiters: 0, tier: null, alreadyClaimed: false };

    // Kiểm tra đã nhận thưởng tháng trước chưa
    const alreadyClaimed = db.prepare(`
      SELECT COUNT(*) as cnt FROM reward_history
      WHERE customer_id = ?
        AND note LIKE ?
    `).get(customerId, `%tháng ${rewardMonthNum}/${rewardYear}%`);

    const claimed = alreadyClaimed && alreadyClaimed.cnt > 0;

    return {
      eligible: !claimed,
      rewardLiters: eligibleTier.reward,
      tier: eligibleTier.tier || `BONUS_${eligibleTier.reward}L`,
      alreadyClaimed: claimed
    };
  }

  /**
   * Gắn thưởng vào đơn hàng hiện tại (thay vì tạo đơn riêng)
   * Dùng cho đơn hàng đầu tiên của tháng
   * @param {number} customerId - ID khách hàng
   * @param {number} saleId - ID đơn hàng hiện tại để gắn thưởng
   * @param {number} rewardLiters - Số lít thưởng
   * @param {string} tier - Tier thưởng
   * @returns {{ success, saleId, rewardLiters, tier }}
   */
  attachRewardToSale(customerId, saleId, rewardLiters, tier) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    // Lấy sản phẩm bia vàng mặc định
    const defaultProduct = db.prepare(`
      SELECT id, name, slug, cost_price FROM products
      WHERE archived = 0 AND type = 'keg'
        AND (name LIKE '%Vàng%' OR name LIKE '%VANG%' OR name LIKE '%vàng%' OR name LIKE '%Gold%' OR name LIKE '%gold%')
        AND (name NOT LIKE '%Đen%' AND name NOT LIKE '%DEN%' AND name NOT LIKE '%den%')
      ORDER BY id ASC LIMIT 1
    `).get();

    if (!defaultProduct) {
      const anyProduct = db.prepare('SELECT id FROM products WHERE archived = 0 AND type = \'keg\' ORDER BY id ASC LIMIT 1').get();
      if (!anyProduct) return { success: false, error: 'Không tìm thấy sản phẩm' };
      return this._doAttachReward(customerId, saleId, anyProduct.id, rewardLiters, tier, year, month);
    }

    return this._doAttachReward(customerId, saleId, defaultProduct.id, rewardLiters, tier, year, month);
  }

  _doAttachReward(customerId, saleId, productId, rewardLiters, tier, year, month) {
    const tx = db.transaction(() => {
      // 1. Thêm item vào sale hiện tại (price=0)
      db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, quantity, price, cost_price, profit)
        VALUES (?, ?, ?, 0, 0, 0)
      `).run(saleId, productId, rewardLiters);

      // 2. TRỪ KHO
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(rewardLiters, productId);

      // 3. Cập nhật total và profit của sale (thưởng = 0 nên không cộng)
      // Chỉ cập nhật deliver_kegs thêm rewardLiters
      db.prepare('UPDATE sales SET deliver_kegs = deliver_kegs + ? WHERE id = ?').run(rewardLiters, saleId);

      // 4. Audit log
      const customer = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId);
      db.prepare(`
        INSERT INTO product_audit_log (product_id, type, quantity, reason, ref_id, ref_type, customer_name, note)
        VALUES (?, 'export', ?, 'reward', ?, 'sale', ?, ?)
      `).run(productId, rewardLiters, saleId, customer?.name || '', `Thưởng doanh số tháng ${month}/${year}`);

      // 5. Ghi reward_history
      db.prepare(`
        INSERT INTO reward_history (customer_id, reward_tier, reward_liters, note)
        VALUES (?, ?, ?, ?)
      `).run(customerId, tier, rewardLiters, `Tự động thưởng tháng ${month}/${year} - đơn đầu tiên`);

      // 6. Cập nhật customer_monthly_stats
      const existingStats = db.prepare(`
        SELECT * FROM customer_monthly_stats WHERE customer_id = ? AND year = ? AND month = ?
      `).get(customerId, year, month);

      if (existingStats) {
        const newClaimed = (existingStats.reward_claimed_liters || 0) + rewardLiters;
        db.prepare(`
          UPDATE customer_monthly_stats SET
            reward_claimed = 1,
            reward_claimed_at = CURRENT_TIMESTAMP,
            reward_claimed_liters = ?,
            reward_claimed_sale_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(newClaimed, saleId, existingStats.id);
      } else {
        db.prepare(`
          INSERT INTO customer_monthly_stats
            (customer_id, year, month, reward_claimed, reward_claimed_at, reward_claimed_liters, reward_claimed_sale_id)
          VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?)
        `).run(customerId, year, month, rewardLiters, saleId);
      }

      return { saleId, rewardLiters, tier };
    });

    try {
      const result = tx();
      logger.info(`[PromotionService] Reward attached to sale: customer=${customerId}, sale=${saleId}, liters=${rewardLiters}, tier=${tier}`);
      return { success: true, ...result };
    } catch (e) {
      logger.error('attachRewardToSale error:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Reset reward tháng mới (gọi khi sang tháng)
   * Tự động reset vào ngày 1 hàng tháng qua cron
   */
  resetMonthlyRewards() {
    const tx = db.transaction(() => {
      // Reset customer_monthly_stats cho tháng mới
      const now = new Date();
      const newYear = now.getFullYear();
      const newMonth = now.getMonth() + 1;

      // Tạo monthly_stats cho tất cả khách active tháng mới
      const customers = db.prepare('SELECT id FROM customers WHERE archived = 0').all();
      for (const cust of customers) {
        const existing = db.prepare(`
          SELECT id FROM customer_monthly_stats WHERE customer_id = ? AND year = ? AND month = ?
        `).get(cust.id, newYear, newMonth);

        if (!existing) {
          db.prepare(`
            INSERT INTO customer_monthly_stats (customer_id, year, month, purchased_liters)
            VALUES (?, ?, ?, 0)
          `).run(cust.id, newYear, newMonth);
        }
      }

      logger.info(`[PromotionService] Monthly rewards reset for ${customers.length} customers`);
    });
    tx();
  }

  /**
   * Cập nhật sản lượng tháng cho customer (gọi sau mỗi đơn hàng mới)
   */
  updateCustomerMonthlyStats(customerId, purchasedLiters, year, month) {
    const existing = db.prepare(`
      SELECT * FROM customer_monthly_stats WHERE customer_id = ? AND year = ? AND month = ?
    `).get(customerId, year, month);

    if (existing) {
      db.prepare(`
        UPDATE customer_monthly_stats SET
          purchased_liters = purchased_liters + ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(purchasedLiters, existing.id);
    } else {
      db.prepare(`
        INSERT INTO customer_monthly_stats (customer_id, year, month, purchased_liters)
        VALUES (?, ?, ?, ?)
      `).run(customerId, year, month, purchasedLiters);
    }
  }

  // ── 4. LỊCH SỬ THƯỞNG ──────────────────────────────────

  /**
   * Lấy lịch sử nhận thưởng của 1 khách
   */
  getRewardHistory(customerId) {
    return db.prepare(`
      SELECT rh.*, c.name as customer_name
      FROM reward_history rh
      JOIN customers c ON c.id = rh.customer_id
      WHERE rh.customer_id = ?
      ORDER BY rh.claimed_at DESC
    `).all(customerId);
  }

  /**
   * Lấy tổng thưởng đã nhận trong tháng
   */
  getMonthlyRewardSummary(year, month) {
    const y = String(year);
    const m = String(month).padStart(2, '0');
    const result = db.prepare(`
      SELECT COALESCE(SUM(reward_liters), 0) as total_liters,
             COUNT(*) as total_claims
      FROM reward_history
      WHERE strftime('%Y', claimed_at) = ? AND strftime('%m', claimed_at) = ?
    `).get(y, m);
    return result || { total_liters: 0, total_claims: 0 };
  }

  // ── 5. STATS PROMOTION ──────────────────────────────────

  /**
   * Lấy số quán mới đang trong N ngày ưu đãi (dựa trên created_at)
   */
  getActiveNewShopCount() {
    const settings = this.getSystemPromotionSettings();
    if (!settings.newShopEnabled) return 0;

    const cutoffStr = new Date(Date.now() - settings.newShopDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const result = db.prepare(`
      SELECT COUNT(*) as count
      FROM customers
      WHERE archived = 0
        AND created_at >= ?
        AND promotion_enabled = 1
    `).get(cutoffStr);
    return result ? result.count : 0;
  }

  /**
   * Top khách gần đạt mốc tiếp theo
   */
  getNearRewardCustomers(limit = 10) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const settings = this.getSystemPromotionSettings();
    const tiers = settings.rewardTiers;

    if (!settings.rewardEnabled || tiers.length === 0) return [];

    return db.prepare(`
      SELECT
        c.id, c.name, c.phone,
        COALESCE(cms.purchased_liters, 0) as monthly_liters,
        COALESCE(cms.reward_claimed_liters, 0) as claimed_liters
      FROM customers c
      LEFT JOIN customer_monthly_stats cms ON cms.customer_id = c.id AND cms.year = ? AND cms.month = ?
      WHERE c.archived = 0 AND c.promotion_enabled = 1
      ORDER BY COALESCE(cms.purchased_liters, 0) DESC
      LIMIT ?
    `).all(String(year), month, limit);
  }

  // ── 6. LEGACY PROMOTION METHODS ─────────────────────────

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
        discount = Math.round(subtotal * (promo.value / 100));
        if (promo.max_discount && discount > promo.max_discount) {
          discount = promo.max_discount;
        }
      } else if (promo.type === 'fixed') {
        discount = promo.value;
      } else if (promo.type === 'buy_x_get_y') {
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

  _isEligible(promo, cart) {
    if (promo.customer_tier && promo.customer_tier !== 'all') {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(cart.customerId);
      if (!customer) return false;
      if (promo.customer_tier === 'vip' && customer.tier !== 'VIP') return false;
    }

    if (promo.min_order_value && cart.subtotal < promo.min_order_value) {
      return false;
    }

    if (promo.customer_segments) {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(cart.customerId);
      if (!customer) return false;
      const segments = JSON.parse(promo.customer_segments);
      if (!segments.includes(customer.segment)) return false;
    }

    return true;
  }

  _calculateBuyXGetY(promo, cart) {
    const buyQty = promo.buy_quantity || 1;
    const getQty = promo.get_quantity || 1;
    const discountPerUnit = promo.value || 0;

    let eligibleQty = 0;
    for (const item of cart.items || []) {
      if (item.type && item.type !== 'keg') continue;
      if (promo.product_id && item.productId !== promo.product_id) continue;
      eligibleQty += item.quantity;
    }

    const times = Math.floor(eligibleQty / (buyQty + getQty));
    return times * getQty * discountPerUnit;
  }

  /**
   * Ghi nhận first_order_date khi khách đặt đơn đầu tiên
   */
  setFirstOrderDate(customerId) {
    const customer = db.prepare('SELECT first_order_date FROM customers WHERE id = ?').get(customerId);
    if (customer && !customer.first_order_date) {
      db.prepare("UPDATE customers SET first_order_date = datetime('now', '+7 hours') WHERE id = ?").run(customerId);
    }
  }

  /**
   * Xác định loại bia (vàng/đen) dựa trên tên sản phẩm
   */
  classifyBeer(productName) {
    if (!productName) return 'gold';
    const name = productName.toLowerCase();
    const blackKeywords = ['guinness', 'kilkenny', 'murphy', 'black', 'đen', 'smithwick'];
    return blackKeywords.some(k => name.includes(k)) ? 'black' : 'gold';
  }

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
