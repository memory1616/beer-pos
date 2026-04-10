/**
 * BeerPOS - Central State Store (Redux-like Architecture)
 * ─────────────────────────────────────────────────────────────────────────────
 * Quản lý state global với:
 * - Single source of truth
 * - Immutable state updates
 * - Middleware support (sync, logging)
 * - Local persistence (localStorage)
 * - Action replay capability
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Constants ──────────────────────────────────────────────────────────────────

const STORAGE_PREFIX = 'beerpos_';
const STORE_VERSION = '2.0';

// ── Initial State ───────────────────────────────────────────────────────────────

const initialState = {
  // Meta
  _meta: {
    version: STORE_VERSION,
    lastSync: null,
    lastUpdate: null,
    isLoading: false,
    isOnline: navigator.onLine,
    error: null,
  },

  // Session
  session: null,

  // Entities
  customers: [],
  products: [],
  sales: [],
  expenses: [],
  payments: [],
  purchases: [],

  // Computed/UI State
  filters: {
    dateRange: null,
    customerId: null,
    status: null,
    searchQuery: '',
  },

  // Sync queue
  syncQueue: [],

  // Entity maps (for fast lookups)
  _entityMaps: {
    customers: {},
    products: {},
    sales: {},
    expenses: {},
    payments: {},
    purchases: {},
  },
};

// ── Store Class ────────────────────────────────────────────────────────────────

class BeerStore {
  constructor() {
    this._state = this._loadState() || this._cloneDeep(initialState);
    this._listeners = new Set();
    this._middleware = [];
    this._actionHistory = [];
    this._maxHistory = 100;

    // Bind methods
    this.dispatch = this.dispatch.bind(this);
    this.getState = this.getState.bind(this);
    this.subscribe = this.subscribe.bind(this);
    this.select = this.select.bind(this);

    // Setup online/offline handlers
    this._setupNetworkHandlers();
  }

  // ── State Management ──────────────────────────────────────────────────────

  /**
   * Lấy state hiện tại
   */
  getState() {
    return this._state;
  }

  /**
   * Select a slice of state
   */
  select(selector) {
    if (typeof selector === 'string') {
      return this._state[selector];
    }
    return selector(this._state);
  }

  /**
   * Dispatch an action
   */
  dispatch(action, payload = {}) {
    const actionObj = typeof action === 'string'
      ? { type: action, payload, timestamp: Date.now() }
      : { ...action, timestamp: Date.now() };

    // Add to history
    this._actionHistory.push(actionObj);
    if (this._actionHistory.length > this._maxHistory) {
      this._actionHistory.shift();
    }

    // Run middleware
    let result = actionObj;
    for (const mw of this._middleware) {
      try {
        result = mw(actionObj, this._state) || actionObj;
      } catch (error) {
        console.error('[STORE] Middleware error', error);
      }
    }

    // Handle action
    const newState = this._reduce(actionObj, this._state);

    // Update if changed
    if (newState !== this._state) {
      this._state = newState;
      this._saveState();
      this._notify();
    }

    return actionObj;
  }

  /**
   * Subscribe to state changes
   */
  subscribe(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  _notify() {
    const state = this._state;
    for (const listener of this._listeners) {
      try {
        listener(state);
      } catch (error) {
        console.error('[STORE] Listener error', error);
      }
    }
  }

  // ── Reducer ───────────────────────────────────────────────────────────────

  _reduce(action, state) {
    switch (action.type) {
      // ── Meta Actions ────────────────────────────────────────────────────
      case 'SET_LOADING':
        return this._setIn(state, ['_meta', 'isLoading'], action.payload);

      case 'SET_ERROR':
        return this._setIn(state, ['_meta', 'error'], action.payload);

      case 'SET_ONLINE':
        return this._setIn(state, ['_meta', 'isOnline'], action.payload);

      case 'SET_LAST_SYNC':
        return this._setIn(state, ['_meta', 'lastSync'], action.payload);

      // ── Session Actions ──────────────────────────────────────────────────
      case 'SET_SESSION':
        return { ...state, session: action.payload };

      case 'UPDATE_SESSION':
        return {
          ...state,
          session: { ...state.session, ...action.payload },
        };

      // ── Customer Actions ─────────────────────────────────────────────────
      case 'SET_CUSTOMERS':
        return this._setCustomers(state, action.payload);

      case 'ADD_CUSTOMER':
        return this._addEntity(state, 'customers', action.payload);

      case 'UPDATE_CUSTOMER':
        return this._updateEntity(state, 'customers', action.payload);

      case 'REMOVE_CUSTOMER':
        return this._removeEntity(state, 'customers', action.payload);

      // ── Product Actions ──────────────────────────────────────────────────
      case 'SET_PRODUCTS':
        return this._setProducts(state, action.payload);

      case 'ADD_PRODUCT':
        return this._addEntity(state, 'products', action.payload);

      case 'UPDATE_PRODUCT':
        return this._updateEntity(state, 'products', action.payload);

      case 'UPDATE_PRODUCT_STOCK':
        return this._updateProductStock(state, action.payload);

      // ── Sale Actions ─────────────────────────────────────────────────────
      case 'SET_SALES':
        return this._setSales(state, action.payload);

      case 'ADD_SALE':
        return this._addEntity(state, 'sales', action.payload);

      case 'UPDATE_SALE':
        return this._updateEntity(state, 'sales', action.payload);

      case 'REMOVE_SALE':
        return this._removeEntity(state, 'sales', action.payload);

      // ── Expense Actions ──────────────────────────────────────────────────
      case 'SET_EXPENSES':
        return this._setExpenses(state, action.payload);

      case 'ADD_EXPENSE':
        return this._addEntity(state, 'expenses', action.payload);

      case 'UPDATE_EXPENSE':
        return this._updateEntity(state, 'expenses', action.payload);

      case 'REMOVE_EXPENSE':
        return this._removeEntity(state, 'expenses', action.payload);

      // ── Payment Actions ──────────────────────────────────────────────────
      case 'SET_PAYMENTS':
        return this._setPayments(state, action.payload);

      case 'ADD_PAYMENT':
        return this._addEntity(state, 'payments', action.payload);

      // ── Purchase Actions ─────────────────────────────────────────────────
      case 'SET_PURCHASES':
        return this._setPurchases(state, action.payload);

      case 'ADD_PURCHASE':
        return this._addEntity(state, 'purchases', action.payload);

      // ── Filter Actions ───────────────────────────────────────────────────
      case 'SET_FILTER':
        return this._setIn(state, ['filters', ...action.payload.path], action.payload.value);

      case 'RESET_FILTERS':
        return { ...state, filters: initialState.filters };

      // ── Sync Queue Actions ───────────────────────────────────────────────
      case 'SET_SYNC_QUEUE':
        return { ...state, syncQueue: action.payload };

      case 'ADD_TO_SYNC_QUEUE':
        return {
          ...state,
          syncQueue: [...state.syncQueue, action.payload],
        };

      case 'REMOVE_FROM_SYNC_QUEUE':
        return {
          ...state,
          syncQueue: state.syncQueue.filter(item => item.uuid !== action.payload),
        };

      // ── Reset ───────────────────────────────────────────────────────────
      case 'RESET':
        return this._cloneDeep(initialState);

      case 'LOAD_STATE':
        return { ...this._cloneDeep(initialState), ...action.payload };

      default:
        return state;
    }
  }

  // ── Entity Helpers ────────────────────────────────────────────────────────

  _setCustomers(state, customers) {
    const map = {};
    customers.forEach(c => { map[c.id] = c; });
    return {
      ...state,
      customers,
      _entityMaps: { ...state._entityMaps, customers: map },
    };
  }

  _setProducts(state, products) {
    const map = {};
    products.forEach(p => { map[p.id] = p; });
    return {
      ...state,
      products,
      _entityMaps: { ...state._entityMaps, products: map },
    };
  }

  _setSales(state, sales) {
    const map = {};
    sales.forEach(s => { map[s.id] = s; });
    return {
      ...state,
      sales,
      _entityMaps: { ...state._entityMaps, sales: map },
    };
  }

  _setExpenses(state, expenses) {
    const map = {};
    expenses.forEach(e => { map[e.id] = e; });
    return {
      ...state,
      expenses,
      _entityMaps: { ...state._entityMaps, expenses: map },
    };
  }

  _setPayments(state, payments) {
    const map = {};
    payments.forEach(p => { map[p.id] = p; });
    return {
      ...state,
      payments,
      _entityMaps: { ...state._entityMaps, payments: map },
    };
  }

  _setPurchases(state, purchases) {
    const map = {};
    purchases.forEach(p => { map[p.id] = p; });
    return {
      ...state,
      purchases,
      _entityMaps: { ...state._entityMaps, purchases: map },
    };
  }

  _addEntity(state, entity, item) {
    if (!item || !item.id) return state;

    const currentList = state[entity] || [];
    const existingIndex = currentList.findIndex(i => i.id === item.id);

    let newList;
    if (existingIndex >= 0) {
      newList = [...currentList];
      newList[existingIndex] = { ...currentList[existingIndex], ...item };
    } else {
      newList = [item, ...currentList];
    }

    const newMap = { ...state._entityMaps[entity], [item.id]: item };

    return {
      ...state,
      [entity]: newList,
      _entityMaps: { ...state._entityMaps, [entity]: newMap },
    };
  }

  _updateEntity(state, entity, item) {
    if (!item || !item.id) return state;

    const currentList = state[entity] || [];
    const index = currentList.findIndex(i => i.id === item.id);

    if (index < 0) return state;

    const newList = [...currentList];
    newList[index] = { ...currentList[index], ...item };

    const newMap = { ...state._entityMaps[entity], [item.id]: newList[index] };

    return {
      ...state,
      [entity]: newList,
      _entityMaps: { ...state._entityMaps, [entity]: newMap },
    };
  }

  _removeEntity(state, entity, id) {
    const currentList = state[entity] || [];
    const newList = currentList.filter(i => i.id !== id);

    const newMap = { ...state._entityMaps[entity] };
    delete newMap[id];

    return {
      ...state,
      [entity]: newList,
      _entityMaps: { ...state._entityMaps, [entity]: newMap },
    };
  }

  _updateProductStock(state, { productId, stock, delta }) {
    const products = state.products.map(p => {
      if (p.id === productId) {
        return { ...p, stock: delta !== undefined ? p.stock + delta : stock };
      }
      return p;
    });

    const product = products.find(p => p.id === productId);
    const newMap = { ...state._entityMaps.products };
    if (product) newMap[productId] = product;

    return {
      ...state,
      products,
      _entityMaps: { ...state._entityMaps, products: newMap },
    };
  }

  // ── State Helpers ────────────────────────────────────────────────────────

  _setIn(state, path, value) {
    const newState = this._cloneDeep(state);
    let current = newState;

    for (let i = 0; i < path.length - 1; i++) {
      current[path[i]] = current[path[i]] || {};
      current = current[path[i]];
    }

    current[path[path.length - 1]] = value;
    return newState;
  }

  _cloneDeep(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // ── Persistence ────────────────────────────────────────────────────────

  _saveState() {
    try {
      const toSave = {
        ...this._state,
        // Don't persist large sync queue
        syncQueue: [],
      };

      localStorage.setItem(STORAGE_PREFIX + 'state', JSON.stringify(toSave));
      localStorage.setItem(STORAGE_PREFIX + 'lastSave', Date.now().toString());
    } catch (error) {
      console.error('[STORE] Save error', error);
    }
  }

  _loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_PREFIX + 'state');
      if (!saved) return null;

      const state = JSON.parse(saved);

      // Validate version
      if (state._meta?.version !== STORE_VERSION) {
        console.warn('[STORE] State version mismatch, resetting');
        return null;
      }

      return state;
    } catch (error) {
      console.error('[STORE] Load error', error);
      return null;
    }
  }

  // ── Network Handlers ───────────────────────────────────────────────────

  _setupNetworkHandlers() {
    window.addEventListener('online', () => {
      this.dispatch('SET_ONLINE', true);
    });

    window.addEventListener('offline', () => {
      this.dispatch('SET_ONLINE', false);
    });
  }

  // ── Middleware ─────────────────────────────────────────────────────────

  /**
   * Thêm middleware
   */
  use(middleware) {
    this._middleware.push(middleware);
  }

  // ── Computed Values ────────────────────────────────────────────────────

  /**
   * Lấy今天的销售统计
   */
  getTodayStats() {
    const today = new Date().toISOString().split('T')[0];
    const todaySales = this._state.sales.filter(s => s.date === today);

    const revenue = todaySales.reduce((sum, s) => sum + (s.total || 0), 0);
    const profit = todaySales.reduce((sum, s) => sum + (s.profit || 0), 0);
    const expense = this._state.expenses
      .filter(e => e.date === today)
      .reduce((sum, e) => sum + (e.amount || 0), 0);

    return {
      revenue,
      profit,
      expense,
      netProfit: revenue - expense,
      salesCount: todaySales.length,
    };
  }

  /**
   * Lấy客户by ID
   */
  getCustomer(id) {
    return this._state._entityMaps.customers[id] || null;
  }

  /**
   * Lấy产品by ID
   */
  getProduct(id) {
    return this._state._entityMaps.products[id] || null;
  }

  /**
   * Tìm客户theo số điện thoại
   */
  findCustomerByPhone(phone) {
    const normalized = phone.replace(/\D/g, '');
    return this._state.customers.find(c => {
      const customerPhone = (c.phone || '').replace(/\D/g, '');
      return customerPhone.includes(normalized) || normalized.includes(customerPhone);
    });
  }

  /**
   * Lấy低库存产品
   */
  getLowStockProducts(threshold = 10) {
    return this._state.products.filter(p => p.stock <= threshold);
  }

  // ── Action Creators ────────────────────────────────────────────────────

  /**
   * Khởi tạo store với dữ liệu từ server
   */
  async initialize() {
    this.dispatch('SET_LOADING', true);

    try {
      // Load all entities in parallel
      const [customers, products, expenses] = await Promise.all([
        fetch('/api/customers?fields=id,name,phone,address,debt,deposit,keg_balance,lat,lng,last_order_date').then(r => r.json()),
        fetch('/api/products').then(r => r.json()),
        fetch('/api/expenses/today').then(r => r.json()),
      ]);

      // Handle different response formats
      const customerList = customers.customers || customers || [];
      const productList = Array.isArray(products) ? products : products.products || [];
      const expenseList = expenses.expenses || [];

      this.dispatch('LOAD_STATE', {
        customers: customerList,
        products: productList,
        expenses: expenseList,
        session: {
          id: 'session_' + Date.now(),
          date: new Date().toISOString().split('T')[0],
        },
      });

      this.dispatch('SET_LAST_SYNC', Date.now());
    } catch (error) {
      this.dispatch('SET_ERROR', error.message);
      console.error('[STORE] Init error', error);
    } finally {
      this.dispatch('SET_LOADING', false);
    }
  }

  /**
   * Refresh data từ server
   */
  async refresh() {
    return this.initialize();
  }

  /**
   * Xóa cache
   */
  clearCache() {
    localStorage.removeItem(STORAGE_PREFIX + 'state');
    this._state = this._cloneDeep(initialState);
    this._notify();
  }
}

// ── Create Singleton ────────────────────────────────────────────────────────────

const store = new BeerStore();

// ── Middleware: Sync Queue ─────────────────────────────────────────────────────

store.use((action, state) => {
  // Add write actions to sync queue
  const syncActions = [
    'ADD_SALE', 'UPDATE_SALE', 'REMOVE_SALE',
    'ADD_CUSTOMER', 'UPDATE_CUSTOMER', 'REMOVE_CUSTOMER',
    'ADD_PRODUCT', 'UPDATE_PRODUCT',
    'ADD_EXPENSE', 'UPDATE_EXPENSE', 'REMOVE_EXPENSE',
    'ADD_PAYMENT',
    'ADD_PURCHASE',
  ];

  if (syncActions.includes(action.type)) {
    // In a real app, this would add to SyncEngine queue
    console.debug('[SYNC] Queued action:', action.type);
  }
});

// ── Middleware: Persistence ─────────────────────────────────────────────────────

store.use((action, state) => {
  // Auto-persist on entity changes
  const persistActions = [
    'SET_SESSION', 'UPDATE_SESSION',
    'SET_FILTERS',
  ];

  if (persistActions.includes(action.type)) {
    store._saveState();
  }
});

// ── Export ────────────────────────────────────────────────────────────────────

// Global access
window.BeerStore = store;
window.Store = store;

// Also export class for testing
window.BeerStoreClass = BeerStore;
window.initialState = initialState;

console.log('[STORE] BeerStore v' + STORE_VERSION + ' initialized');
