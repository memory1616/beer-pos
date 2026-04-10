/**
 * BeerPOS - Offline Store v3 (Event-Driven)
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐ EVENT-BASED - Tất cả thay đổi qua createEvent()
 * 
 * Flow:
 * 1. createEvent() - Tạo event
 * 2. applyEvent() - Apply locally (optimistic)
 * 3. EventSyncEngine - Batch sync
 * 4. WebSocketClient - Realtime updates
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function() {
  'use strict';

  let _initialized = false;

  // ── Init ──────────────────────────────────────────────────────────────

  async function init() {
    if (_initialized) return;

    console.log('[OFFLINEv3] Initializing event-driven store...');

    // Init DB
    if (window.BeerPOSDB) {
      await window.BeerPOSDB.init();
    }

    // Init modules (ApplyEvent.init 现在是 async，必须 await)
    if (window.EventStore) {
      await window.EventStore.init();  // ⭐ CRITICAL: Phải await để tránh race condition
    }

    if (window.ApplyEvent) {
      await window.ApplyEvent.init();
    }

    if (window.EventSyncEngine) {
      await window.EventSyncEngine.init();
    }

    if (window.WebSocketClient) {
      window.WebSocketClient.connect();
    }

    if (window.ConsistencyCheck) {
      await window.ConsistencyCheck.init();
    }

    _initialized = true;
    console.log('[OFFLINEv3] Initialized');
    return true;
  }

  // ── Order Functions ──────────────────────────────────────────────────

  /**
   * ⭐ Tạo đơn hàng qua Event
   */
  async function createOrder(orderData) {
    const id = _generateUUID();
    const now = Date.now();

    const payload = {
      id,
      customerId: orderData.customerId || null,
      customerName: orderData.customerName || 'Khách lẻ',
      items: orderData.items || [],
      total: orderData.total || 0,
      profit: orderData.profit || 0,
      deliverKegs: orderData.deliverKegs || 0,
      returnKegs: orderData.returnKegs || 0,
      note: orderData.note || '',
      type: orderData.type || 'sale',
      date: _getVietnamDate(),
      status: 'completed',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    // Create event
    const event = await window.EventStore?.createEvent(
      'ORDER_CREATED',
      payload,
      { entity: 'orders', entityId: id }
    );

    console.log('[OFFLINEv3] Order created:', id);
    return event?.payload;
  }

  async function createOrdersBatch(ordersData) {
    const events = ordersData.map(data => {
      const id = _generateUUID();
      const now = Date.now();

      return {
        type: 'ORDER_CREATED',
        payload: {
          id,
          customerId: data.customerId || null,
          customerName: data.customerName || 'Khách lẻ',
          items: data.items || [],
          total: data.total || 0,
          profit: data.profit || 0,
          deliverKegs: data.deliverKegs || 0,
          returnKegs: data.returnKegs || 0,
          note: data.note || '',
          type: data.type || 'sale',
          date: _getVietnamDate(),
          status: 'completed',
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
        options: { entity: 'orders', entityId: id },
      };
    });

    const created = await window.EventStore?.createEventsBatch(events);
    console.log(`[OFFLINEv3] Batch created ${ordersData.length} orders`);
    return created;
  }

  async function getOrders(options = {}) {
    return window.ApplyEvent?.getOrders(options) || [];
  }

  async function getOrder(orderId) {
    return window.ApplyEvent?.getOrder(orderId);
  }

  async function updateOrder(orderId, updates) {
    const event = await window.EventStore?.createEvent(
      'ORDER_UPDATED',
      { id: orderId, ...updates },
      { entity: 'orders', entityId: orderId }
    );
    return event?.payload;
  }

  async function deleteOrder(orderId) {
    const event = await window.EventStore?.createEvent(
      'ORDER_DELETED',
      { id: orderId },
      { entity: 'orders', entityId: orderId }
    );
    return { id: orderId };
  }

  async function returnOrder(orderId) {
    const event = await window.EventStore?.createEvent(
      'ORDER_RETURNED',
      { id: orderId },
      { entity: 'orders', entityId: orderId }
    );
    return { id: orderId };
  }

  // ── Product Functions ────────────────────────────────────────────────

  async function getProducts() {
    return window.ApplyEvent?.getProducts() || [];
  }

  async function updateProductStock(productId, delta) {
    const event = await window.EventStore?.createEvent(
      'PRODUCT_STOCK_CHANGED',
      { id: productId, delta },
      { entity: 'products', entityId: productId }
    );
    return event?.payload;
  }

  async function updateProduct(productId, updates) {
    const event = await window.EventStore?.createEvent(
      'PRODUCT_UPDATED',
      { id: productId, ...updates },
      { entity: 'products', entityId: productId }
    );
    return event?.payload;
  }

  // ── Customer Functions ───────────────────────────────────────────────

  async function getCustomers() {
    return window.ApplyEvent?.getCustomers() || [];
  }

  async function getCustomer(customerId) {
    return window.ApplyEvent?.getCustomer(customerId);
  }

  async function createCustomer(customerData) {
    const id = _generateUUID();
    const now = Date.now();

    const event = await window.EventStore?.createEvent(
      'CUSTOMER_CREATED',
      {
        id,
        name: customerData.name,
        phone: customerData.phone || '',
        address: customerData.address || '',
        deposit: customerData.deposit || 0,
        kegBalance: customerData.kegBalance || 0,
        debt: customerData.debt || 0,
        createdAt: now,
        updatedAt: now,
      },
      { entity: 'customers', entityId: id }
    );

    return event?.payload;
  }

  async function updateCustomer(customerId, updates) {
    const event = await window.EventStore?.createEvent(
      'CUSTOMER_UPDATED',
      { id: customerId, ...updates },
      { entity: 'customers', entityId: customerId }
    );
    return event?.payload;
  }

  async function updateKegBalance(customerId, quantity) {
    const event = await window.EventStore?.createEvent(
      'KEG_BALANCE_UPDATED',
      { customerId, kegBalance: quantity },
      { entity: 'kegs', entityId: customerId }
    );
    return event?.payload;
  }

  async function deliverKeg(customerId, quantity) {
    const event = await window.EventStore?.createEvent(
      'KEG_DELIVERED',
      { customerId, quantity },
      { entity: 'kegs', entityId: customerId }
    );
    return event?.payload;
  }

  async function collectKeg(customerId, quantity) {
    const event = await window.EventStore?.createEvent(
      'KEG_COLLECTED',
      { customerId, quantity },
      { entity: 'kegs', entityId: customerId }
    );
    return event?.payload;
  }

  // ── Expense Functions ────────────────────────────────────────────────

  async function createExpense(expenseData) {
    const id = _generateUUID();
    const now = Date.now();

    const event = await window.EventStore?.createEvent(
      'EXPENSE_CREATED',
      {
        id,
        category: expenseData.category,
        type: expenseData.type || 'other',
        amount: expenseData.amount,
        description: expenseData.description || '',
        date: expenseData.date || _getVietnamDate(),
        time: new Date().toTimeString().slice(0, 5),
        km: expenseData.km,
        createdAt: now,
        updatedAt: now,
      },
      { entity: 'expenses', entityId: id }
    );

    return event?.payload;
  }

  async function createExpensesBatch(expensesData) {
    const events = expensesData.map(data => {
      const id = _generateUUID();
      const now = Date.now();

      return {
        type: 'EXPENSE_CREATED',
        payload: {
          id,
          category: data.category,
          type: data.type || 'other',
          amount: data.amount,
          description: data.description || '',
          date: data.date || _getVietnamDate(),
          time: new Date().toTimeString().slice(0, 5),
          km: data.km,
          createdAt: now,
          updatedAt: now,
        },
        options: { entity: 'expenses', entityId: id },
      };
    });

    const created = await window.EventStore?.createEventsBatch(events);
    console.log(`[OFFLINEv3] Batch created ${expensesData.length} expenses`);
    return created;
  }

  async function getExpenses(options = {}) {
    return window.ApplyEvent?.getExpenses(options) || [];
  }

  async function updateExpense(expenseId, updates) {
    const event = await window.EventStore?.createEvent(
      'EXPENSE_UPDATED',
      { id: expenseId, ...updates },
      { entity: 'expenses', entityId: expenseId }
    );
    return event?.payload;
  }

  async function deleteExpense(expenseId) {
    const event = await window.EventStore?.createEvent(
      'EXPENSE_DELETED',
      { id: expenseId },
      { entity: 'expenses', entityId: expenseId }
    );
    return { id: expenseId };
  }

  // ── Payment Functions ────────────────────────────────────────────────

  async function createPayment(paymentData) {
    const id = _generateUUID();
    const now = Date.now();

    const event = await window.EventStore?.createEvent(
      'PAYMENT_CREATED',
      {
        id,
        customerId: paymentData.customerId,
        amount: paymentData.amount,
        note: paymentData.note || '',
        createdAt: now,
        updatedAt: now,
      },
      { entity: 'payments', entityId: id }
    );

    return event?.payload;
  }

  // ── Sync Functions ──────────────────────────────────────────────────

  async function getSyncStatus() {
    try {
      const status = window.EventSyncEngine?.getStatus();
      if (status && typeof status.then === 'function') {
        return await status;
      }
      return status || { isOnline: navigator.onLine, pendingEvents: 0 };
    } catch (err) {
      console.error('[OFFLINEv3] getSyncStatus error:', err);
      return {
        isOnline: navigator.onLine,
        pendingEvents: 0,
        syncedEvents: 0,
        failedEvents: 0,
        totalEvents: 0,
        queueItems: 0,
        status: 'error',
      };
    }
  }

  async function syncNow() {
    return window.EventSyncEngine?.triggerSync() || { success: false };
  }

  async function pullDelta() {
    // Pull delta from server
    try {
      const response = await fetch('/api/sync-events/delta', {
        headers: { 'Cache-Control': 'no-cache' },
      });
      const data = await response.json();
      
      if (data.success && data.events) {
        for (const event of data.events) {
          await window.EventStore?.receiveEvent(event);
        }
      }
      
      return { success: true, events: data.events?.length || 0 };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async function retryFailed() {
    return window.EventSyncEngine?.retryFailed() || { success: false };
  }

  async function fullResync() {
    return window.ConsistencyCheck?.triggerResync() || { success: false };
  }

  async function checkConsistency() {
    return window.ConsistencyCheck?.triggerCheck() || { ok: true };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  function _generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function _getVietnamDate() {
    const now = new Date();
    const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    return vn.getUTCFullYear() + '-' +
      String(vn.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(vn.getUTCDate()).padStart(2, '0');
  }

  // ── Export ────────────────────────────────────────────────────────

  const OfflineStore = {
    init,

    // Orders
    createOrder,
    createOrdersBatch,
    getOrders,
    getOrder,
    updateOrder,
    deleteOrder,
    returnOrder,

    // Products
    getProducts,
    updateProductStock,
    updateProduct,

    // Customers
    getCustomers,
    getCustomer,
    createCustomer,
    updateCustomer,
    updateKegBalance,
    deliverKeg,
    collectKeg,

    // Expenses
    createExpense,
    createExpensesBatch,
    getExpenses,
    updateExpense,
    deleteExpense,

    // Payments
    createPayment,

    // Sync
    getSyncStatus,
    syncNow,
    pullDelta,
    retryFailed,
    fullResync,
    checkConsistency,
  };

  window.OfflineStore = OfflineStore;
  window.OS = OfflineStore;

  console.log('[OFFLINEv3] OfflineStore loaded (Event-Driven)');

})();
