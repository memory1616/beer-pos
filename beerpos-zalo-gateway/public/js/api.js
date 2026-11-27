/* API client cho Gateway UI.
 * API key nhập 1 lần, lưu trong sessionStorage (KHONG localStorage,
 * KHONG hardcode trong source). */
(function () {
  'use strict';

  const KEY_NAME = 'gateway_admin_key';

  function getKey() {
    try {
      return sessionStorage.getItem(KEY_NAME) || '';
    } catch (_) {
      return '';
    }
  }

  function setKey(v) {
    try {
      if (v) sessionStorage.setItem(KEY_NAME, v);
      else sessionStorage.removeItem(KEY_NAME);
    } catch (_) {
      /* ignore */
    }
  }

  async function request(method, path, body, opts) {
    const options = opts || {};
    const headers = { Accept: 'application/json' };
    const key = options.key || getKey();
    if (key) headers['X-API-Key'] = key;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    let payload;
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') {
        headers['Content-Type'] = 'text/csv';
        payload = body;
      } else {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }

    let res;
    try {
      res = await fetch(path, { method, headers, body: payload });
    } catch (e) {
      throw new Error('Không kết nối được tới Gateway: ' + e.message);
    }

    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = { raw: text };
      }
    }

    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data && data.code;
      err.data = data;
      throw err;
    }
    return data;
  }

  window.GwApi = {
    getKey,
    setKey,
    health: () => request('GET', '/health'),
    dashboard: () => request('GET', '/api/dashboard'),
    accountStatus: () => request('GET', '/api/account/status'),
    setProvider: (provider) => request('POST', '/api/account/provider', { provider }),

    listGroups: (params) => {
      const q = new URLSearchParams(params || {}).toString();
      return request('GET', `/api/groups${q ? '?' + q : ''}`);
    },
    createGroup: (body) => request('POST', '/api/groups', body),
    updateGroup: (id, body) => request('PATCH', `/api/groups/${id}`, body),
    deleteGroup: (id) => request('DELETE', `/api/groups/${id}`),
    previewImport: (csv) => request('POST', '/api/groups/import/preview', csv),
    importCsv: (csv, dryRun) =>
      request('POST', `/api/groups/import${dryRun ? '?dryRun=true' : ''}`, csv),
    templateUrl: '/api/groups/template.csv',

    history: (params) => {
      const q = new URLSearchParams(params || {}).toString();
      return request('GET', `/api/messages/history${q ? '?' + q : ''}`);
    },
    jobDetail: (id) => request('GET', `/api/messages/jobs/${id}`),
    retryJob: (id) => request('POST', `/api/messages/jobs/${id}/retry`, {}),
    cancelJob: (id) => request('POST', `/api/messages/jobs/${id}/cancel`, {}),
    queueSummary: () => request('GET', '/api/messages/queue/summary'),

    settings: () => request('GET', '/api/settings'),
    updateSetting: (key, value) => request('PATCH', '/api/settings', { key, value }),
    auditLogs: (params) => {
      const q = new URLSearchParams(params || {}).toString();
      return request('GET', `/api/audit-logs${q ? '?' + q : ''}`);
    },
  };
})();
