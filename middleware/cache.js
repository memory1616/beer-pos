/**
 * Beer POS - In-Memory Cache
 * Simple TTL-based cache for frequent queries
 */

const logger = require('../src/utils/logger');

class Cache {
  constructor(options = {}) {
    this.cache = new Map();
    this.ttl = options.ttl || 60000; // Default: 60 seconds
    this.maxSize = options.maxSize || 1000;
    this.enabled = options.enabled !== false;

    // Cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Get value from cache
   */
  get(key) {
    if (!this.enabled) return null;

    const item = this.cache.get(key);
    if (!item) return null;

    // Check expiration
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return item.value;
  }

  /**
   * Set value in cache
   */
  set(key, value, options = {}) {
    if (!this.enabled) return;

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    const ttl = options.ttl || this.ttl;
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttl
    });
  }

  /**
   * Delete specific key
   */
  delete(key) {
    return this.cache.delete(key);
  }

  /**
   * Clear all cache
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Delete keys matching pattern
   */
  invalidate(pattern) {
    const regex = typeof pattern === 'string' 
      ? new RegExp(pattern) 
      : pattern;
    
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Cleanup expired entries
   */
  cleanup() {
    const now = Date.now();
    let deleted = 0;

    for (const [key, item] of this.cache.entries()) {
      if (now > item.expiresAt) {
        this.cache.delete(key);
        deleted++;
      }
    }

    if (deleted > 0) {
      logger.debug(`Cache cleanup: removed ${deleted} expired entries`);
    }
  }

  /**
   * Get cache stats
   */
  stats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.ttl,
      enabled: this.enabled
    };
  }

  /**
   * Stop cleanup interval (call on shutdown)
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.cache.clear();
  }
}

// Create global cache instance
const globalCache = new Cache({
  ttl: 60000, // 1 minute default
  maxSize: 500
});

/**
 * Cache middleware for Express
 * Usage: router.get('/data', cache.middleware('key', 60000), handler)
 */
function cacheMiddleware(keyOrFn, ttl = 60000) {
  return (req, res, next) => {
    const key = typeof keyOrFn === 'function' 
      ? keyOrFn(req) 
      : `${keyOrFn}:${JSON.stringify(req.query)}`;

    const cached = globalCache.get(key);
    if (cached) {
      return res.json(cached);
    }

    // Override res.json to cache the response
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      if (res.statusCode === 200 && data.success !== false) {
        globalCache.set(key, data, { ttl });
      }
      return originalJson(data);
    };

    next();
  };
}

/**
 * Decorator for caching expensive function results
 */
function cached(fn, keyFn, ttl) {
  return async (...args) => {
    const key = keyFn ? keyFn(...args) : JSON.stringify(args);
    const cached = globalCache.get(key);
    if (cached !== null) return cached;

    const result = await fn(...args);
    globalCache.set(key, result, { ttl });
    return result;
  };
}

module.exports = {
  Cache,
  cache: globalCache,
  cacheMiddleware,
  cached
};
