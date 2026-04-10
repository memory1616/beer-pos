/**
 * BeerPOS - Transaction Manager
 * ─────────────────────────────────────────────────────────────────────────────
 * Quản lý tất cả database transactions với:
 * - Automatic rollback on error
 * - Nested transactions support
 * - Action logging integration
 * - Sync queue integration
 * - Audit trail
 * ─────────────────────────────────────────────────────────────────────────────
 */

const db = require('../database');
const { generateUUID } = require('../database/migration');
const logger = require('../utils/logger');

// ── Constants ──────────────────────────────────────────────────────────────────

const TRANSACTION_TYPES = {
  SALE_CREATE: 'sale_create',
  SALE_UPDATE: 'sale_update',
  SALE_DELETE: 'sale_delete',
  SALE_RETURN: 'sale_return',
  PURCHASE_CREATE: 'purchase_create',
  EXPENSE_CREATE: 'expense_create',
  EXPENSE_UPDATE: 'expense_update',
  EXPENSE_DELETE: 'expense_delete',
  CUSTOMER_CREATE: 'customer_create',
  CUSTOMER_UPDATE: 'customer_update',
  CUSTOMER_DELETE: 'customer_delete',
  KEG_UPDATE: 'keg_update',
  PAYMENT_CREATE: 'payment_create',
};

// ── Transaction Context ────────────────────────────────────────────────────────

let _transactionStack = [];
let _currentTransaction = null;

/**
 * Get current transaction context
 */
function getCurrentTransaction() {
  return _currentTransaction;
}

/**
 * Check if currently in a transaction
 */
function inTransaction() {
  return _currentTransaction !== null;
}

// ── Core Transaction Functions ─────────────────────────────────────────────────

/**
 * Execute a function within a database transaction
 * @param {string} type - Transaction type
 * @param {object} options - Transaction options
 * @param {Function} fn - Function to execute
 * @returns {Promise<object>} Result with metadata
 */
function withTransaction(type, options = {}, fn) {
  const transactionId = generateUUID();
  const startTime = Date.now();
  const ctx = {
    id: transactionId,
    type,
    options,
    startTime,
    startStack: new Error().stack,
    logs: [],
    errors: [],
    affectedRows: [],
    metrics: {},
  };

  // Check for nested transactions - use savepoints
  const isNested = inTransaction();
  const savepointName = isNested ? `sp_${transactionId.replace(/-/g, '')}` : null;

  let connection = null;
  let committed = false;
  let rolledBack = false;

  try {
    _currentTransaction = ctx;
    _transactionStack.push(ctx);

    logger.debug(`[TX] Starting transaction ${type}`, { id: transactionId, isNested });

    // Start transaction or savepoint
    if (isNested && savepointName) {
      db.exec(`SAVEPOINT ${savepointName}`);
    } else {
      db.exec('BEGIN IMMEDIATE');
    }

    // Execute the function
    const result = fn({
      transaction: {
        id: transactionId,
        type,
        log: (message, data) => ctx.logs.push({ message, data, ts: Date.now() }),
        addAffected: (table, id, action) => ctx.affectedRows.push({ table, id, action }),
        setMetric: (key, value) => ctx.metrics[key] = value,
      },
      db,
      generateUUID,
      getVietnamDateStr: db.getVietnamDateStr,
    });

    // Check for errors in the function result
    if (result && result.error) {
      throw new Error(result.error);
    }

    // Commit
    if (isNested && savepointName) {
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
    } else {
      db.exec('COMMIT');
    }

    committed = true;
    const elapsed = Date.now() - startTime;

    logger.debug(`[TX] Committed ${type}`, {
      id: transactionId,
      elapsed,
      affected: ctx.affectedRows.length,
    });

    return {
      success: true,
      transactionId,
      type,
      elapsed,
      affectedRows: ctx.affectedRows,
      logs: ctx.logs,
      metrics: ctx.metrics,
      result,
    };

  } catch (error) {
    const elapsed = Date.now() - startTime;

    // Rollback
    try {
      if (isNested && savepointName) {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      } else if (!committed) {
        db.exec('ROLLBACK');
      }
      rolledBack = true;
    } catch (rbError) {
      logger.error(`[TX] Rollback failed`, { id: transactionId, error: rbError.message });
    }

    logger.error(`[TX] Transaction failed: ${type}`, {
      id: transactionId,
      elapsed,
      error: error.message,
      stack: error.stack,
      isNested,
    });

    return {
      success: false,
      transactionId,
      type,
      elapsed,
      error: error.message,
      rolledBack,
      logs: ctx.logs,
      affectedRows: ctx.affectedRows,
    };

  } finally {
    // Pop from stack
    _transactionStack.pop();
    _currentTransaction = _transactionStack.length > 0
      ? _transactionStack[_transactionStack.length - 1]
      : null;

    // Log transaction completion
    if (options.logAction !== false) {
      try {
        const actionLog = {
          uuid: generateUUID(),
          action: committed ? 'commit' : rolledBack ? 'rollback' : 'error',
          entity: 'transaction',
          entity_id: transactionId,
          payload: JSON.stringify({ type, options, elapsed: Date.now() - startTime }),
          error: !committed ? ctx.errors.join('; ') : null,
        };
        // Will be handled by ActionLogger if available
        logger.debug(`[TX] ${type} ${committed ? 'committed' : rolledBack ? 'rolled back' : 'failed'}`,
          { id: transactionId, elapsed: Date.now() - startTime });
      } catch (e) {
        // Silent fail for logging
      }
    }
  }
}

/**
 * Execute a read-only transaction
 */
function withReadOnly(fn) {
  return withTransaction('read_only', { readOnly: true }, fn);
}

/**
 * Execute a batch of operations
 */
function withBatch(operations, options = {}) {
  return withTransaction('batch', { operations, ...options }, ({ transaction, ...rest }) => {
    const results = [];

    for (const op of operations) {
      const result = op.fn({ transaction, ...rest });
      results.push(result);

      // Stop on error if configured
      if (options.stopOnError && result && result.error) {
        throw new Error(result.error);
      }
    }

    return { results };
  });
}

// ── Sale Transaction Helpers ──────────────────────────────────────────────────

/**
 * Execute sale creation in a transaction
 */
function createSale(saleData) {
  return withTransaction(TRANSACTION_TYPES.SALE_CREATE, {
    entity: 'sales',
    entityId: saleData.id,
  }, ({ transaction, db, getVietnamDateStr }) => {
    const { customerId, items, deliverKegs = 0, returnKegs = 0 } = saleData;

    // Calculate totals
    let total = 0;
    let profit = 0;
    const saleItems = [];

    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
      if (!product) {
        throw new Error(`Không tìm thấy sản phẩm: ${item.productId}`);
      }

      const price = item.price || product.sell_price;
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
      });

      transaction.addAffected('products', product.id, 'decrement_stock');
    }

    // Create sale
    const saleDate = getVietnamDateStr();
    const result = db.prepare(`
      INSERT INTO sales (uuid, customer_id, date, total, profit, deliver_kegs, return_kegs,
                         keg_balance_after, type, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sale', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      generateUUID(),
      customerId,
      saleDate,
      total,
      profit,
      deliverKegs,
      returnKegs,
      0
    );

    const saleId = result.lastInsertRowid;
    transaction.addAffected('sales', saleId, 'create');

    // Insert sale items
    for (const item of saleItems) {
      db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price,
                               cost_price, profit, price_at_time, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        saleId,
        item.productId,
        item.productSlug,
        item.quantity,
        item.price,
        item.costPrice,
        item.profit,
        item.price
      );

      // Update stock
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?')
        .run(item.quantity, item.productId);

      transaction.addAffected('sale_items', saleId, 'create');
    }

    // Update customer
    if (customerId) {
      db.prepare(`
        UPDATE customers
        SET last_order_date = datetime('now', '+7 hours'),
            updated_at = CURRENT_TIMESTAMP,
            version = version + 1
        WHERE id = ?
      `).run(customerId);
      transaction.addAffected('customers', customerId, 'update');
    }

    transaction.log('Sale created', { saleId, total, profit, itemCount: items.length });

    return {
      success: true,
      saleId,
      total,
      profit,
      itemCount: items.length,
    };
  });
}

/**
 * Execute sale return in a transaction
 */
function returnSale(saleId, returnData) {
  return withTransaction(TRANSACTION_TYPES.SALE_RETURN, {
    entity: 'sales',
    entityId: saleId,
  }, ({ transaction, db }) => {
    const { items: returnItems, reason, addToInventory = true } = returnData;

    // Get sale
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) {
      throw new Error('Không tìm thấy hóa đơn');
    }

    if (sale.status === 'returned') {
      throw new Error('Hóa đơn đã được trả');
    }

    // Get sale items
    const saleItems = returnItems
      ? db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId)
      : db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);

    let totalReturnAmount = 0;
    let totalReturnQty = 0;

    for (const item of saleItems) {
      // Add back to stock
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?')
        .run(item.quantity, item.product_id);

      totalReturnAmount += item.price * item.quantity;
      totalReturnQty += item.quantity;

      transaction.addAffected('products', item.product_id, 'increment_stock');
    }

    // Update sale status
    db.prepare(`
      UPDATE sales
      SET status = 'returned',
          total = 0,
          profit = 0,
          updated_at = CURRENT_TIMESTAMP,
          version = version + 1
      WHERE id = ?
    `).run(saleId);

    transaction.addAffected('sales', saleId, 'update');

    // Update customer keg balance
    if (sale.customer_id && sale.deliver_kegs > 0) {
      db.prepare(`
        UPDATE customers
        SET keg_balance = keg_balance - ?,
            updated_at = CURRENT_TIMESTAMP,
            version = version + 1
        WHERE id = ?
      `).run(sale.deliver_kegs, sale.customer_id);
      transaction.addAffected('customers', sale.customer_id, 'update');
    }

    transaction.log('Sale returned', { saleId, totalReturnAmount, returnQty: totalReturnQty });

    return {
      success: true,
      saleId,
      returnAmount: totalReturnAmount,
      returnQty: totalReturnQty,
    };
  });
}

/**
 * Execute expense operations in a transaction
 */
function createExpense(expenseData) {
  return withTransaction(TRANSACTION_TYPES.EXPENSE_CREATE, {
    entity: 'expenses',
  }, ({ transaction, db, generateUUID, getVietnamDateStr }) => {
    const { category, amount, description, type, km, orderId } = expenseData;

    const uuid = generateUUID();
    const result = db.prepare(`
      INSERT INTO expenses (uuid, category, type, amount, description, date, time, km,
                           order_id, is_auto, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      uuid,
      category,
      type || 'other',
      amount,
      description,
      getVietnamDateStr(),
      new Date().toTimeString().slice(0, 5),
      km,
      orderId,
      expenseData.isAuto ? 1 : 0
    );

    const expenseId = result.lastInsertRowid;
    transaction.addAffected('expenses', expenseId, 'create');

    transaction.log('Expense created', { expenseId, category, amount });

    return {
      success: true,
      expenseId,
      uuid,
    };
  });
}

/**
 * Execute purchase in a transaction
 */
function createPurchase(purchaseData) {
  return withTransaction(TRANSACTION_TYPES.PURCHASE_CREATE, {
    entity: 'purchases',
  }, ({ transaction, db, generateUUID, getVietnamDateStr }) => {
    const { items, note } = purchaseData;

    let totalAmount = 0;
    const validItems = [];

    // Validate and calculate
    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
      if (!product) {
        throw new Error(`Không tìm thấy sản phẩm: ${item.productId}`);
      }

      const costPrice = item.costPrice || product.cost_price;
      const qty = parseInt(item.quantity);

      totalAmount += costPrice * qty;
      validItems.push({
        productId: product.id,
        quantity: qty,
        costPrice,
      });
    }

    // Create purchase
    const uuid = generateUUID();
    const result = db.prepare(`
      INSERT INTO purchases (uuid, date, total_amount, note, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(uuid, getVietnamDateStr(), totalAmount, note);

    const purchaseId = result.lastInsertRowid;
    transaction.addAffected('purchases', purchaseId, 'create');

    // Update stock and create purchase items
    for (const item of validItems) {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?')
        .run(item.quantity, item.productId);
      transaction.addAffected('products', item.productId, 'increment_stock');

      db.prepare(`
        INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_price, total_price)
        VALUES (?, ?, ?, ?, ?)
      `).run(purchaseId, item.productId, item.quantity, item.costPrice, item.costPrice * item.quantity);
    }

    transaction.log('Purchase created', { purchaseId, totalAmount, itemCount: validItems.length });

    return {
      success: true,
      purchaseId,
      uuid,
      totalAmount,
    };
  });
}

// ── Keg Balance Update ─────────────────────────────────────────────────────────

/**
 * Update customer keg balance with transaction
 */
function updateKegBalance(customerId, deliverKegs, returnKegs) {
  return withTransaction(TRANSACTION_TYPES.KEG_UPDATE, {
    entity: 'customers',
    entityId: customerId,
  }, ({ transaction, db }) => {
    const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(customerId);
    if (!customer) {
      throw new Error('Không tìm thấy khách hàng');
    }

    const currentBalance = customer.keg_balance || 0;
    const newBalance = currentBalance + deliverKegs - returnKegs;

    db.prepare(`
      UPDATE customers
      SET keg_balance = ?,
          updated_at = CURRENT_TIMESTAMP,
          version = version + 1
      WHERE id = ?
    `).run(newBalance, customerId);

    transaction.addAffected('customers', customerId, 'keg_balance_update');
    transaction.setMetric('previousBalance', currentBalance);
    transaction.setMetric('newBalance', newBalance);

    return {
      success: true,
      previousBalance: currentBalance,
      newBalance,
    };
  });
}

// ── Sync Queue Helpers ────────────────────────────────────────────────────────

/**
 * Add action to sync queue
 */
function addToSyncQueue(entity, entityId, action, payload = {}) {
  try {
    const uuid = generateUUID();
    db.prepare(`
      INSERT INTO sync_queue (uuid, entity, entity_id, action, payload, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    `).run(uuid, entity, entityId, action, JSON.stringify(payload));
    return { success: true, uuid };
  } catch (error) {
    logger.error('Failed to add to sync queue', { entity, entityId, action, error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * Get pending sync items
 */
function getPendingSyncItems(limit = 50) {
  return db.prepare(`
    SELECT * FROM sync_queue
    WHERE status = 'pending'
    ORDER BY priority DESC, created_at ASC
    LIMIT ?
  `).all(limit);
}

/**
 * Mark sync items as synced
 */
function markSynced(uuid) {
  return db.prepare(`
    UPDATE sync_queue
    SET status = 'synced',
        synced_at = CURRENT_TIMESTAMP
    WHERE uuid = ?
  `).run(uuid);
}

// ── Export ────────────────────────────────────────────────────────────────────

module.exports = {
  // Core functions
  withTransaction,
  withReadOnly,
  withBatch,
  getCurrentTransaction,
  inTransaction,

  // Transaction types
  TRANSACTION_TYPES,

  // Business operations
  createSale,
  returnSale,
  createExpense,
  createPurchase,
  updateKegBalance,

  // Sync queue
  addToSyncQueue,
  getPendingSyncItems,
  markSynced,
};
