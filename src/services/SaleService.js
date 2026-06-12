/**
 * SaleService - Business logic cho sales
 */
const db = require('../../database');
const logger = require('../utils/logger');

function formatCurrency(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(amount || 0);
}

class SaleService {
  constructor() {
    this._saleCache = new Map();
  }

  create(data) {
    const { customerId, items, deliverKegs = 0, returnKegs = 0 } = data;

    const errors = this._validateSaleInput(data);
    if (errors.length > 0) {
      return { success: false, errors };
    }

    const productMap = this._loadProducts();
    const priceMap = customerId ? this._loadCustomerPrices(customerId) : { byId: {}, bySlug: {} };

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

    const kegQuantity = saleItems.filter(i => i.type !== 'pet').reduce((sum, i) => sum + i.quantity, 0);
    const finalDeliverKegs = deliverKegs > 0 ? deliverKegs : kegQuantity;

    let newKegBalance = 0;
    if (customerId) {
      const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(customerId);
      const currentBalance = customer ? customer.keg_balance : 0;
      newKegBalance = currentBalance + finalDeliverKegs - returnKegs;
    }

    const createSale = db.transaction(() => {
      const saleDate = db.getVietnamDateStr();
      const result = db.prepare(`
        INSERT INTO sales (customer_id, date, total, profit, deliver_kegs, return_kegs, keg_balance_after, type)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'sale')
      `).run(customerId, saleDate, total, profit, finalDeliverKegs, returnKegs, newKegBalance);
      const saleId = result.lastInsertRowid;

      if (!saleId) throw new Error('Sale creation failed');

      if (customerId) {
        db.prepare("UPDATE customers SET last_order_date = datetime('now', '+7 hours') WHERE id = ?").run(customerId);
      }

      for (const item of saleItems) {
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(item.quantity, item.productId);
        db.prepare(`
          INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit, price_at_time)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(saleId, item.productId, item.productSlug, item.quantity, item.price, item.costPrice, item.profit, item.price);
      }

      if (customerId && (finalDeliverKegs !== 0 || returnKegs !== 0)) {
        this._updateCustomerKegBalance(customerId, finalDeliverKegs, returnKegs);
      }

      this._syncKegInventory();

      return saleId;
    });

    const saleId = createSale();
    return { success: true, saleId, total, profit };
  }

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

  _getEffectivePrice(product, priceMap) {
    if (priceMap.byId[product.id] !== undefined) {
      return priceMap.byId[product.id];
    }
    if (product.slug && priceMap.bySlug[product.slug] !== undefined) {
      return priceMap.bySlug[product.slug];
    }
    return product.sell_price || product.price || 0;
  }

  _updateCustomerKegBalance(customerId, deliver, returnKegs) {
    db.prepare(`
      UPDATE customers SET keg_balance = keg_balance + ? - ? WHERE id = ?
    `).run(deliver, returnKegs, customerId);
  }

  _syncKegInventory() {
    const inventory = db.prepare(db.SQL_KEG_WAREHOUSE_RAW_STOCK).get();
    const holding = db.prepare('SELECT COALESCE(SUM(keg_balance), 0) as t FROM customers').get();
    db.prepare(`
      UPDATE keg_stats SET inventory = ?, customer_holding = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1
    `).run(inventory.total, holding.t);
  }

  clearCache() {
    this._saleCache.clear();
  }
}

module.exports = SaleService;
