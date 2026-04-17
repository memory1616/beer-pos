/**
 * BeerPOS State Management
 *
 * State management nhẹ, dùng Observer pattern.
 * Thay thế việc dùng window.store rải rác khắp nơi.
 *
 * FEATURES:
 * - Reactive state (subscribable)
 * - Automatic cache invalidation
 * - Computed properties (derived state)
 * - Persistence (localStorage)
 *
 * CÁCH DÙNG:
 * const state = require('./store');
 * state.set('cart', []);
 * state.subscribe('cart', (newVal) => render());
 * const items = state.get('cart');
 */

class StateStore {
  constructor() {
    this._state = {};
    this._subscribers = new Map();
    this._computed = new Map();
    this._persistenceKey = 'beerpos_state';
    this._persistedKeys = new Set(['settings', 'theme', 'user']);

    // Load persisted state
    this._loadPersisted();
  }

  /**
   * Set a value
   */
  set(key, value) {
    const oldValue = this._state[key];
    if (oldValue === value) return;

    this._state[key] = value;
    this._notify(key, value, oldValue);

    // Auto-persist
    if (this._persistedKeys.has(key)) {
      this._persist(key, value);
    }
  }

  /**
   * Get a value
   */
  get(key) {
    // Check computed first
    if (this._computed.has(key)) {
      const computed = this._computed.get(key);
      return computed();
    }
    return this._state[key];
  }

  /**
   * Get all state (snapshot)
   */
  getAll() {
    const snapshot = {};
    for (const key of Object.keys(this._state)) {
      snapshot[key] = this._state[key];
    }
    return snapshot;
  }

  /**
   * Subscribe to changes
   * @returns {Function} unsubscribe function
   */
  subscribe(key, callback) {
    if (!this._subscribers.has(key)) {
      this._subscribers.set(key, new Set());
    }
    this._subscribers.get(key).add(callback);

    return () => {
      this._subscribers.get(key)?.delete(callback);
    };
  }

  /**
   * Subscribe to any change
   */
  subscribeAny(callback) {
    if (!this._subscribers.has('*')) {
      this._subscribers.set('*', new Set());
    }
    this._subscribers.get('*').add(callback);

    return () => {
      this._subscribers.get('*')?.delete(callback);
    };
  }

  /**
   * Define computed (derived) property
   */
  defineComputed(key, computeFn) {
    this._computed.set(key, computeFn);
  }

  /**
   * Batch update (multiple keys at once)
   */
  batch(update) {
    const updates = typeof update === 'function' ? update(this._state) : update;

    for (const [key, value] of Object.entries(updates)) {
      this._state[key] = value;
    }

    // Notify for each changed key
    for (const key of Object.keys(updates)) {
      this._notify(key, updates[key], null);
    }
  }

  /**
   * Merge nested value (deep merge)
   */
  merge(key, value) {
    const current = this._state[key] || {};
    const merged = { ...current, ...value };
    this.set(key, merged);
  }

  /**
   * Push to array
   */
  push(key, item) {
    const arr = this._state[key] || [];
    const newArr = [...arr, item];
    this.set(key, newArr);
    return newArr;
  }

  /**
   * Update array item
   */
  updateArrayItem(key, predicate, updater) {
    const arr = this._state[key] || [];
    const newArr = arr.map(item =>
      predicate(item) ? (typeof updater === 'function' ? updater(item) : { ...item, ...updater }) : item
    );
    this.set(key, newArr);
    return newArr;
  }

  /**
   * Remove from array
   */
  removeFromArray(key, predicate) {
    const arr = this._state[key] || [];
    const newArr = arr.filter(item => !predicate(item));
    this.set(key, newArr);
    return newArr;
  }

  /**
   * Clear all state
   */
  clear() {
    this._state = {};
    this._notify('*', null, null);
  }

  /**
   * Notify subscribers
   */
  _notify(key, newValue, oldValue) {
    // Key-specific subscribers
    this._subscribers.get(key)?.forEach(cb => {
      try { cb(newValue, oldValue); } catch (e) { console.error('State subscriber error:', e); }
    });

    // Global subscribers
    this._subscribers.get('*')?.forEach(cb => {
      try { cb({ key, value: newValue, oldValue }); } catch (e) { console.error('State subscriber error:', e); }
    });
  }

  /**
   * Persist to localStorage
   */
  _persist(key, value) {
    if (typeof localStorage === 'undefined') return;
    try {
      const stored = JSON.parse(localStorage.getItem(this._persistenceKey) || '{}');
      stored[key] = value;
      localStorage.setItem(this._persistenceKey, JSON.stringify(stored));
    } catch (e) {
      console.warn('State persistence error:', e);
    }
  }

  /**
   * Load from localStorage
   */
  _loadPersisted() {
    if (typeof localStorage === 'undefined') return;
    try {
      const stored = JSON.parse(localStorage.getItem(this._persistenceKey) || '{}');
      for (const [key, value] of Object.entries(stored)) {
        if (this._persistedKeys.has(key)) {
          this._state[key] = value;
        }
      }
    } catch (e) {
      console.warn('State load error:', e);
    }
  }
}

// ============================================================
// PREDEFINED STORES - Common state patterns
// ============================================================

// Cart Store (for POS)
function createCartStore(baseStore) {
  baseStore.defineComputed('cartTotal', () => {
    const items = baseStore.get('cartItems') || [];
    return items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  });

  baseStore.defineComputed('cartProfit', () => {
    const items = baseStore.get('cartItems') || [];
    return items.reduce((sum, item) => {
      const profit = item.profit || ((item.price - (item.costPrice || 0)) * item.quantity);
      return sum + profit;
    }, 0);
  });

  baseStore.defineComputed('cartItemCount', () => {
    const items = baseStore.get('cartItems') || [];
    return items.reduce((sum, item) => sum + item.quantity, 0);
  });

  return {
    addItem(item) {
      const items = baseStore.get('cartItems') || [];
      const existing = items.find(i => i.productId === item.productId);

      if (existing) {
        baseStore.updateArrayItem('cartItems',
          i => i.productId === item.productId,
          i => ({ ...i, quantity: i.quantity + item.quantity })
        );
      } else {
        baseStore.push('cartItems', {
          id: Date.now(),
          productId: item.productId,
          productSlug: item.productSlug,
          productName: item.productName,
          price: item.price,
          costPrice: item.costPrice,
          quantity: item.quantity || 1
        });
      }
    },

    updateQuantity(productId, quantity) {
      if (quantity <= 0) {
        baseStore.removeFromArray('cartItems', i => i.productId === productId);
      } else {
        baseStore.updateArrayItem('cartItems',
          i => i.productId === productId,
          i => ({ ...i, quantity })
        );
      }
    },

    removeItem(productId) {
      baseStore.removeFromArray('cartItems', i => i.productId === productId);
    },

    clearCart() {
      baseStore.set('cartItems', []);
      baseStore.set('cartCustomer', null);
      baseStore.set('cartDiscount', 0);
      baseStore.set('cartPromotions', []);
    },

    setCustomer(customer) {
      baseStore.set('cartCustomer', customer);
    },

    applyDiscount(amount, promotions = []) {
      baseStore.set('cartDiscount', amount);
      baseStore.set('cartPromotions', promotions);
    }
  };
}

// ============================================================
// EXPORT
// ============================================================
const store = new StateStore();
const cartActions = createCartStore(store);

// Export as singleton
module.exports = {
  store,
  cart: cartActions,

  // Helper to create scoped store
  createStore() {
    return new StateStore();
  }
};
