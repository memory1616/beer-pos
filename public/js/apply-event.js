/**
 * BeerPOS - Apply Event Layer
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ APPLY EVENT - Cập nhật entity cache từ event
 * 
 * Tất cả UI phải đọc từ entity cache SAU KHI events được apply.
 * Không bao giờ update trực tiếp vào entities.
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function() {
  'use strict';

  let _db = null;
  let _listeners = new Set();

  // ── Local upsertEntity implementation ────────────────────────────────
  // ⭐ CRITICAL: Implement local để đảm bảo luôn có upsertEntity
  async function localUpsertEntity(entity, item) {
    if (!_db) {
      console.warn('[APPLY] localUpsertEntity: _db null');
      return;
    }
    if (!item?.id) {
      console.warn('[APPLY] localUpsertEntity: missing id', { entity });
      return;
    }
    
    const safeEntity = typeof entity === 'string' ? entity : String(entity);
    
    try {
      const now = Date.now();
      const data = {
        ...item,
        entity: safeEntity,
        updatedAt: item.updatedAt || now,
      };
      await _db.entities.put(data);
      console.log('[APPLY] localUpsertEntity: success', entity, item.id);
    } catch (err) {
      console.error('[APPLY] localUpsertEntity error:', err, { entity, itemId: item?.id });
    }
  }

  // ── Init ─────────────────────────────────────────────────────────────

  async function init() {
    // ⭐ CRITICAL: Phải đợi BeerPOSDB hoàn toàn ready
    if (window.BeerPOSDB) {
      await window.BeerPOSDB.ready;
      _db = window.BeerPOSDB;
      
      // ⭐ ATTACH local upsertEntity to _db to ensure it's always available
      _db.upsertEntity = localUpsertEntity;
      
      console.log('[APPLY] _db initialized:', {
        hasDb: !!_db,
        dbType: typeof _db,
        hasUpsert: typeof _db.upsertEntity,
        isLocal: _db.upsertEntity === localUpsertEntity,
      });
    }

    // Register apply function with EventStore
    if (window.EventStore) {
      window.EventStore.setApplyFunction(applyEvent);
    }
  }

  // ── Hard Guard: Safe upsert wrapper ──────────────────────────────────
  // ⭐ CRITICAL: Ngăn crash khi _db.upsertEntity không tồn tại
  async function _safeUpsert(entity, item) {
    // Layer 1: Kiểm tra _db tồn tại
    if (!_db) {
      console.warn('[APPLY] _db null, skipping upsert:', entity, item?.id);
      return;
    }
    // Layer 2: Kiểm tra upsertEntity là function
    if (typeof _db.upsertEntity !== 'function') {
      console.error('[FATAL] upsertEntity missing from _db — cannot apply event!', entity, item?.id);
      console.error('[FATAL] _db type:', typeof _db, '_db keys:', Object.keys(_db || {}));
      return;
    }
    // Layer 3: Try-catch để ngăn crash
    try {
      await _db.upsertEntity(entity, item);
    } catch (err) {
      console.error('[APPLY] _safeUpsert error:', err, { entity, itemId: item?.id });
    }
  }

  // ── Main Apply Function ──────────────────────────────────────────────

  /**
   * ⭐ APPLY EVENT - Xử lý event và cập nhật entity cache
   * 
   * @param {object} event - Event object
   * @returns {object} Applied entity
   */
  async function applyEvent(event) {
    // ⭐ HARD GUARD: Kiểm tra trước khi xử lý bất kỳ event nào
    if (_db && typeof _db.upsertEntity !== 'function') {
      console.error('[FATAL] upsertEntity missing from _db — event replay blocked for:', event?.type);
      return null;
    }

    const { type, payload, entity, entityId } = event;

    try {
      switch (type) {
        // ── ORDER EVENTS ────────────────────────────────────────────
        case 'ORDER_CREATED':
          return await _applyOrderCreated(event);
        
        case 'ORDER_UPDATED':
          return await _applyOrderUpdated(event);
        
        case 'ORDER_DELETED':
          return await _applyOrderDeleted(event);
        
        case 'ORDER_RETURNED':
          return await _applyOrderReturned(event);
        
        // ── PRODUCT EVENTS ──────────────────────────────────────────
        case 'PRODUCT_UPDATED':
          return await _applyProductUpdated(event);
        
        case 'PRODUCT_STOCK_CHANGED':
          return await _applyProductStockChanged(event);
        
        // ── CUSTOMER EVENTS ─────────────────────────────────────────
        case 'CUSTOMER_CREATED':
          return await _applyCustomerCreated(event);
        
        case 'CUSTOMER_UPDATED':
          return await _applyCustomerUpdated(event);
        
        // ── EXPENSE EVENTS ──────────────────────────────────────────
        case 'EXPENSE_CREATED':
          return await _applyExpenseCreated(event);
        
        case 'EXPENSE_UPDATED':
          return await _applyExpenseUpdated(event);
        
        case 'EXPENSE_DELETED':
          return await _applyExpenseDeleted(event);
        
        // ── KEG EVENTS ─────────────────────────────────────────────
        case 'KEG_DELIVERED':
          return await _applyKegDelivered(event);
        
        case 'KEG_COLLECTED':
          return await _applyKegCollected(event);
        
        case 'KEG_BALANCE_UPDATED':
          return await _applyKegBalanceUpdated(event);
        
        // ── PAYMENT EVENTS ──────────────────────────────────────────
        case 'PAYMENT_CREATED':
          return await _applyPaymentCreated(event);
        
        default:
          console.warn('[APPLY] Unknown event type:', type);
          return null;
      }
    } catch (error) {
      console.error('[APPLY] applyEvent error:', error, { type, payload });
      return null;
    }
  }

  // ── Order Apply Functions ─────────────────────────────────────────────

  async function _applyOrderCreated(event) {
    const { payload } = event;

    const order = {
      id: payload.id,
      localId: payload.id,
      customerId: payload.customerId || null,
      customerName: payload.customerName || 'Khách lẻ',
      items: payload.items || [],
      total: payload.total || 0,
      profit: payload.profit || 0,
      deliverKegs: payload.deliverKegs || 0,
      returnKegs: payload.returnKegs || 0,
      note: payload.note || '',
      type: payload.type || 'sale',
      date: payload.date || _getVietnamDate(),
      status: payload.status || 'completed',
      version: payload.version || 1,
      createdAt: payload.createdAt || Date.now(),
      updatedAt: payload.updatedAt || Date.now(),
      syncStatus: event.status || 'pending',
    };

    await _safeUpsert('orders', order);

    // Dispatch UI update
    _dispatchUpdate('order:created', order);
    
    return order;
  }

  async function _applyOrderUpdated(event) {
    const { payload } = event;

    const existing = _db ? await _db.getEntity('orders', payload.id) : null;
    
    const order = {
      ...existing,
      ...payload,
      id: payload.id,
      version: (existing?.version || 0) + 1,
      updatedAt: Date.now(),
      syncStatus: event.status || 'pending',
    };

    await _safeUpsert('orders', order);

    _dispatchUpdate('order:updated', order);
    return order;
  }

  async function _applyOrderDeleted(event) {
    const { payload } = event;

    // Soft delete
    const existing = _db ? await _db.getEntity('orders', payload.id) : null;
    
    if (existing) {
      const order = {
        ...existing,
        deleted: true,
        deletedAt: Date.now(),
        updatedAt: Date.now(),
        syncStatus: event.status || 'pending',
      };
      
      await _safeUpsert('orders', order);
    }

    _dispatchUpdate('order:deleted', { id: payload.id });
    }

    return { id: payload.id, deleted: true };
  }

  async function _applyOrderReturned(event) {
    const { payload } = event;

    const existing = _db ? await _db.getEntity('orders', payload.id) : null;
    
    const order = {
      ...existing,
      id: payload.id,
      status: 'returned',
      total: 0,
      profit: 0,
      version: (existing?.version || 0) + 1,
      updatedAt: Date.now(),
      syncStatus: event.status || 'pending',
    };

    await _safeUpsert('orders', order);

    _dispatchUpdate('order:returned', order);
    return order;
  }

  // ── Product Apply Functions ───────────────────────────────────────────

  async function _applyProductUpdated(event) {
    const { payload } = event;

    const existing = _db ? await _db.getEntity('products', payload.id) : null;
    
    const product = {
      ...existing,
      ...payload,
      id: payload.id,
      version: (existing?.version || 0) + 1,
      updatedAt: Date.now(),
    };

    await _safeUpsert('products', product);

    _dispatchUpdate('product:updated', product);
    return product;
  }

  async function _applyProductStockChanged(event) {
    const { payload } = event;

    const existing = _db ? await _db.getEntity('products', payload.id) : null;
    
    const currentStock = existing?.stock || 0;
    const newStock = payload.stock !== undefined 
      ? payload.stock 
      : currentStock + (payload.delta || 0);

    const product = {
      ...existing,
      id: payload.id,
      stock: newStock,
      version: (existing?.version || 0) + 1,
      updatedAt: Date.now(),
    };

    await _safeUpsert('products', product);

    _dispatchUpdate('product:stock-changed', product);
    return product;
  }

  // ── Customer Apply Functions ──────────────────────────────────────────

  async function _applyCustomerCreated(event) {
    const { payload } = event;

    const customer = {
      id: payload.id,
      localId: payload.id,
      name: payload.name,
      phone: payload.phone || '',
      address: payload.address || '',
      deposit: payload.deposit || 0,
      kegBalance: payload.kegBalance || 0,
      debt: payload.debt || 0,
      lat: payload.lat,
      lng: payload.lng,
      version: 1,
      createdAt: payload.createdAt || Date.now(),
      updatedAt: payload.updatedAt || Date.now(),
    };

    await _safeUpsert('customers', customer);

    _dispatchUpdate('customer:created', customer);
    return customer;
  }

  async function _applyCustomerUpdated(event) {
    const { payload } = event;

    const existing = _db ? await _db.getEntity('customers', payload.id) : null;
    
    const customer = {
      ...existing,
      ...payload,
      id: payload.id,
      version: (existing?.version || 0) + 1,
      updatedAt: Date.now(),
    };

    await _safeUpsert('customers', customer);

    _dispatchUpdate('customer:updated', customer);
    return customer;
  }

  // ── Expense Apply Functions ────────────────────────────────────────────

  async function _applyExpenseCreated(event) {
    const { payload } = event;

    const expense = {
      id: payload.id,
      localId: payload.id,
      category: payload.category,
      type: payload.type || 'other',
      amount: payload.amount,
      description: payload.description || '',
      date: payload.date || _getVietnamDate(),
      time: payload.time || new Date().toTimeString().slice(0, 5),
      km: payload.km,
      version: 1,
      createdAt: payload.createdAt || Date.now(),
      updatedAt: payload.updatedAt || Date.now(),
      syncStatus: event.status || 'pending',
    };

    await _safeUpsert('expenses', expense);

    _dispatchUpdate('expense:created', expense);
    return expense;
  }

  async function _applyExpenseUpdated(event) {
    const { payload } = event;

    const existing = _db ? await _db.getEntity('expenses', payload.id) : null;
    
    const expense = {
      ...existing,
      ...payload,
      id: payload.id,
      version: (existing?.version || 0) + 1,
      updatedAt: Date.now(),
    };

    await _safeUpsert('expenses', expense);

    _dispatchUpdate('expense:updated', expense);
    return expense;
  }

  async function _applyExpenseDeleted(event) {
    const { payload } = event;

    const existing = _db ? await _db.getEntity('expenses', payload.id) : null;
    
    if (existing) {
      const expense = {
        ...existing,
        deleted: true,
        deletedAt: Date.now(),
        updatedAt: Date.now(),
      };
      
      await _safeUpsert('expenses', expense);
      }

      _dispatchUpdate('expense:deleted', { id: payload.id });
    }

    return { id: payload.id, deleted: true };
  }

  // ── Keg Apply Functions ───────────────────────────────────────────────

  async function _applyKegDelivered(event) {
    const { payload } = event;

    const customer = _db ? await _db.getEntity('customers', payload.customerId) : null;
    
    const newBalance = (customer?.kegBalance || 0) + (payload.quantity || 0);
    
    const updatedCustomer = {
      ...customer,
      id: payload.customerId,
      kegBalance: newBalance,
      version: (customer?.version || 0) + 1,
      updatedAt: Date.now(),
    };

    await _safeUpsert('customers', updatedCustomer);

    _dispatchUpdate('keg:delivered', updatedCustomer);
    return updatedCustomer;
  }

  async function _applyKegCollected(event) {
    const { payload } = event;

    const customer = _db ? await _db.getEntity('customers', payload.customerId) : null;
    
    const newBalance = (customer?.kegBalance || 0) - (payload.quantity || 0);
    
    const updatedCustomer = {
      ...customer,
      id: payload.customerId,
      kegBalance: Math.max(0, newBalance),
      version: (customer?.version || 0) + 1,
      updatedAt: Date.now(),
    };

    await _safeUpsert('customers', updatedCustomer);

    _dispatchUpdate('keg:collected', updatedCustomer);
    return updatedCustomer;
  }

  async function _applyKegBalanceUpdated(event) {
    const { payload } = event;

    const customer = _db ? await _db.getEntity('customers', payload.customerId) : null;
    
    const updatedCustomer = {
      ...customer,
      id: payload.customerId,
      kegBalance: payload.kegBalance,
      version: (customer?.version || 0) + 1,
      updatedAt: Date.now(),
    };

    await _safeUpsert('customers', updatedCustomer);

    _dispatchUpdate('keg:balance-updated', updatedCustomer);
    return updatedCustomer;
  }

  // ── Payment Apply Functions ────────────────────────────────────────────

  async function _applyPaymentCreated(event) {
    const { payload } = event;

    const payment = {
      id: payload.id,
      customerId: payload.customerId,
      amount: payload.amount,
      note: payload.note || '',
      version: 1,
      createdAt: payload.createdAt || Date.now(),
      updatedAt: payload.updatedAt || Date.now(),
    };

    await _safeUpsert('payments', payment);

    _dispatchUpdate('payment:created', payment);
    return payment;
  }

  // ── Helper Functions ──────────────────────────────────────────────────

  function _getVietnamDate() {
    const now = new Date();
    const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    return vn.getUTCFullYear() + '-' +
      String(vn.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(vn.getUTCDate()).padStart(2, '0');
  }

  // ── Event Dispatch ───────────────────────────────────────────────────

  function _dispatchUpdate(type, data) {
    // Call listeners
    for (const listener of _listeners) {
      try {
        listener(type, data);
      } catch (error) {
        console.error('[APPLY] Listener error:', error);
      }
    }

    // Dispatch global event
    window.dispatchEvent(new CustomEvent(type, { detail: data }));

    // Also dispatch generic entity update
    window.dispatchEvent(new CustomEvent('entity:updated', { 
      detail: { type, data } 
    }));
  }

  // ── Read Functions (For UI) ───────────────────────────────────────────

  async function getOrders(options = {}) {
    if (!_db) return [];

    const { date, customerId, includeDeleted = false } = options;

    let orders = await _db.getAllEntities('orders');

    if (!includeDeleted) {
      orders = orders.filter(o => !o.deleted);
    }

    if (date) {
      orders = orders.filter(o => o.date === date);
    }

    if (customerId) {
      orders = orders.filter(o => o.customerId === customerId);
    }

    // Sort by createdAt desc
    orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    return orders;
  }

  async function getOrder(orderId) {
    if (!_db) return null;
    return _db.getEntity('orders', orderId);
  }

  async function getProducts() {
    if (!_db) return [];
    return _db.getAllEntities('products');
  }

  async function getCustomers() {
    if (!_db) return [];
    return _db.getAllEntities('customers');
  }

  async function getCustomer(customerId) {
    if (!_db) return null;
    return _db.getEntity('customers', customerId);
  }

  async function getExpenses(options = {}) {
    const { date, includeDeleted = false } = options;

    if (!_db) return [];

    let expenses = await _db.getAllEntities('expenses');

    if (!includeDeleted) {
      expenses = expenses.filter(e => !e.deleted);
    }

    if (date) {
      expenses = expenses.filter(e => e.date === date);
    }

    expenses.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    return expenses;
  }

  // ── Listener System ──────────────────────────────────────────────────

  function addListener(callback) {
    _listeners.add(callback);
    return () => _listeners.delete(callback);
  }

  // ── Version Check (Conflict Detection) ────────────────────────────────

  async function checkVersion(entity, entityId, incomingVersion) {
    if (!_db) return { conflict: false };

    const existing = await _db.getEntity(entity, entityId);
    
    if (!existing) {
      return { conflict: false };
    }

    if (incomingVersion > existing.version) {
      return { conflict: false }; // Incoming is newer
    }

    return { 
      conflict: true, 
      localVersion: existing.version, 
      incomingVersion 
    };
  }

  // ── Export ───────────────────────────────────────────────────────────

  const ApplyEvent = {
    init,
    applyEvent,
    addListener,

    // Read functions
    getOrders,
    getOrder,
    getProducts,
    getCustomers,
    getCustomer,
    getExpenses,

    // Version check
    checkVersion,
  };

  window.ApplyEvent = ApplyEvent;

  console.log('[APPLY] ApplyEvent loaded');

})();
