/**
 * BeerPOS Cache Layer
 *
 * Memory-based cache với TTL và invalidation.
 * Giải quyết vấn đề: "refetch full data on every refresh"
 *
 * FEATURES:
 * - TTL (time-to-live) cache
 * - Key patterns for invalidation
 * - Stale-while-revalidate pattern
 * - Memory usage tracking
 */

class CacheLayer {
  constructor() {
    this._cache = new Map();
    this._ttl = new Map();
    this._maxSize = 100; // Max cached items
    this._hits = 0;
    this._misses = 0;
  }

  /**
   * Set cache with TTL
   * @param {string} key
   * @param {any} value
   * @param {number} ttlSeconds - Time to live in seconds
   */
  set(key, value, ttlSeconds = 300) {
    // Evict oldest if full
    if (this._cache.size >= this._maxSize) {
      this._evictOldest();
    }

    this._cache.set(key, {
      value,
      timestamp: Date.now(),
      size: this._estimateSize(value)
    });

    this._ttl.set(key, ttlSeconds * 1000);
  }

  /**
   * Get cache, returns null if expired/missing
   * @param {string} key
   * @returns {any|null}
   */
  get(key) {
    if (!this._cache.has(key)) {
      this._misses++;
      return null;
    }

    const entry = this._cache.get(key);
    const ttl = this._ttl.get(key) || 0;

    // Check expiration
    if (Date.now() - entry.timestamp > ttl) {
      this._cache.delete(key);
      this._ttl.delete(key);
      this._misses++;
      return null;
    }

    this._hits++;
    return entry.value;
  }

  /**
   * Get with stale-while-revalidate
   * Returns cached value immediately, triggers async refresh
   */
  async getStale(key, fetchFn, ttlSeconds = 300) {
    const cached = this.get(key);

    if (cached !== null) {
      return { data: cached, isFresh: true };
    }

    // No cache - fetch fresh
    if (fetchFn) {
      try {
        const freshData = await fetchFn();
        this.set(key, freshData, ttlSeconds);
        return { data: freshData, isFresh: true };
      } catch (e) {
        console.error('Cache fetch error:', e);
        return { data: null, isFresh: false };
      }
    }

    return { data: null, isFresh: false };
  }

  /**
   * Check if key exists (even if stale)
   */
  has(key) {
    return this._cache.has(key);
  }

  /**
   * Delete specific key
   */
  delete(key) {
    this._cache.delete(key);
    this._ttl.delete(key);
  }

  /**
   * Invalidate by pattern
   * @param {string} pattern - e.g., 'products_*', 'customer_*'
   */
  invalidatePattern(pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');

    for (const key of this._cache.keys()) {
      if (regex.test(key)) {
        this._cache.delete(key);
        this._ttl.delete(key);
      }
    }
  }

  /**
   * Invalidate all
   */
  clear() {
    this._cache.clear();
    this._ttl.clear();
  }

  /**
   * Refresh specific key
   */
  async refresh(key, fetchFn, ttlSeconds = 300) {
    this.delete(key);
    if (fetchFn) {
      const data = await fetchFn();
      this.set(key, data, ttlSeconds);
      return data;
    }
    return null;
  }

  /**
   * Get cache stats
   */
  getStats() {
    return {
      size: this._cache.size,
      maxSize: this._maxSize,
      hits: this._hits,
      misses: this._misses,
      hitRate: this._hits / (this._hits + this._misses) || 0
    };
  }

  /**
   * Evict oldest entry
   */
  _evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this._cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this._cache.delete(oldestKey);
      this._ttl.delete(oldestKey);
    }
  }

  /**
   * Rough size estimation (bytes)
   */
  _estimateSize(value) {
    return JSON.stringify(value).length * 2; // UTF-16
  }
}

// ============================================================
// PREBUILT CACHE KEYS
// ============================================================
const CacheKeys = {
  PRODUCTS: 'products:all',
  PRODUCT: (id) => `product:${id}`,
  CUSTOMERS: 'customers:all',
  CUSTOMER: (id) => `customer:${id}`,
  CUSTOMER_PRICES: (id) => `customer:${id}:prices`,
  KEG_STATS: 'keg:stats',
  SETTINGS: 'settings:all',
  DASHBOARD: (period) => `dashboard:${period}`,
  ANALYTICS: (type, period) => `analytics:${type}:${period}`,
  PROMOTIONS: 'promotions:active',
  LOW_STOCK: 'products:low_stock'
};

// ============================================================
// HTTP CACHE - Browser-side caching
// ============================================================
const HttpCache = {
  /**
   * Cache API response in sessionStorage
   */
  set(key, data, ttlSeconds = 60) {
    const entry = {
      data,
      expires: Date.now() + (ttlSeconds * 1000)
    };
    try {
      sessionStorage.setItem(`http_cache:${key}`, JSON.stringify(entry));
    } catch (e) {
      // Storage full - clear old entries
      this.clear();
      sessionStorage.setItem(`http_cache:${key}`, JSON.stringify(entry));
    }
  },

  /**
   * Get cached response
   */
  get(key) {
    try {
      const raw = sessionStorage.getItem(`http_cache:${key}`);
      if (!raw) return null;

      const entry = JSON.parse(raw);
      if (Date.now() > entry.expires) {
        sessionStorage.removeItem(`http_cache:${key}`);
        return null;
      }

      return entry.data;
    } catch (e) {
      return null;
    }
  },

  /**
   * Clear all
   */
  clear() {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith('http_cache:')) {
        sessionStorage.removeItem(key);
      }
    }
  }
};

// ============================================================
// API BATCH CACHE - Batch multiple requests
// ============================================================
class BatchCache {
  constructor() {
    this._pending = new Map();
    this._timers = new Map();
  }

  /**
   * Queue request for batching
   * @param {Object} request - { key, url, params }
   * @param {Function} executor - returns Promise
   */
  queue(request, executor) {
    return new Promise((resolve, reject) => {
      const key = request.key || request.url;

      if (!this._pending.has(key)) {
        this._pending.set(key, { request, resolve, reject, executors: [executor] });
      } else {
        // Add to existing batch
        this._pending.get(key).executors.push(executor);
      }

      // Debounce batch execution
      if (this._timers.has(key)) {
        clearTimeout(this._timers.get(key));
      }

      this._timers.set(key, setTimeout(() => {
        this._executeBatch(key);
      }, 50)); // Batch requests within 50ms window
    });
  }

  async _executeBatch(key) {
    const batch = this._pending.get(key);
    if (!batch) return;

    this._pending.delete(key);
    this._timers.delete(key);

    try {
      const result = await batch.executors[0]();
      // Resolve all pending requests with same result
      batch.executors.forEach(exec => exec.resolve(result));
    } catch (e) {
      batch.executors.forEach(exec => exec.reject(e));
    }
  }
}

// ============================================================
// EXPORT
// ============================================================
const cache = new CacheLayer();
const batchCache = new BatchCache();

module.exports = {
  cache,
  cacheKeys: CacheKeys,
  httpCache: HttpCache,
  batchCache: BatchCache
};
