/**
 * BeerPOS - Enhanced API Client
 * ─────────────────────────────────────────────────────────────────────────────
 * API client mới với:
 * - Full state hoặc delta responses
 * - Automatic retry on failure
 * - Request/Response caching
 * - Offline queue support
 * - Action logging integration
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function() {
  'use strict';

  // ── Constants ───────────────────────────────────────────────────────────────

  const API_VERSION = 'v2';
  const DEFAULT_TIMEOUT = 30000;
  const RETRY_DELAYS = [1000, 2000, 5000];

  // ── API Client Class ──────────────────────────────────────────────────────

  class ApiClient {
    constructor(options = {}) {
      this.baseUrl = options.baseUrl || '';
      this.timeout = options.timeout || DEFAULT_TIMEOUT;
      this.defaultHeaders = {
        'Content-Type': 'application/json',
        'X-API-Version': API_VERSION,
      };
      this._cache = new Map();
      this._pendingRequests = new Map();
    }

    // ── Core Request Methods ───────────────────────────────────────────────

    /**
     * GET request
     */
    async get(endpoint, options = {}) {
      const { params, useCache = false, cacheTime = 5000 } = options;

      let url = this._buildUrl(endpoint, params);

      // Check cache
      if (useCache) {
        const cached = this._getFromCache(url);
        if (cached && Date.now() - cached.timestamp < cacheTime) {
          return cached.data;
        }
      }

      return this._request('GET', url, null, options);
    }

    /**
     * POST request
     */
    async post(endpoint, data, options = {}) {
      const url = this._buildUrl(endpoint);
      return this._request('POST', url, data, options);
    }

    /**
     * PUT request
     */
    async put(endpoint, data, options = {}) {
      const url = this._buildUrl(endpoint);
      return this._request('PUT', url, data, options);
    }

    /**
     * DELETE request
     */
    async del(endpoint, options = {}) {
      const url = this._buildUrl(endpoint);
      return this._request('DELETE', url, null, options);
    }

    /**
     * PATCH request
     */
    async patch(endpoint, data, options = {}) {
      const url = this._buildUrl(endpoint);
      return this._request('PATCH', url, data, options);
    }

    // ── Request Implementation ────────────────────────────────────────────

    async _request(method, url, data, options = {}) {
      const {
        headers = {},
        retries = 0,
        timeout = this.timeout,
        signal = null,
      } = options;

      const requestKey = `${method}:${url}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        // Deduplicate concurrent requests
        if (method === 'GET' && this._pendingRequests.has(requestKey)) {
          return this._pendingRequests.get(requestKey);
        }

        const requestPromise = this._doRequest(method, url, data, {
          ...options,
          headers: { ...this.defaultHeaders, ...headers },
          signal: signal || controller.signal,
        });

        if (method === 'GET') {
          this._pendingRequests.set(requestKey, requestPromise);
        }

        let result = await requestPromise;

        // Clear cache for mutation requests
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
          this._clearCacheForEndpoint(url);
        }

        return result;

      } catch (error) {
        // Retry logic
        if (retries > 0 && this._shouldRetry(error)) {
          console.log(`[API] Retrying ${method} ${url} (${retries} attempts left)`);
          await this._delay(RETRY_DELAYS[3 - retries] || 5000);
          return this._request(method, url, data, { ...options, retries: retries - 1 });
        }

        throw this._formatError(error);

      } finally {
        clearTimeout(timeoutId);
        this._pendingRequests.delete(requestKey);
      }
    }

    async _doRequest(method, url, data, options) {
      const { headers, signal } = options;

      const config = {
        method,
        headers,
        signal,
        cache: 'no-store',
      };

      if (data && !['GET', 'HEAD'].includes(method)) {
        config.body = JSON.stringify(data);
      }

      const response = await fetch(url, config);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(errorData.error || `HTTP ${response.status}`);
        error.status = response.status;
        error.data = errorData;
        throw error;
      }

      // Check for no content
      if (response.status === 204) {
        return { success: true };
      }

      const result = await response.json();

      // Cache GET responses
      if (method === 'GET' && options.useCache) {
        this._setCache(url, result);
      }

      return result;
    }

    // ── URL Building ──────────────────────────────────────────────────────

    _buildUrl(endpoint, params = {}) {
      const base = this.baseUrl || '';
      let url = endpoint.startsWith('http') ? endpoint : `${base}${endpoint}`;

      if (Object.keys(params).length > 0) {
        const searchParams = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined && value !== null && value !== '') {
            searchParams.append(key, value);
          }
        }
        const queryString = searchParams.toString();
        if (queryString) {
          url += (url.includes('?') ? '&' : '?') + queryString;
        }
      }

      return url;
    }

    // ── Error Handling ────────────────────────────────────────────────────

    _shouldRetry(error) {
      // Retry on network errors and 5xx errors
      if (error.name === 'AbortError') return false;
      if (error.status >= 500) return true;
      if (error.message === 'Failed to fetch') return true;
      if (error.message === 'Network request failed') return true;
      return false;
    }

    _formatError(error) {
      if (error.name === 'AbortError') {
        error.message = 'Yêu cầu bị hủy do timeout';
        error.timeout = true;
      }
      return error;
    }

    _delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ── Cache ──────────────────────────────────────────────────────────────

    _getFromCache(url) {
      return this._cache.get(url);
    }

    _setCache(url, data) {
      this._cache.set(url, {
        data,
        timestamp: Date.now(),
      });

      // Cleanup old entries
      if (this._cache.size > 100) {
        const oldest = [...this._cache.entries()]
          .sort((a, b) => a[1].timestamp - b[1].timestamp)
          .slice(0, 10);
        oldest.forEach(([key]) => this._cache.delete(key));
      }
    }

    _clearCacheForEndpoint(url) {
      const basePattern = url.split('?')[0];
      for (const key of this._cache.keys()) {
        if (key.startsWith(basePattern)) {
          this._cache.delete(key);
        }
      }
    }

    clearCache() {
      this._cache.clear();
    }
  }

  // ── API Instance ─────────────────────────────────────────────────────────

  const Api = new ApiClient();

  // ── Resource API (Object-oriented) ──────────────────────────────────────

  Api.customers = {
    list: (params) => Api.get('/api/customers', { params, useCache: true }),
    get: (id) => Api.get(`/api/customers/${id}`),
    create: (data) => Api.post('/api/customers', data),
    update: (id, data) => Api.put(`/api/customers/${id}`, data),
    delete: (id) => Api.del(`/api/customers/${id}`),
    archive: (id) => Api.put(`/api/customers/${id}/archive`),
    getStats: (id) => Api.get(`/api/customers/${id}/stats`),
    getSales: (id, params) => Api.get(`/api/customers/${id}/sales`, { params }),
  };

  Api.products = {
    list: (params) => Api.get('/api/products', { params, useCache: true }),
    get: (id) => Api.get(`/api/products/${id}`),
    create: (data) => Api.post('/api/products', data),
    update: (id, data) => Api.put(`/api/products/${id}`, data),
    delete: (id) => Api.del(`/api/products/${id}`),
    getPrices: (customerId) => Api.get(`/api/products/prices`, { params: { customerId } }),
    setPrice: (data) => Api.post('/api/products/prices', data),
  };

  Api.sales = {
    list: (params) => Api.get('/api/sales', { params, useCache: false }),
    get: (id) => Api.get(`/api/sales/${id}`),
    create: (data) => Api.post('/api/sales', data),
    update: (id, data) => Api.put(`/api/sales/${id}`, data),
    delete: (id) => Api.del(`/api/sales/${id}`),
    return: (id, data) => Api.post(`/api/sales/${id}/return`, data),
    returnItems: (id, data) => Api.post(`/api/sales/${id}/return-items`, data),
    updateKegs: (data) => Api.post('/api/sales/update-kegs', data),
    replacement: (data) => Api.post('/api/sales/replacement', data),
  };

  Api.expenses = {
    list: (params) => Api.get('/api/expenses', { params }),
    get: (id) => Api.get(`/api/expenses/${id}`),
    create: (data) => Api.post('/api/expenses', data),
    quickCreate: (data) => Api.post('/api/expenses/quick', data),
    update: (id, data) => Api.put(`/api/expenses/${id}`, data),
    delete: (id) => Api.del(`/api/expenses/${id}`),
    today: () => Api.get('/api/expenses/today', { useCache: false }),
    summary: (params) => Api.get('/api/expenses/summary', { params }),
    total: (params) => Api.get('/api/expenses/total', { params }),
  };

  Api.stock = {
    alerts: (threshold) => Api.get('/api/stock/alerts', { params: { threshold } }),
    history: (productId, limit) => Api.get('/api/stock/history', { params: { productId, limit } }),
    import: (data) => Api.post('/api/stock', data),
    set: (data) => Api.post('/api/stock/set', data),
    importMultiple: (data) => Api.post('/api/stock/multiple', data),
  };

  Api.payments = {
    list: (params) => Api.get('/api/payments', { params }),
    create: (data) => Api.post('/api/payments', data),
    getDebt: () => Api.get('/api/payments/debt'),
    update: (id, data) => Api.put(`/api/payments/${id}`, data),
    delete: (id) => Api.del(`/api/payments/${id}`),
  };

  Api.kegs = {
    getState: () => Api.get('/api/kegs/state'),
    getHistory: (params) => Api.get('/api/kegs/history', { params }),
    deliver: (data) => Api.post('/api/kegs/deliver', data),
    collect: (data) => Api.post('/api/kegs/collect', data),
    adjust: (data) => Api.post('/api/kegs/adjust', data),
  };

  Api.sync = {
    push: (data) => Api.post('/api/sync/push', data),
    pull: (data) => Api.post('/api/sync/pull', data),
    status: () => Api.get('/api/sync/status'),
    export: () => Api.get('/api/sync/export'),
  };

  Api.state = {
    /**
     * Lấy full state từ server
     */
    getFull: () => Api.get('/api/state/full'),

    /**
     * Lấy delta state kể từ lastSync
     */
    getDelta: (lastSync) => Api.get('/api/state/delta', { params: { lastSync } }),

    /**
     * Subscribe real-time state updates
     */
    subscribe: (callback) => {
      if (window.Realtime) {
        window.Realtime.addListener((event, data) => {
          if (event.startsWith('order:') || event.startsWith('expense:') ||
              event.startsWith('inventory:') || event.startsWith('keg:')) {
            callback({ event, data });
          }
        });
      }
    },
  };

  // ── Dashboard Helpers ────────────────────────────────────────────────────

  Api.dashboard = {
    getData: (params) => Api.get('/dashboard/data', { params }),
    getSummary: () => Api.get('/dashboard/summary'),
  };

  // ── Reports Helpers ─────────────────────────────────────────────────────

  Api.reports = {
    getData: (params) => Api.get('/report/data', { params }),
    export: (format, params) => Api.get(`/report/export/${format}`, { params }),
  };

  // ── Export ──────────────────────────────────────────────────────────────

  window.Api = Api;
  window.ApiClient = ApiClient;

  console.log('[API] BeerPOS API Client v' + API_VERSION + ' initialized');

})();
