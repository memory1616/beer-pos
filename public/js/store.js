/**
 * Beer POS - Centralized State Store
 * Provides single source of truth with auto-save functionality
 * @module public/js/store
 */

// Storage prefix
const STORAGE_PREFIX = 'beer_pos_';

// Centralized state store
const BeerStore = {
  // Internal state
  _state: {
    session: null,
    orders: [],
    expenses: [],
    products: [],
    customers: [],
    isLoading: false,
    lastSync: null
  },
  
  // Subscribers
  _listeners: [],
  
  /**
   * Initialize store with data from server
   */
  async init() {
    try {
      this._state.isLoading = true;
      this._notify();
      
      // Try to load cached session
      const cachedSession = this._loadFromStorage('current_session');
      if (cachedSession) {
        this._state.session = cachedSession;
      }
      
      // Load today's data from server
      await this._fetchTodayData();
      
      // Mark as initialized
      this._state.lastSync = Date.now();
      this._saveToStorage('current_session', this._state.session);
      
    } catch (error) {
      console.error('Store init error:', error);
    } finally {
      this._state.isLoading = false;
      this._notify();
    }
  },
  
  /**
   * Fetch today's data from server
   */
  async _fetchTodayData() {
    try {
      // Fetch today's expenses — use cache: 'no-store' to always get fresh data
      const expenseRes = await fetch('/api/expenses/today', { cache: 'no-store' });
      const expenseData = await expenseRes.json();
      this._state.expenses = expenseData.expenses || [];

      // Fetch today's sales — use cache: 'no-store' to always get fresh data
      const salesRes = await fetch('/api/sales?page=1&limit=100&month=' + new Date().toISOString().slice(0, 7), { cache: 'no-store' });
      const salesData = await salesRes.json();
      this._state.orders = salesData.sales || [];
      
      // Create/update session
      const today = new Date().toISOString().split('T')[0];
      const totalRevenue = this._state.orders.reduce((sum, o) => sum + (o.total || 0), 0);
      const totalExpense = this._state.expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
      
      this._state.session = {
        id: this._state.session?.id || 'session_' + Date.now(),
        date: today,
        orders: this._state.orders,
        expenses: this._state.expenses,
        totalRevenue,
        totalExpense,
        profit: totalRevenue - totalExpense,
        updatedAt: Date.now()
      };
      
    } catch (error) {
      console.error('Fetch today data error:', error);
    }
  },
  
  /**
   * Subscribe to state changes
   */
  subscribe(listener) {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter(l => l !== listener);
    };
  },
  
  /**
   * Notify all subscribers
   */
  _notify() {
    this._listeners.forEach(listener => listener(this._state));
  },
  
  /**
   * Get current state
   */
  getState() {
    return { ...this._state };
  },
  
  /**
   * Get session
   */
  getSession() {
    return this._state.session;
  },
  
  /**
   * Get today's orders
   */
  getOrders() {
    return [...this._state.orders];
  },
  
  /**
   * Get today's expenses
   */
  getExpenses() {
    return [...this._state.expenses];
  },
  
  /**
   * Add order (auto-save)
   */
  async addOrder(orderData) {
    try {
      // Save to server — use cache: 'no-store' to ensure fresh data
      const res = await fetch('/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderData),
        cache: 'no-store'
      });
      
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to create order');
      }
      
      const result = await res.json();
      
      // Add to local state
      const newOrder = {
        id: result.id,
        ...orderData,
        total: result.total,
        date: new Date().toISOString()
      };
      
      this._state.orders = [newOrder, ...this._state.orders];
      this._updateSessionStats();
      this._notify();
      
      // Auto-save to localStorage
      this._saveToStorage('current_session', this._state.session);
      this._saveToStorage('orders_cache', this._state.orders);
      
      return result;
    } catch (error) {
      console.error('Add order error:', error);
      throw error;
    }
  },
  
  /**
   * Add expense (auto-save)
   */
  async addExpense(expenseData) {
    try {
      // Save to server — use cache: 'no-store' to ensure fresh data
      const res = await fetch('/api/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(expenseData),
        cache: 'no-store'
      });
      
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to create expense');
      }
      
      const result = await res.json();
      
      // Add to local state
      const newExpense = {
        id: result.id,
        ...expenseData,
        date: new Date().toISOString().split('T')[0]
      };
      
      this._state.expenses = [newExpense, ...this._state.expenses];
      this._updateSessionStats();
      this._notify();
      
      // Auto-save to localStorage
      this._saveToStorage('current_session', this._state.session);
      this._saveToStorage('expenses_cache', this._state.expenses);
      
      return result;
    } catch (error) {
      console.error('Add expense error:', error);
      throw error;
    }
  },
  
  /**
   * Update session stats
   */
  _updateSessionStats() {
    if (!this._state.session) return;
    
    const totalRevenue = this._state.orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const totalExpense = this._state.expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
    
    this._state.session = {
      ...this._state.session,
      orders: this._state.orders,
      expenses: this._state.expenses,
      totalRevenue,
      totalExpense,
      profit: totalRevenue - totalExpense,
      updatedAt: Date.now()
    };
  },
  
  /**
   * Save to localStorage (auto-save)
   */
  _saveToStorage(key, data) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(data));
    } catch (e) {
      console.error('Storage save error:', e);
    }
  },
  
  /**
   * Load from localStorage
   */
  _loadFromStorage(key, defaultValue = null) {
    try {
      const item = localStorage.getItem(STORAGE_PREFIX + key);
      return item ? JSON.parse(item) : defaultValue;
    } catch (e) {
      console.error('Storage load error:', e);
      return defaultValue;
    }
  },
  
  /**
   * Refresh data from server
   */
  async refresh() {
    await this._fetchTodayData();
    this._notify();
    this._saveToStorage('current_session', this._state.session);
  },

  setSlice(key, value) {
    this._state[key] = Array.isArray(value) ? value.slice() : value;
    this._notify();
  },

  getSlice(key) {
    const value = this._state[key];
    return Array.isArray(value) ? value.slice() : value;
  },

  async invalidateAndRefresh(label) {
    try {
      // Step 1: Clear ALL browser caches that might contain stale API data
      if (typeof caches !== 'undefined') {
        const cacheNames = await caches.keys();
        for (const cacheName of cacheNames) {
          const cache = await caches.open(cacheName);
          const keys = await cache.keys();
          await Promise.all(keys.map(async req => {
            const path = new URL(req.url).pathname;
            if (
              path.startsWith('/api/') ||
              path.startsWith('/dashboard/') ||
              path.startsWith('/report/')
            ) {
              await cache.delete(req);
            }
          }));
        }
      }

      // Step 2: Clear Service Worker IndexedDB cache entries
      try {
        const swDb = indexedDB.open('BeerPOS', 1);
        swDb.onsuccess = () => {
          const db = swDb.result;
          // Delete cached data in sync_queue store if exists
          if (db.objectStoreNames.contains('sync_queue')) {
            const tx = db.transaction('sync_queue', 'readwrite');
            tx.objectStore('sync_queue').clear();
          }
          db.close();
        };
      } catch (e) { /* silent */ }

      // Step 3: Clear localStorage caches
      this._state.orders = [];
      this._state.expenses = [];
      this._state.session = null;

      // Step 4: Reload page to ensure fresh state
      window.location.reload();
    } catch (e) {
      console.warn('[CONSISTENCY][Store] cache invalidate failed', label || '', e);
    }
  },
  
  /**
   * Get stats (computed)
   */
  getStats() {
    const revenue = this._state.orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const expense = this._state.expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
    const units = this._state.orders.reduce((sum, o) => {
      if (o.items && Array.isArray(o.items)) {
        return sum + o.items.reduce((itemSum, item) => itemSum + (item.quantity || 0), 0);
      }
      return sum;
    }, 0);
    
    return {
      revenue,
      expense,
      profit: revenue - expense,
      units,
      orderCount: this._state.orders.length,
      expenseCount: this._state.expenses.length
    };
  },
  
  /**
   * Clear all cached data
   */
  clearCache() {
    localStorage.removeItem(STORAGE_PREFIX + 'current_session');
    localStorage.removeItem(STORAGE_PREFIX + 'orders_cache');
    localStorage.removeItem(STORAGE_PREFIX + 'expenses_cache');
    this._state.session = null;
    this._state.orders = [];
    this._state.expenses = [];
    this._notify();
  }
};

// Export for use in other scripts
window.BeerStore = BeerStore;

// Auto-initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => BeerStore.init());
} else {
  BeerStore.init();
}
