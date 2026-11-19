/**
 * OmiCallService — Client API OmiCall (kênh Zalo Personal multi-channel)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu:
 *  1. Quản lý access token (lấy qua API key, hạn 24h → cache trong bộ nhớ).
 *  2. Gửi tin nhắn text vào nhóm Zalo cá nhân qua multi-channel OmiCall.
 *
 * Endpoint (đã kiểm chứng trực tiếp với server OmiCall production):
 *   POST {base}/api/auth
 *        body: { apiKey, tenantId: "", lng: "vi" }
 *        → { status_code: 9999, payload: { access_token: "..." } } khi thành công
 *        → { status_code: -9999, message: "auth_invalid" | "api_key_invalid" | ... }
 *        LƯU Ý: production (public-v1.omicall.com) KHÔNG chấp nhận GET /api/auth
 *        (trả HTTP 405 "Method not allowed"). Chỉ staging mới nhận GET.
 *        Nếu POST thiếu `tenantId` → upstream trả HTTP 500 ("Error Occurred!!!").
 *
 *   GET  {base}/api/auth?apiKey=<API_KEY>   ← chỉ dùng làm fallback (staging)
 *
 *   POST {base}/omni_conv/message/send_text?lng=vi
 *        headers: 'x-api-key': <API_KEY>  (+ 'Authorization': Bearer <token>)
 *        body:    { convId: "<conversation_id_nhom_zalo>", text: "<nội dung>" }
 *
 *  `convId` là ID hội thoại (conversation) của nhóm Zalo trong hệ thống
 *  multi-channel OmiCall — chính là giá trị lưu ở `debt_customer_groups.group_id`
 *  với `platform = 'zalo_personal'`.
 *
 * Nguyên tắc:
 *  - FAIL-OPEN: mọi lỗi đều được ném ra dưới dạng Error có message rõ ràng,
 *    nhưng nơi gọi (DebtNotifyService) phải bắt lỗi để KHÔNG làm hỏng
 *    nghiệp vụ ghi sổ công nợ.
 *  - Không log API key/token ra log.
 */

const db = require('../../database');
const logger = require('../utils/logger');

const DEFAULT_BASE_URL = 'https://public-v1.omicall.com';
const DEFAULT_TIMEOUT_MS = 20000;

// Token OmiCall hạn 24h → refresh sớm 30 phút cho an toàn.
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 30 * 60 * 1000;

// Cache token trong RAM (mỗi tiến trình). key = apiKey|baseUrl
const tokenCache = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSetting(key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value !== null && row.value !== undefined ? String(row.value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function setSetting(key, value) {
  try {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value === null || value === undefined ? '' : String(value));
    return true;
  } catch (e) {
    logger.error('[OMICALL] setSetting error', { key, error: e.message });
    return false;
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

/** Bỏ dấu "/" cuối base URL. */
function normalizeBaseUrl(raw) {
  const base = String(raw || '').trim() || DEFAULT_BASE_URL;
  return base.replace(/\/+$/, '');
}

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Đọc cấu hình OmiCall từ bảng `settings`.
 * @returns {{apiKey:string, baseUrl:string, enabled:boolean, channel:string,
 *            notifyManualDebt:boolean, title:string}}
 */
function getConfig() {
  return {
    apiKey: getSetting('omicall_api_key', '').trim(),
    baseUrl: normalizeBaseUrl(getSetting('omicall_base_url', DEFAULT_BASE_URL)),
    enabled: getSetting('debt_notify_enabled', '0') === '1',
    channel: getSetting('debt_notify_channel', 'omicall_zalo_personal'),
    notifyManualDebt: getSetting('debt_notify_manual_debt', '0') === '1',
    title: getSetting('debt_notify_title', 'BIA TƯƠI — Cập nhật công nợ'),
  };
}

/** Cấu hình cho UI (KHÔNG trả api key dạng rõ). */
function getPublicConfig() {
  const cfg = getConfig();
  return {
    hasApiKey: !!cfg.apiKey,
    baseUrl: cfg.baseUrl,
    enabled: cfg.enabled,
    channel: cfg.channel,
    notifyManualDebt: cfg.notifyManualDebt,
    title: cfg.title,
    apiKeyMasked: cfg.apiKey
      ? cfg.apiKey.slice(0, 4) + '••••••' + cfg.apiKey.slice(-4)
      : '',
  };
}

/**
 * Lưu cấu hình (ADMIN). `apiKey` undefined/null → giữ nguyên giá trị cũ.
 * @param {object} patch
 */
function saveConfig(patch = {}) {
  try {
    if (patch.apiKey !== undefined && patch.apiKey !== null) {
      const key = String(patch.apiKey).trim();
      if (key) setSetting('omicall_api_key', key);
      else setSetting('omicall_api_key', '');
    }
    if (patch.baseUrl !== undefined && patch.baseUrl !== null) {
      setSetting('omicall_base_url', normalizeBaseUrl(patch.baseUrl));
    }
    if (patch.enabled !== undefined) {
      setSetting('debt_notify_enabled', patch.enabled ? '1' : '0');
    }
    if (patch.channel !== undefined && patch.channel !== null) {
      setSetting('debt_notify_channel', String(patch.channel));
    }
    if (patch.notifyManualDebt !== undefined) {
      setSetting('debt_notify_manual_debt', patch.notifyManualDebt ? '1' : '0');
    }
    if (patch.title !== undefined && patch.title !== null) {
      setSetting('debt_notify_title', String(patch.title));
    }
    // Đổi API key/base URL → xoá cache token (token cũ không dùng được)
    if (patch.apiKey !== undefined || patch.baseUrl !== undefined) {
      tokenCache.clear();
    }
    return { success: true };
  } catch (e) {
    logger.error('[OMICALL] saveConfig error', { error: e.message });
    return { success: false, error: e.message };
  }
}

// ── Access token ─────────────────────────────────────────────────────────────

/** Map mã lỗi của OmiCall sang thông báo tiếng Việt dễ hiểu. */
const AUTH_ERROR_MESSAGES = {
  auth_invalid: 'API key không hợp lệ (OmiCall trả về auth_invalid)',
  api_key_invalid: 'API key không hợp lệ (OmiCall trả về api_key_invalid)',
  api_key_is_required: 'OmiCall không nhận được API key',
  api_key_disabled: 'API key đã bị vô hiệu hóa',
  key_disabled: 'API key đã bị vô hiệu hóa',
  tenant_required: 'Thiếu tenantId khi xác thực OmiCall',
  unauthorized: 'API key không có quyền truy cập',
  forbidden: 'API key không có quyền truy cập',
};

/** Rút thông điệp lỗi có nghĩa từ body OmiCall. */
function extractAuthError(body, fallback) {
  if (!body || typeof body !== 'object') return fallback;
  const raw = body.message || body.msg || body.error || body.error_message || '';
  const code = String(raw || '').trim();
  if (!code) return fallback;
  if (AUTH_ERROR_MESSAGES[code]) return AUTH_ERROR_MESSAGES[code];
  return code;
}

/**
 * Thử lấy access token theo nhiều chiến lược gọi /api/auth.
 *
 * Kiểm chứng thực tế trên server OmiCall (2026-11):
 *
 *  | Môi trường | GET ?apiKey=          | POST body {apiKey,...}          |
 *  |------------|----------------------|---------------------------------|
 *  | production | ❌ 405 Method allowed  | ✅ đọc apiKey trong body        |
 *  | staging    | ✅ đọc apiKey trong QS  | ❌ "api_key_is_required"        |
 *
 *  → Chiến lược chung cho cả hai: `POST ?apiKey=<key>` + body có `apiKey`.
 *    Các chiến lược còn lại làm fallback.
 *
 *  LƯU Ý: `POST` thiếu `tenantId` → upstream lỗi HTTP 500 → luôn gửi kèm
 *  `tenantId` (kể cả chuỗi rỗng) và `lng`.
 */
async function requestAuthToken(baseUrl, apiKey) {
  const encodedKey = encodeURIComponent(apiKey);
  const attempts = [
    // 1. POST + apiKey ở CẢ query lẫn body → hoạt động với production & staging
    {
      method: 'POST',
      url: `${baseUrl}/api/auth?apiKey=${encodedKey}`,
      body: { apiKey, tenantId: '', lng: 'vi' },
    },
    // 2. POST chỉ body → production đọc apiKey trong body
    {
      method: 'POST',
      url: `${baseUrl}/api/auth`,
      body: { apiKey, tenantId: '', lng: 'vi' },
    },
    // 3. GET + query → staging (và tài liệu chính thức)
    {
      method: 'GET',
      url: `${baseUrl}/api/auth?apiKey=${encodedKey}`,
      body: null,
    },
  ];

  let lastError = null;

  for (const attempt of attempts) {
    let res;
    let body = null;
    try {
      res = await fetchWithTimeout(attempt.url, {
        method: attempt.method,
        headers: {
          Accept: 'application/json',
          ...(attempt.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(attempt.body ? { body: JSON.stringify(attempt.body) } : {}),
      });
      const raw = await res.text();
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch (_) {
        body = { message: raw };
      }
    } catch (e) {
      lastError = new Error(`Không gọi được OmiCall (${e.message})`);
      continue;
    }

    const token = extractToken(body);
    if (token) return token;

    // Ghi nhớ lỗi để báo ra nếu mọi chiến lược đều thất bại.
    const detail = extractAuthError(body, `HTTP ${res.status}`);
    lastError = new Error(`OmiCall auth thất bại: ${detail}`);

    if (!res.ok) {
      // Lỗi HTTP (405/404/500) → thử chiến lược kế tiếp.
      continue;
    }

    // HTTP 200 nhưng OmiCall từ chối:
    //  - "api_key_is_required" → OmiCall KHÔNG đọc được key ở vị trí này
    //    → thử chiến lược khác (đặt key ở chỗ khác).
    //  - "auth_invalid"/"api_key_invalid" → key sai → dừng luôn, các chiến lược
    //    khác cũng cho kết quả tương tự.
    const code = String((body && (body.message || body.msg)) || '').trim();
    if (code === 'api_key_is_required' || code === 'api_key_required' || code === 'tenant_required') {
      continue;
    }
    break;
  }

  throw lastError || new Error('OmiCall auth thất bại: không xác định được lỗi');
}

/** Rút access token từ nhiều vị trí trong payload OmiCall. */
function extractToken(body) {
  if (!body || typeof body !== 'object') return null;
  const candidates = [
    body.payload && body.payload.access_token,
    body.access_token,
    body.data && body.data.access_token,
    body.payload && body.payload.accessToken,
    body.token,
  ];
  for (const c of candidates) {
    if (c) return String(c);
  }
  return null;
}

/**
 * Lấy access token (cache 24h).
 * @param {object} [opts] { apiKey, baseUrl, force }
 * @returns {Promise<string>}
 */
async function getAccessToken(opts = {}) {
  const cfg = getConfig();
  const apiKey = String(opts.apiKey || cfg.apiKey || '').trim();
  const baseUrl = normalizeBaseUrl(opts.baseUrl || cfg.baseUrl);

  if (!apiKey) {
    throw new Error('Chưa cấu hình OmiCall API key');
  }

  const cacheKey = `${apiKey}|${baseUrl}`;
  const cached = tokenCache.get(cacheKey);
  if (!opts.force && cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const token = await requestAuthToken(baseUrl, apiKey);

  tokenCache.set(cacheKey, {
    token: String(token),
    expiresAt: Date.now() + TOKEN_TTL_MS - TOKEN_REFRESH_MARGIN_MS,
  });
  return String(token);
}

/** Xoá cache token (dùng khi test lỗi). */
function clearTokenCache() {
  tokenCache.clear();
}

// ── Gửi tin nhắn ─────────────────────────────────────────────────────────────

/**
 * Sinh danh sách host ứng viên để gửi tin nhắn.
 *
 * Bối cảnh (đã kiểm chứng trực tiếp với server OmiCall):
 *  - `public-v1[-stg].omicall.com` là host PUBLIC API — chỉ expose route
 *    `/api/auth` (lấy access token). Các route nghiệp vụ trả về HTML của web
 *    app, không phải JSON.
 *  - Route gửi tin multi-channel nằm ở host service riêng:
 *    `social-network-v1[-stg].omicrm.com`.
 *    Bản staging trả JSON đúng (401 khi thiếu token hợp lệ); bản production
 *    hiện trả HTML của web app (route chưa expose ra ngoài).
 *
 * Quy tắc: giữ nguyên hậu tố `-stg` khi chuyển đổi giữa các host.
 */
function resolveMessageHosts(baseUrl) {
  const hosts = [];
  const push = (h) => {
    const v = normalizeBaseUrl(h);
    if (v && !hosts.includes(v)) hosts.push(v);
  };

  push(baseUrl);

  // public-v1[-stg].<domain> → social-network-v1[-stg].<domain>
  // Thử cả `.omicall.com` và `.omicrm.com` vì OmiCall dùng cả hai tên miền.
  const m = /^https?:\/\/public-v1(-stg)?\.(omicall|omicrm)\.com$/i.exec(baseUrl);
  if (m) {
    const suffix = m[1] || '';
    for (const domain of ['omicrm.com', 'omicall.com']) {
      push(`https://social-network-v1${suffix}.${domain}`);
    }
  }

  // social-network-v1[-stg].<domain> → đổi chiều staging ↔ production
  const s = /^https?:\/\/(social-network-v1)(-stg)?\.(omicall|omicrm)\.com$/i.exec(baseUrl);
  if (s) {
    for (const domain of ['omicrm.com', 'omicall.com']) {
      push(`https://${s[1]}${s[2] ? '' : '-stg'}.${domain}`);
      push(`https://${s[1]}-stg.${domain}`);
    }
  }

  return hosts;
}

/** Các path gửi tin multi-channel Zalo cá nhân (thử theo thứ tự). */
const MESSAGE_PATHS = [
  '/omni_conv/message/send_text?lng=vi',
  '/api/omni_conv/message/send_text?lng=vi',
];

/**
 * Gửi tin nhắn text vào nhóm Zalo cá nhân (multi-channel OmiCall).
 *
 * @param {object} opts
 * @param {string} opts.convId - conversation ID của nhóm Zalo
 * @param {string} opts.text   - nội dung tin nhắn
 * @param {object} [opts.config] - override apiKey/baseUrl
 * @returns {Promise<{success:boolean, messageId?:string, raw?:any, error?:string}>}
 */
async function sendZaloPersonalMessage(opts = {}) {
  const convId = String(opts.convId || '').trim();
  const text = String(opts.text || '').trim();

  if (!convId) {
    return { success: false, error: 'Thiếu convId (conversation ID của nhóm Zalo)' };
  }
  if (!text) {
    return { success: false, error: 'Thiếu nội dung tin nhắn' };
  }

  const cfg = { ...getConfig(), ...(opts.config || {}) };
  const apiKey = String(cfg.apiKey || '').trim();
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  if (!apiKey) {
    return { success: false, error: 'Chưa cấu hình OmiCall API key' };
  }

  let token = null;
  try {
    token = await getAccessToken({ apiKey, baseUrl });
  } catch (e) {
    // Thử lại 1 lần với token mới (cache có thể đã hết hạn sớm)
    try {
      token = await getAccessToken({ apiKey, baseUrl, force: true });
    } catch (e2) {
      return { success: false, error: e2.message };
    }
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-api-key': apiKey,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const hosts = resolveMessageHosts(baseUrl);
  let lastError = null;

  for (const host of hosts) {
    for (const path of MESSAGE_PATHS) {
      const url = `${host}${path}`;
      let res;
      let raw = '';
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ convId, text }),
        });
        raw = await res.text();
      } catch (e) {
        // Ghi rõ host để admin biết chính xác chỗ nào không gọi được.
        const cause = (e && e.cause && (e.cause.code || e.cause.message)) || '';
        lastError = `Không gọi được OmiCall tại ${host}${path.split('?')[0]} (${e.message}${cause ? ' — ' + cause : ''})`;
        continue;
      }

      // Host trả HTML → đây là web app, không phải API → thử host/path khác.
      if (/^\s*<(!doctype|html)/i.test(raw)) {
        lastError = `OmiCall không phục vụ API tại ${host}${path.split('?')[0]} (trả về HTML)`;
        continue;
      }

      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch (_) {
        body = { message: raw };
      }

      if (!res.ok) {
        const msg = (body && (body.message || body.msg || body.error)) || `HTTP ${res.status}`;
        lastError = `OmiCall gửi tin thất bại tại ${host}${path.split('?')[0]}: ${msg}`;
        // 401/403 → sai token/key, thử host khác không giúp ích → dừng.
        if (res.status === 401 || res.status === 403) {
          return { success: false, error: lastError, raw: body };
        }
        continue;
      }

      // OmiCall trả { status_code: 9999, payload: {... } } khi thành công.
      const statusCode = body && body.status_code;
      if (statusCode !== undefined && Number(statusCode) !== 9999) {
        const msg = (body && (body.message || body.msg)) || `status_code ${statusCode}`;
        return { success: false, error: `OmiCall từ chối: ${msg}`, raw: body };
      }

      const payload = (body && body.payload) || {};
      return {
        success: true,
        messageId: payload.message_id || payload.msgId || payload.id || payload._id || null,
        raw: body,
      };
    }
  }

  return {
    success: false,
    error:
      lastError ||
      'Không tìm được endpoint gửi tin OmiCall. Kiểm tra lại Base URL (thử https://public-v1-stg.omicall.com nếu tài khoản OmiCall của bạn thuộc môi trường staging).',
  };
}

/**
 * Kiểm tra kết nối (dùng cho nút "Kiểm tra kết nối" trong UI).
 *
 * @param {object} [opts] — có thể truyền trực tiếp `{ apiKey, baseUrl }`
 *   hoặc dạng lồng `{ config: { apiKey, baseUrl } }` (tương thích ngược).
 *   Giá trị truyền vào ĐƯỢC ưu tiên hơn giá trị đã lưu trong `settings`,
 *   để admin có thể test API key MỚI trước khi bấm "Lưu cấu hình".
 *
 * @returns {Promise<{success:boolean, error?:string}>}
 */
async function testConnection(opts = {}) {
  try {
    const override = opts.config || {};
    const cfg = { ...getConfig(), ...override };
    // Cho phép truyền phẳng: { apiKey, baseUrl }
    if (opts.apiKey !== undefined && opts.apiKey !== null) {
      cfg.apiKey = String(opts.apiKey).trim();
    }
    if (opts.baseUrl !== undefined && opts.baseUrl !== null) {
      cfg.baseUrl = normalizeBaseUrl(opts.baseUrl);
    }

    if (!String(cfg.apiKey || '').trim()) {
      return {
        success: false,
        error: 'Chưa cấu hình OmiCall API key. Hãy dán API key vào ô bên trên rồi thử lại.',
      };
    }

    await getAccessToken({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      force: true,
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Thử nhiều biến thể endpoint + body để tìm đúng cách gửi tin Zalo cá nhân.
 *
 * Dùng để chẩn đoán khi OmiCall trả `invalid_param`: mỗi biến thể được thử
 * với cùng một convId/text, trả về ma trận kết quả để admin thấy chính xác
 * host/path/body nào được OmiCall chấp nhận.
 *
 * @returns {Promise<{attempts:Array, best?:object}>}
 */
async function probeSendEndpoints(opts = {}) {
  const convId = String(opts.convId || '').trim();
  const text = String(opts.text || 'test').trim();
  const cfg = { ...getConfig(), ...(opts.config || {}) };
  const apiKey = String(cfg.apiKey || '').trim();
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);

  if (!apiKey) return { attempts: [], error: 'Chưa cấu hình OmiCall API key' };
  if (!convId) return { attempts: [], error: 'Thiếu convId' };

  let token = null;
  try {
    token = await getAccessToken({ apiKey, baseUrl, force: true });
  } catch (e) {
    return { attempts: [], error: e.message };
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-api-key': apiKey,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // Các biến thể body: OmiCall có thể dùng `text` hoặc `message`.
  const bodyVariants = [
    { label: 'convId+text', body: { convId, text } },
    { label: 'convId+message', body: { convId, message: text } },
    { label: 'conversationId+text', body: { conversationId: convId, text } },
  ];

  // Các biến thể path: prefix `/api` có/không, có `lng` trong query.
  const pathVariants = [
    { label: 'no-prefix+?lng', path: '/omni_conv/message/send_text?lng=vi' },
    { label: 'no-prefix', path: '/omni_conv/message/send_text' },
    { label: '/api+?lng', path: '/api/omni_conv/message/send_text?lng=vi' },
    { label: '/api', path: '/api/omni_conv/message/send_text' },
  ];

  const hosts = resolveMessageHosts(baseUrl);
  const attempts = [];

  for (const host of hosts) {
    for (const pv of pathVariants) {
      for (const bv of bodyVariants) {
        let res;
        let raw = '';
        try {
          res = await fetchWithTimeout(`${host}${pv.path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(bv.body),
          });
          raw = await res.text();
        } catch (e) {
          attempts.push({
            host,
            path: pv.path,
            body: bv.label,
            http: 0,
            result: 'FETCH_FAIL',
            detail: e.message + ((e.cause && e.cause.code) ? ' — ' + e.cause.code : ''),
          });
          continue;
        }

        let body = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch (_) {
          body = null;
        }

        if (/^\s*<(!doctype|html)/i.test(raw)) {
          attempts.push({
            host,
            path: pv.path,
            body: bv.label,
            http: res.status,
            result: 'HTML',
            detail: 'web app, không phải API',
          });
          continue;
        }

        const statusCode = body && body.status_code;
        const msg = (body && (body.message || body.msg)) || '';
        let result;
        if (res.ok && (statusCode === undefined || Number(statusCode) === 9999)) {
          result = 'OK';
        } else if (res.status === 401 || res.status === 403) {
          result = 'AUTH';
        } else if (msg === 'invalid_param') {
          result = 'INVALID_PARAM';
        } else {
          result = 'ERR';
        }

        attempts.push({
          host,
          path: pv.path,
          body: bv.label,
          http: res.status,
          status_code: statusCode ?? null,
          result,
          detail: msg || (res.ok ? '' : `HTTP ${res.status}`),
          raw: result === 'OK' ? body : undefined,
        });
      }
    }
  }

  const best = attempts.find((a) => a.result === 'OK');
  return { attempts, best: best || null };
}

/**
 * Liệt kê hội thoại (conversation) đang có trên tài khoản OmiCall.
 *
 * Dùng để admin lấy đúng `convId` của nhóm Zalo thay vì tự đoán — OmiCall
 * trả `invalid_param` khi convId không tồn tại trong tenant của API key.
 *
 * @param {object} opts
 * @param {string} [opts.keyword] - từ khoá lọc
 * @param {number} [opts.page]
 * @param {number} [opts.size]
 * @returns {Promise<{success:boolean, conversations?:Array, raw?:any, error?:string}>}
 */
async function listConversations(opts = {}) {
  const cfg = { ...getConfig(), ...(opts.config || {}) };
  const apiKey = String(cfg.apiKey || '').trim();
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  if (!apiKey) return { success: false, error: 'Chưa cấu hình OmiCall API key' };

  let token = null;
  try {
    token = await getAccessToken({ apiKey, baseUrl, force: true });
  } catch (e) {
    return { success: false, error: e.message };
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-api-key': apiKey,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const params = {
    page: Number(opts.page) || 1,
    size: Math.min(100, Number(opts.size) || 20),
    lng: 'vi',
  };
  if (opts.keyword) params.keyword = String(opts.keyword).trim();

  const attempts = [];
  for (const host of resolveMessageHosts(baseUrl)) {
    for (const path of ['/omi_v2/omichannel/search_v4', '/api/omi_v2/omichannel/search_v4']) {
      const qs = new URLSearchParams(params).toString();
      let res;
      let raw = '';
      try {
        res = await fetchWithTimeout(`${host}${path}?${qs}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ page: params.page, size: params.size, keyword: params.keyword || '' }),
        });
        raw = await res.text();
      } catch (e) {
        attempts.push({ host, path, http: 0, result: 'FETCH_FAIL', detail: e.message });
        continue;
      }

      if (/^\s*<(!doctype|html)/i.test(raw)) {
        attempts.push({ host, path, http: res.status, result: 'HTML' });
        continue;
      }

      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch (_) {
        body = { message: raw };
      }

      const statusCode = body && body.status_code;
      if (res.ok && (statusCode === undefined || Number(statusCode) === 9999)) {
        const payload = (body && body.payload) || {};
        const list = Array.isArray(payload)
          ? payload
          : payload.items || payload.data || payload.list || payload.conversations || [];
        return {
          success: true,
          conversations: Array.isArray(list) ? list : [],
          raw: body,
          attempts,
        };
      }

      attempts.push({
        host,
        path,
        http: res.status,
        result: 'ERR',
        detail: (body && (body.message || body.msg)) || `HTTP ${res.status}`,
      });
    }
  }

  return {
    success: false,
    error: 'Không tìm được endpoint liệt kê hội thoại OmiCall',
    attempts,
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  getConfig,
  getPublicConfig,
  saveConfig,
  getAccessToken,
  clearTokenCache,
  sendZaloPersonalMessage,
  testConnection,
  probeSendEndpoints,
  listConversations,
};
