/**
 * BeerPOS - Standardized API Client
 * 所有API调用都通过这个模块，统一管理。
 */
const Api = {
  /**
   * GET request
   * @param {string} url
   * @param {object} [options]
   * @returns {Promise<any>}
   */
  async get(url, options = {}) {
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      ...options
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /**
   * POST request
   * @param {string} url
   * @param {object} body
   * @param {object} [options]
   * @returns {Promise<any>}
   */
  async post(url, body, options = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      ...options
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  },

  /**
   * PUT request
   * @param {string} url
   * @param {object} body
   * @param {object} [options]
   * @returns {Promise<any>}
   */
  async put(url, body, options = {}) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      ...options
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  },

  /**
   * DELETE request
   * @param {string} url
   * @param {object} [options]
   * @returns {Promise<any>}
   */
  async del(url, options = {}) {
    const res = await fetch(url, {
      method: 'DELETE',
      cache: 'no-store',
      ...options
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }
};

window.Api = Api;