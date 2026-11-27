/**
 * GatewayClient — HTTP client tới BeerPOS Zalo Gateway
 * ─────────────────────────────────────────────────────────────────────────────
 * MỤC TIÊU:
 *  Đây là ĐIỂM LIÊN LẠC DUY NHẤT giữa BeerPOS và Gateway. Không có logic
 *  nghiệp vụ nào nằm ở đây — chỉ gọi HTTP, quản lý timeout và chuẩn hoá lỗi.
 *
 * ⚠️ NGUYÊN TẮC BẤT DI BẤT DỊCH:
 *  1. KHÔNG BAO GIỜ throw ra ngoài (luôn trả về object kết quả) → lỗi Gateway
 *     KHÔNG BAO GIỜ làm hỏng giao dịch thanh toán đã commit.
 *  2. KHÔNG log API key.
 *  3. Timeout luôn có (không treo worker vô hạn).
 *
 * CẤU HÌNH (ưu tiên):
 *  1. Biến môi trường `NOTIFY_GATEWAY_URL` / `NOTIFY_GATEWAY_API_KEY`
 *  2. `settings.notify_gateway_url` / `settings.notify_gateway_api_key`
 *
 * Rollback: chỉ cần đổi `settings.debt_notify_provider` về 'omicall'.
 */

const db = require('../../../database');
const logger = require('../../utils/logger');

const DEFAULT_URL = 'http://localhost:3100';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_MESSAGE_LENGTH = 2000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSetting(key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value !== null && row.value !== undefined ? String(row.value) : fallback;
  } catch (_) {
    return fallback;
  }
}

/** Bỏ dấu "/" cuối base URL. */
function normalizeBaseUrl(raw) {
  const base = String(raw || '').trim() || DEFAULT_URL;
  return base.replace(/\/+$/, '');
}

/** Ghi 1 setting. */
function setSetting(key, value) {
  try {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value === null || value === undefined ? '' : String(value));
    return true;
  } catch (e) {
    logger.error('[NOTIFY_GATEWAY] setSetting error', { key, error: e.message });
    return false;
  }
}

/** Cấu hình hiện tại (KHÔNG chứa api key dạng rõ). */
function getConfig() {
  const envUrl = String(process.env.NOTIFY_GATEWAY_URL || '').trim();
  const envKey = String(process.env.NOTIFY_GATEWAY_API_KEY || '').trim();

  const baseUrl = normalizeBaseUrl(envUrl || getSetting('notify_gateway_url', DEFAULT_URL));
  const apiKey = envKey || getSetting('notify_gateway_api_key', '').trim();
  const timeoutMs = Math.min(
    Math.max(parseInt(process.env.NOTIFY_GATEWAY_TIMEOUT_MS, 10) ||
      parseInt(getSetting('notify_gateway_timeout_ms', ''), 10) || DEFAULT_TIMEOUT_MS, 1000),
    120000
  );

  return {
    baseUrl,
    apiKey,
    timeoutMs,
    configured: !!apiKey,
    maxMessageLength: Math.min(
      Math.max(parseInt(getSetting('notify_gateway_max_length', ''), 10) || DEFAULT_MAX_MESSAGE_LENGTH, 100),
      20000
    ),
  };
}

/**
 * Cấu hình cho UI (KHÔNG lộ api key dạng rõ).
 */
function getPublicConfig() {
  const cfg = getConfig();
  return {
    baseUrl: cfg.baseUrl,
    timeoutMs: cfg.timeoutMs,
    configured: cfg.configured,
    maxMessageLength: cfg.maxMessageLength,
    apiKeyMasked: cfg.apiKey ? cfg.apiKey.slice(0, 4) + '••••••' + cfg.apiKey.slice(-4) : '',
  };
}

/**
 * Lưu cấu hình Gateway vào bảng `settings`.
 * `apiKey` undefined/null → giữ nguyên giá trị cũ.
 *
 * ⚠️ CHỈ ghi key khi ADMIN xác nhận rõ ràng. Không tự động đồng bộ.
 */
function saveConfig(patch = {}) {
  try {
    if (patch.apiKey !== undefined && patch.apiKey !== null) {
      const key = String(patch.apiKey).trim();
      setSetting('notify_gateway_api_key', key);
    }
    if (patch.baseUrl !== undefined && patch.baseUrl !== null) {
      setSetting('notify_gateway_url', normalizeBaseUrl(patch.baseUrl));
    }
    if (patch.timeoutMs !== undefined && patch.timeoutMs !== null) {
      const t = parseInt(patch.timeoutMs, 10);
      if (Number.isFinite(t) && t >= 1000 && t <= 120000) {
        setSetting('notify_gateway_timeout_ms', String(t));
      }
    }
    return { success: true };
  } catch (e) {
    logger.error('[NOTIFY_GATEWAY] saveConfig error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/** fetch có timeout (Node 18+ có fetch global). */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

/**
 * Gọi 1 endpoint của Gateway.
 *
 * @param {string} method
 * @param {string} path
 * @param {object|null} body
 * @param {object} opts { idempotencyKey, timeoutMs }
 * @returns {Promise<{ok:boolean, status:number, data:object|null, error:string|null, code:string|null, networkError:boolean}>}
 */
async function request(method, path, body, opts = {}) {
  const cfg = getConfig();
  if (!cfg.apiKey) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: 'Chưa cấu hình API key cho Gateway (notify_gateway_api_key)',
      code: 'GATEWAY_NOT_CONFIGURED',
      networkError: false,
    };
  }

  const url = cfg.baseUrl + path;
  const headers = {
    Accept: 'application/json',
    'X-API-Key': cfg.apiKey,
  };

  let payload;
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (opts.idempotencyKey) {
    headers['Idempotency-Key'] = String(opts.idempotencyKey);
  }

  let res;
  try {
    res = await fetchWithTimeout(url, {
      method,
      headers,
      body: payload,
      timeout: opts.timeoutMs || cfg.timeoutMs,
    });
  } catch (e) {
    // Phân biệt 2 tình huống (quyết định có retry hay không):
    //  - TIMEOUT: Gateway có thể ĐÃ nhận & đã tạo job → không xác định được
    //    kết quả → KHÔNG retry mù (nguy cơ gửi trùng) → trả `timeout: true`.
    //  - KẾT NỐI THẤT BẠI (connection refused / DNS / network down): Gateway
    //    CHƯA hề nhận yêu cầu → có thể retry an toàn → trả `timeout: false`.
    const isTimeout = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
    logger.error('[NOTIFY_GATEWAY] Không gọi được Gateway', {
      url,
      method,
      timeout: !!isTimeout,
      error: e && e.message,
    });
    return {
      ok: false,
      status: 0,
      data: null,
      error: isTimeout
        ? `Gateway timeout sau ${opts.timeoutMs || cfg.timeoutMs}ms`
        : `Không kết nối được Gateway: ${(e && e.message) || 'unknown'}`,
      code: 'GATEWAY_UNREACHABLE',
      networkError: true,
      // true = không xác định được kết quả (KHÔNG retry mù).
      timeout: !!isTimeout,
    };
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    const code = (data && data.code) || null;
    const message = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    logger.warn('[NOTIFY_GATEWAY] Gateway từ chối yêu cầu', {
      url,
      method,
      status: res.status,
      code,
    });
    return {
      ok: false,
      status: res.status,
      data,
      error: message,
      code,
      networkError: false,
    };
  }

  return { ok: true, status: res.status, data, error: null, code: null, networkError: false };
}

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Gửi yêu cầu gửi tin tới Gateway. Gateway CHỈ tạo job, không gửi tin ngay.
 *
 * @param {object} payload { paymentId, customerId, message }
 * @param {string} idempotencyKey
 */
async function sendMessage(payload, idempotencyKey) {
  const cfg = getConfig();

  const customerId = String((payload && payload.customerId) || '').trim();
  const message = String((payload && payload.message) || '').trim();

  if (!customerId) {
    return {
      ok: false,
      status: 400,
      data: null,
      error: 'Thiếu customerId',
      code: 'VALIDATION_ERROR',
      networkError: false,
    };
  }
  if (!message) {
    return {
      ok: false,
      status: 400,
      data: null,
      error: 'Thiếu nội dung tin nhắn',
      code: 'VALIDATION_ERROR',
      networkError: false,
    };
  }
  if (message.length > cfg.maxMessageLength) {
    return {
      ok: false,
      status: 400,
      data: null,
      error: `Nội dung tin nhắn quá dài (tối đa ${cfg.maxMessageLength} ký tự)`,
      code: 'VALIDATION_ERROR',
      networkError: false,
    };
  }

  const res = await request(
    'POST',
    '/api/messages/send',
    {
      paymentId: payload.paymentId ? String(payload.paymentId) : undefined,
      customerId,
      message,
    },
    { idempotencyKey }
  );

  if (res.ok && res.data) {
    return {
      ...res,
      jobId: res.data.jobId || null,
      status: res.data.status || null,
      duplicate: !!res.data.duplicate,
    };
  }
  return res;
}

/** Tra cứu trạng thái 1 job. */
async function getJob(jobId) {
  return request('GET', `/api/messages/jobs/${encodeURIComponent(jobId)}`, null);
}

/** Yêu cầu Gateway gửi lại job (chỉ khi Gateway cho phép). */
async function retryJob(jobId) {
  return request('POST', `/api/messages/jobs/${encodeURIComponent(jobId)}/retry`, {});
}

/** Huỷ job đang chờ. */
async function cancelJob(jobId) {
  return request('POST', `/api/messages/jobs/${encodeURIComponent(jobId)}/cancel`, {});
}

/** Kiểm tra Gateway còn sống không. */
async function health() {
  const cfg = getConfig();
  try {
    const res = await fetchWithTimeout(cfg.baseUrl + '/health', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeout: Math.min(cfg.timeoutMs, 5000),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    return {
      success: res.ok && !!data && data.status === 'ok',
      status: res.status,
      data,
      baseUrl: cfg.baseUrl,
    };
  } catch (e) {
    return { success: false, status: 0, data: null, baseUrl: cfg.baseUrl, error: e.message };
  }
}

module.exports = {
  DEFAULT_URL,
  DEFAULT_TIMEOUT_MS,
  getConfig,
  getPublicConfig,
  saveConfig,
  request,
  sendMessage,
  getJob,
  retryJob,
  cancelJob,
  health,
};
