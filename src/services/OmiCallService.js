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

// Cache channel_id trong RAM. key = channel|apiKey|baseUrl
// channel_id (uid kênh Zalo cá nhân) hiếm khi đổi → cache 30 phút để không
// phải gọi /omnichannel/channel/get_all cho mỗi tin nhắn (và để giữ được
// channel_id khi phiên Zalo chập chờn, tránh rơi vào lỗi "error_occurred").
const channelIdCache = new Map();
const CHANNEL_ID_TTL_MS = 30 * 60 * 1000;
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
  // Chỉ `.omicrm.com` phục vụ API multi-channel; `.omicall.com` chỉ là web app.
  const m = /^https?:\/\/public-v1(-stg)?\.(omicall|omicrm)\.com$/i.exec(baseUrl);
  if (m) {
    const suffix = m[1] || '';
    push(`https://social-network-v1${suffix}.omicrm.com`);
  }

  // social-network-v1[-stg].<domain> → đổi chiều staging ↔ production
  const s = /^https?:\/\/(social-network-v1)(-stg)?\.(omicall|omicrm)\.com$/i.exec(baseUrl);
  if (s) {
    push(`https://${s[1]}${s[2] ? '' : '-stg'}.omicrm.com`);
    push(`https://${s[1]}-stg.omicrm.com`);
  }

  return hosts;
}

/**
 * Các path gửi tin multi-channel Zalo cá nhân (thử theo thứ tự).
 * Path xác minh từ bundle web app OmiCall: `socialNetwork + "omni_conv/message/send_" + "text"`.
 */
const MESSAGE_PATHS = ['/omni_conv/message/send_text?lng=vi', '/omni_conv/message/send_text'];

/**
 * Sinh danh sách body gửi tin (thử theo thứ tự ưu tiên).
 *
 * Body ĐÚNG của OmiCall multi-channel (đã trích từ bundle web app chính thức
 * và kiểm chứng bằng request thật):
 *   { conv_id, channel_id, text }
 *  - `conv_id`    : **Mongo `_id` của hội thoại** — ví dụ "6afe6913fca59218a5d662a9"
 *                   (KHÔNG phải `conv.conv_id` dạng số, và KHÔNG phải id của kênh)
 *  - `channel_id` : uid kênh Zalo cá nhân — ví dụ "341323407055424547"
 *  - `text`       : nội dung tin nhắn
 *
 * Nếu truyền `conv_id` dạng số (`conv.conv_id`) → OmiCall trả `user_not_permision`.
 *
 * Các biến thể cũ giữ lại để tương thích với tài khoản dùng API khác.
 */
function buildMessageBodies(convId, channelId, text) {
  const bodies = [];
  if (channelId) {
    bodies.push({ label: 'conv_id+channel_id+text', body: { conv_id: convId, channel_id: channelId, text } });
  }
  bodies.push({ label: 'conv_id+text', body: { conv_id: convId, text } });
  bodies.push({ label: 'convId+text', body: { convId, text } });
  bodies.push({ label: 'convId+message', body: { convId, message: text } });
  return bodies;
}

/**
 * Tự động lấy `channel_id` (uid kênh Zalo cá nhân) của tenant hiện tại.
 *
 * OmiCall yêu cầu body gửi tin: `{ conv_id, channel_id, text }`.
 * `channel_id` là uid của kênh Zalo Personal đang kết nối, lấy từ
 * `GET|POST /omnichannel/channel/get_all` → `payload.zalo_personal[0].uid`.
 *
 * ⚠️ BUG ĐÃ SỬA (2026-11-22) — `channel_id` RỖNG gây lỗi "error_occurred":
 *  - Hàm này trước đây NUỐT IM LẶNG mọi lỗi (`catch (_) {}`) → khi phiên Zalo
 *    bị gián đoạn, `channel_id` trả về `''` mà không ai biết.
 *  - Body gửi `{ conv_id, channel_id: '', text }` → OmiCall trả `error_occurred`
 *    (lỗi chung, không nói rõ nguyên nhân) → tin nhắn KHÔNG gửi được.
 *  - Fix: cache `channel_id` trong RAM, ghi log mọi lỗi, và trả về '' kèm lý do
 *    để tầng trên BIẾT chứ không gửi tin với channel_id rỗng.
 *
 * @param {object} ctx - { apiKey, baseUrl, token, headers }
 * @returns {Promise<string>} channel_id hoặc '' nếu không lấy được
 */
async function fetchChannelId(ctx = {}) {
  const { apiKey, baseUrl, headers } = ctx;

  // Cache trong RAM — channel_id hiếm khi đổi, không cần gọi lại mỗi tin.
  const cacheKey = `channel|${apiKey}|${baseUrl}`;
  const cached = channelIdCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const failures = [];
  for (const host of resolveMessageHosts(baseUrl)) {
    try {
      const res = await fetchWithTimeout(`${host}/omnichannel/channel/get_all`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      const raw = await res.text();
      if (/^\s*<(!doctype|html)/i.test(raw)) {
        failures.push(`${host}: trả HTML (web app, không phải API)`);
        continue;
      }
      const parsed = raw ? JSON.parse(raw) : null;
      const payload = (parsed && parsed.payload) || {};
      const list = payload.zalo_personal || [];
      if (!Array.isArray(list) || !list.length) {
        failures.push(`${host}: không có kênh zalo_personal trong payload`);
        continue;
      }
      const ch = list[0];
      const uid = ch.uid || ch.channel_id || ch._id || null;
      if (!uid) {
        failures.push(`${host}: kênh zalo_personal không có uid/channel_id`);
        continue;
      }
      const value = String(uid);
      channelIdCache.set(cacheKey, { value, expiresAt: Date.now() + CHANNEL_ID_TTL_MS });
      logger.info('[OMICALL] channel_id đã lấy', { host, channelId: value });
      return value;
    } catch (e) {
      const cause = (e && e.cause && (e.cause.code || e.cause.message)) || '';
      failures.push(`${host}: ${e.message}${cause ? ' — ' + cause : ''}`);
    }
  }

  // Không lấy được → ghi log để admin thấy nguyên nhân thật thay vì "error_occurred".
  logger.error('[OMICALL] Không lấy được channel_id — tin nhắn sẽ KHÔNG gửi được', {
    failures,
  });
  return '';
}

/**
 * Tự động tra cứu Mongo `_id` của hội thoại khi người dùng chỉ có `conv.conv_id`
 * (dạng số) — ví dụ "3580128735721925168".
 *
 * OmiCall yêu cầu `conv_id` là **Mongo `_id`** (24 ký tự hex) của hội thoại.
 * Nếu truyền số → OmiCall trả `user_not_permision`.
 *
 * @param {object} ctx - { apiKey, baseUrl, token, headers }
 * @param {string} convNumber - conv_id dạng số
 * @returns {Promise<string>} Mongo `_id` hoặc '' nếu không tra cứu được
 */
async function resolveMongoConvId(ctx = {}, convNumber) {
  const target = String(convNumber || '').trim();
  if (!target) return '';
  // Đã là Mongo _id (24 hex) → giữ nguyên
  if (/^[a-f0-9]{24}$/i.test(target)) return target;

  const { baseUrl, headers } = ctx;
  for (const host of resolveMessageHosts(baseUrl)) {
    for (let page = 1; page <= 10; page++) {
      try {
        const res = await fetchWithTimeout(
          `${host}/omi_v2/omnichannel/search_v4?page=${page}&size=100`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              types: [],
              keyword: '',
              sort: { field_code: 'last_message_time', is_asc: true },
              is_session: false,
              channel_ids: [],
              is_blocked: false,
            }),
          }
        );
        const raw = await res.text();
        if (/^\s*<(!doctype|html)/i.test(raw)) break;
        const parsed = raw ? JSON.parse(raw) : null;
        const payload = (parsed && parsed.payload) || {};
        const convRoot = payload.conversations || payload;
        const items = Array.isArray(convRoot) ? convRoot : convRoot.items || [];
        if (!Array.isArray(items) || !items.length) break;
        const hit = items.find((it) => {
          const conv = (it && it.conv) || {};
          return String(conv.conv_id || '') === target || String(it.id || '') === target;
        });
        if (hit) return String(hit.id || (hit.conv || {})._id || '');
      } catch (_) {
        break;
      }
    }
  }
  return '';
}

/**
 * Gán nhân viên (agent) hiện tại vào một nhóm Zalo nếu chưa có quyền.
 *
 * ⚠️ QUAN TRỌNG (2026-11-26) — dùng `add_member_from_list`, KHÔNG dùng `add_member`:
 *  - `POST /conversation/add_member` (body `{type, conv, contact_ids}`) trả HTTP 200
 *    với `payload: true` nhưng **KHÔNG hề thay đổi** trạng thái nhóm
 *    (`conv.has_member` vẫn `false`, `chat_session.joined_agents` vẫn `null`)
 *    → tin nhắn sau đó vẫn bị OmiCall từ chối với `error_occurred`.
 *  - `POST /conversation/add_member_from_list` với body
 *    `{ id: <conv_mongo_id>, assign_agent_option: { ids: [contact_id], agent_groups: [],
 *      priority_agent_of_contact: null, allocate_type: 'SPECIFIC' } }`
 *    mới thực sự gán agent: `has_member` false→true, `joined_agents` null→[contact_id],
 *    `member_ids` được bổ sung.
 *
 * Body này được trích từ bundle web app chính thức của OmiCall
 * (hàm `updateReceivingMember` → `assign_agent_option.ids`).
 *
 * ⚠️ TUYỆT ĐỐI KHÔNG dùng `conversation/redistribute_from_list` với
 * `redistribute_type: 'remove'` — nó **GỠ agent khỏi nhóm** (đã kiểm chứng:
 * `has_member` true→false, `member_ids` bị xoá).
 *
 * @param {object} ctx - { apiKey, baseUrl, token, headers }
 * @param {string} convMongoId - Mongo `_id` của hội thoại
 * @returns {Promise<boolean>} true nếu đã có quyền (gán thành công hoặc đã có sẵn)
 */
async function ensureAgentInGroup(ctx = {}, convMongoId) {
  const { baseUrl, token, headers } = ctx;
  const conv = String(convMongoId || '').trim();
  if (!conv) return false;

  // Lấy contact_id của agent hiện tại từ access token (JWT).
  let contactId = '';
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    contactId = String(payload.contact_id || '');
  } catch (_) {
    contactId = '';
  }
  if (!contactId) return false;

  for (const host of resolveMessageHosts(baseUrl)) {
    try {
      const res = await fetchWithTimeout(`${host}/conversation/add_member_from_list?lng=vi`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: conv,
          assign_agent_option: {
            ids: [contactId],
            agent_groups: [],
            priority_agent_of_contact: null,
            allocate_type: 'SPECIFIC',
          },
        }),
      });
      const raw = await res.text();
      if (/^\s*<(!doctype|html)/i.test(raw)) continue;
      const parsed = raw ? JSON.parse(raw) : null;
      const statusCode = parsed && parsed.status_code;
      if (res.ok && (statusCode === undefined || Number(statusCode) === 9999)) {
        return true;
      }
    } catch (_) {
      /* thử host tiếp theo */
    }
  }

  // Bước 2: JOIN phiên chat (route `omi_v2/conversation/join`).
  // Route này được trích từ bundle web app OmiCall (hàm `socialAllocatingAction`
  // với `isJoin: true` → `POST omi_v2/conversation/join`).
  // Body: { type: 'omni_conv', id, kind, channel_id, isEnableSession }.
  // Đã kiểm chứng: nhóm có `joined_agents = null` → sau khi join,
  // `joined_agents` có agent và `has_member` = true.
  const channelId = await fetchChannelId(ctx);
  for (const host of resolveMessageHosts(baseUrl)) {
    try {
      const res = await fetchWithTimeout(`${host}/omi_v2/conversation/join?lng=vi`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'omni_conv',
          id: conv,
          kind: 'zalo_personal',
          channel_id: channelId,
          isEnableSession: true,
        }),
      });
      const raw = await res.text();
      if (/^\s*<(!doctype|html)/i.test(raw)) continue;
      const parsed = raw ? JSON.parse(raw) : null;
      const statusCode = parsed && parsed.status_code;
      if (res.ok && (statusCode === undefined || Number(statusCode) === 9999) && parsed && parsed.payload) {
        return true;
      }
    } catch (_) {
      /* thử host tiếp theo */
    }
  }
  return false;
}

/**
 * Gán agent hiện tại vào nhóm Zalo (dùng khi admin liên kết nhóm trong Sổ công nợ).
 *
 * Mục đích: sau khi liên kết, agent phải có quyền trong nhóm thì tin thông báo
 * công nợ mới gửi được. Trước đây admin phải tự vào web app OmiCall để gán,
 * rất dễ quên → nhóm bị "treo" và mọi tin đều fail với `error_occurred`.
 *
 * Hàm này FAIL-OPEN: lỗi không chặn việc liên kết nhóm (chỉ ghi log).
 *
 * @param {string} convId - Mongo `_id` của hội thoại (nhóm Zalo)
 * @returns {Promise<{assigned:boolean, reason?:string}>}
 */
async function assignAgentToGroup(convId) {
  const conv = String(convId || '').trim();
  if (!conv) return { assigned: false, reason: 'Thiếu convId' };

  const cfg = getConfig();
  const apiKey = String(cfg.apiKey || '').trim();
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  if (!apiKey) {
    return { assigned: false, reason: 'Chưa cấu hình OmiCall API key' };
  }

  let token = null;
  try {
    token = await getAccessToken({ apiKey, baseUrl });
  } catch (e) {
    try {
      token = await getAccessToken({ apiKey, baseUrl, force: true });
    } catch (e2) {
      logger.warn('[OMICALL] Không lấy được token để gán agent vào nhóm', {
        convId: conv,
        error: e2.message,
      });
      return { assigned: false, reason: e2.message };
    }
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-api-key': apiKey,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const ctx = { apiKey, baseUrl, token, headers };
  const granted = await ensureAgentInGroup(ctx, conv);
  if (granted) {
    logger.info('[OMICALL] Đã gán agent vào nhóm Zalo', { convId: conv });
    return { assigned: true };
  }
  logger.warn('[OMICALL] Không gán được agent vào nhóm Zalo (có thể agent đã có quyền)', {
    convId: conv,
  });
  return { assigned: false, reason: 'OmiCall không xác nhận gán agent' };
}

/**
 * Gửi tin nhắn text vào nhóm Zalo cá nhân (multi-channel OmiCall).
 *
 * @param {object} opts
 * @param {string} opts.convId - conversation ID của nhóm Zalo
 * @param {string} [opts.channelId] - uid kênh Zalo cá nhân (tự lấy nếu thiếu)
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
  const ctx = { apiKey, baseUrl, token, headers };

  let channelId = String(opts.channelId || '').trim();
  if (!channelId) {
    channelId = await fetchChannelId(ctx);
  }

  // `conv_id` phải là Mongo `_id` (24 hex). Nếu người dùng dán `conv.conv_id`
  // dạng số → tra cứu lại để lấy Mongo id tương ứng.
  let convMongoId = convId;
  if (!/^[a-f0-9]{24}$/i.test(convMongoId)) {
    const resolved = await resolveMongoConvId(ctx, convMongoId);
    if (resolved) convMongoId = resolved;
  }

  const bodies = buildMessageBodies(convMongoId, channelId, text);
  let lastError = null;
  // Lỗi "thật" từ API (JSON) — quan trọng hơn lỗi HTML của host web app.
  let apiError = null;
  // Đã thử cấp quyền agent vào nhóm chưa (tránh gọi lặp).
  let permissionGranted = false;

  // ⚠️ 2026-11-22: KHÔNG gửi biến thể body có `channel_id` rỗng.
  // OmiCall trả `error_occurred` (lỗi chung, khó chẩn đoán) khi body chứa
  // channel_id rỗng — biến thể này chỉ làm hỏng không giúp ích.
  // Nếu không lấy được channel_id → báo lỗi rõ ràng ngay, đừng gửi tin.
  if (!channelId && !opts.channelId) {
    logger.error('[OMICALL] Thiếu channel_id — bỏ qua gửi tin để tránh lỗi error_occurred', {
      convId: convMongoId,
    });
  }
  const sendableBodies = channelId
    ? bodies
    : bodies.filter((bv) => bv.label !== 'conv_id+channel_id+text');

  for (const host of hosts) {
    for (const path of MESSAGE_PATHS) {
      for (const bv of sendableBodies) {
        const url = `${host}${path}`;
        let res;
        let raw = '';
        try {
          res = await fetchWithTimeout(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(bv.body),
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
          if (!apiError) apiError = lastError;
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
          lastError = `OmiCall từ chối: ${msg}`;
          // Giữ lại lỗi ĐẦU TIÊN (lỗi thật). Các biến thể body sau chỉ cho
          // `invalid_param` — không có giá trị chẩn đoán, không ghi đè lỗi gốc.
          if (!apiError) apiError = lastError;

          logger.error('[OMICALL] Gửi tin bị từ chối', {
            host,
            path: path.split('?')[0],
            body: bv.label,
            http: res.status,
            status_code: statusCode ?? null,
            message: msg,
            has_channel_id: !!channelId,
          });

          // `user_not_permision` = agent chưa được gán vào nhóm Zalo.
          // Cấp quyền rồi gửi lại (tương đương thao tác gán nhân viên trên OmiCall).
          if (!permissionGranted && !opts._retried && /user_not_permision|permission/i.test(String(msg))) {
            permissionGranted = true;
            const granted = await ensureAgentInGroup(ctx, convMongoId);
            if (granted) {
              const retry = await sendZaloPersonalMessage({
                ...opts,
                convId: convMongoId,
                channelId,
                _retried: true,
              });
              if (retry.success) return retry;
              lastError = retry.error || lastError;
              apiError = lastError;
            }
          }

          // `error_occurred` = lỗi CHUNG của upstream. Có 2 nguyên nhân phổ biến:
          //  1. Agent CHƯA được gán vào nhóm Zalo (đã quan sát 2026-11-26: nhóm
          //     'A Công - Gò Chai' trả error_occurred trong khi nhóm khác dùng
          //     CÙNG channel_id + CÙNG body lại gửi OK → khác biệt duy nhất là
          //     quyền của agent trong nhóm).
          //  2. Phiên Zalo bị gián đoạn (token hết hạn / kênh mất kết nối tạm thời).
          //
          // → Xử lý: THỬ cấp quyền agent vào nhóm TRƯỚC (giống `user_not_permision`),
          //   rồi mới thử lại với token MỚI + channel_id MỚI.
          if (
            !opts._retried
            && !permissionGranted
            && /error_occurred/i.test(String(msg))
          ) {
            logger.warn('[OMICALL] error_occurred — thử cấp quyền agent vào nhóm, rồi thử lại', {
              host,
              convId: convMongoId,
              has_channel_id: !!channelId,
            });

            // 1) Cấp quyền agent vào nhóm (nếu được) → gửi lại ngay.
            permissionGranted = true;
            const granted = await ensureAgentInGroup(ctx, convMongoId);
            if (granted) {
              const retryAfterGrant = await sendZaloPersonalMessage({
                ...opts,
                convId: convMongoId,
                channelId,
                _retried: true,
                _retryReason: 'error_occurred_after_grant',
              });
              if (retryAfterGrant.success) return retryAfterGrant;
              lastError = retryAfterGrant.error || lastError;
              apiError = lastError;
              continue;
            }

            // 2) Không cấp được quyền → có thể conv đã CHẾT (agent đã rời
            //    nhóm Zalo → OmiCall tạo conv MỚI cho cùng nhóm).
            //    → Tự động tìm conv còn sống và gửi lại (auto-heal).
            if (!opts._retried && opts.groupName) {
              const healed = await resolveLiveConvId({
                convId: convMongoId,
                groupName: opts.groupName,
              });
              if (healed.changed && healed.convId !== convMongoId) {
                logger.warn('[OMICALL] Conv đã chết — tự động chuyển sang conv sống mới', {
                  oldConvId: convMongoId,
                  newConvId: healed.convId,
                  groupName: opts.groupName,
                  staleReason: healed.staleReason,
                });
                const retryHealed = await sendZaloPersonalMessage({
                  ...opts,
                  convId: healed.convId,
                  channelId: '',
                  _retried: true,
                  _retryReason: 'auto_heal_stale_conv',
                  _healedFrom: convMongoId,
                });
                if (retryHealed.success) {
                  return { ...retryHealed, healedFrom: convMongoId, healedTo: healed.convId };
                }
                lastError = retryHealed.error || lastError;
                apiError = lastError;
              }
            }

            // 3) Vẫn lỗi → coi là lỗi tạm thời → thử lại với token MỚI và
            //    channel_id lấy lại (bỏ qua cache cũ).
            clearTokenCache();
            channelIdCache.clear();
            const retry = await sendZaloPersonalMessage({
              ...opts,
              convId: convMongoId,
              _retried: true,
              _retryReason: 'error_occurred',
            });
            if (retry.success) return retry;
            lastError = retry.error || lastError;
            apiError = lastError;
          }

          continue;
        }

        const payload = (body && body.payload) || {};
        return {
          success: true,
          messageId: payload.message_id || payload.msgId || payload.id || payload._id || null,
          raw: body,
        };
      }
    }
  }

  return {
    success: false,
    error:
      apiError ||
      lastError ||
      'Không tìm được endpoint gửi tin OmiCall. Kiểm tra lại Base URL (thử https://public-v1-stg.omicall.com nếu tài khoản OmiCall của bạn thuộc môi trường staging).',
    // Gợi ý hành động cho admin khi lỗi là "tạm thời" (upstream chập chờn).
    hint: /error_occurred/i.test(String(apiError || lastError || ''))
      ? 'Lỗi tạm thời từ phía OmiCall (phiên Zalo bị gián đoạn). Hãy thử gửi lại sau vài phút — tin nhắn sẽ tự gửi khi kênh Zalo kết nối lại.'
      : (!channelId
        ? 'Không lấy được channel_id (kênh Zalo cá nhân) — hãy kiểm tra kênh Zalo trên OmiCall đã đăng nhập và kết nối chưa.'
        : null),
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

  // Các biến thể body: body ĐÚNG của OmiCall là `{ conv_id, channel_id, text }`.
  const ctx = { apiKey, baseUrl, token, headers };
  let channelId = String(opts.channelId || '').trim();
  if (!channelId) {
    channelId = await fetchChannelId(ctx);
  }
  let convMongoId = convId;
  if (!/^[a-f0-9]{24}$/i.test(convMongoId)) {
    const resolved = await resolveMongoConvId(ctx, convMongoId);
    if (resolved) convMongoId = resolved;
  }
  const bodyVariants = buildMessageBodies(convMongoId, channelId, text);

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
 * ⚠️ Endpoint là `/omi_v2/omnichannel/...` (có chữ **n** trong "omnichannel").
 *    Bản `omichannel` (thiếu n) trong một số tài liệu cũ trả 404.
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

  const page = Number(opts.page) || 1;
  const size = Math.min(100, Number(opts.size) || 20);
  const keyword = String(opts.keyword || '').trim();
  const allPages = opts.allPages !== false;
  const maxPages = Math.min(20, Number(opts.maxPages) || 10);
  // Chiều sắp xếp:
  //  - 'asc'  (mặc định): last_message_time TĂNG dần → hội thoại CŨ trước.
  //  - 'desc': last_message_time GIẢM dần → hội thoại MỚI trước.
  //
  // ⚠️ Vì sao cần CẢ HAI?
  //  Nhóm Zalo vừa tạo chưa có tin nhắn nào → last_message_time rất nhỏ (hoặc null).
  //  Với sort tăng dần, các nhóm mới bị đẩy xuống CUỐI danh sách → vượt quá
  //  giới hạn mà OmiCall trả về (~337 mục) → KHÔNG THỤY được trong danh sách.
  //  Với sort giảm dần, nhóm mới nằm ở đầu → luôn thấy được.
  //  → Gom cả 2 chiều rồi gộp (loại trùng convId) để không bỏ sót nhóm nào.
  const sortDir = opts.sortDir === 'desc' ? 'desc' : 'asc';

  const body = {
    types: [],
    keyword,
    sort: { field_code: 'last_message_time', is_asc: sortDir !== 'desc' },
    is_session: false,
    is_blocked: false,
    channel_ids: [],
  };

  const attempts = [];
  for (const host of resolveMessageHosts(baseUrl)) {
    const paths = [
      `/omi_v2/omnichannel/search_v4?page=${page}&size=${size}`,
      `/omi_v2/omnichannel/search_v4?page=${page}&size=${size}&lng=vi`,
    ];
    for (const path of paths) {
      for (const method of ['POST', 'GET']) {
        let res;
        let raw = '';
        try {
          res = await fetchWithTimeout(`${host}${path}`, {
            method,
            headers,
            ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
          });
          raw = await res.text();
        } catch (e) {
          attempts.push({ host, path, method, http: 0, result: 'FETCH_FAIL', detail: e.message });
          continue;
        }

        if (/^\s*<(!doctype|html)/i.test(raw)) {
          attempts.push({ host, path, method, http: res.status, result: 'HTML' });
          continue;
        }

        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch (_) {
          parsed = { message: raw };
        }

        const statusCode = parsed && parsed.status_code;
        if (res.ok && (statusCode === undefined || Number(statusCode) === 9999)) {
          const payload = (parsed && parsed.payload) || {};
          // OmiCall trả payload.conversations.items[] — mỗi item có `conv.conv_id`,
          // `conv.channel_id`, `conv.name`.
          const convRoot = payload.conversations || payload;
          let list = Array.isArray(convRoot)
            ? convRoot
            : convRoot.items || convRoot.data || convRoot.list || [];
          list = Array.isArray(list) ? list : [];
          const conversations = list.map((it) => {
            const conv = (it && it.conv) || it || {};
            const mapped = {
              // Mongo `_id` của hội thoại — ĐÂY là giá trị phải dùng khi gửi tin.
              convId: it.id || conv._id || null,
              // conv_id dạng số của hội thoại (KHÔNG dùng để gửi tin).
              convNumber: conv.conv_id || null,
              channelId: conv.channel_id || it.channel_id || null,
              name: conv.name || conv.nick_name || it.name || null,
              convType: conv.conv_type || it.type || null,
              convSubType: conv.conv_sub_type || null,
              type: it.type || conv.conv_type || null,
              raw: it,
            };
            // Gắn nhãn "còn sống / đã chết" để UI bỏ qua nhóm không dùng được.
            Object.assign(mapped, classifyConversationState(mapped));
            return mapped;
          });

          // Gom nhiều trang để tìm hết nhóm Zalo (nhóm thường nằm ở trang sau).
          if (allPages && page < maxPages) {
            const next = await listConversations({
              ...opts,
              config: { apiKey, baseUrl },
              page: page + 1,
              _collected: [...(opts._collected || []), ...conversations],
            });
            if (next.success) {
              return { success: true, conversations: next.conversations, raw: parsed, attempts };
            }
          }

          const collected = opts._collected || [];
          return {
            success: true,
            conversations: [...collected, ...conversations],
            raw: parsed,
            attempts,
          };
        }

        attempts.push({
          host,
          path,
          method,
          http: res.status,
          result: 'ERR',
          detail: (parsed && (parsed.message || parsed.msg)) || `HTTP ${res.status}`,
        });
      }
    }
  }

  return {
    success: false,
    error: 'Không tìm được endpoint liệt kê hội thoại OmiCall',
    attempts,
  };
}

/**
 * Phan loai trang thai hoi thoai (conversation) cua OmiCall.
 *
 * WHY: khi agent ROI nhom Zalo va VAO LAI, OmiCall tao mot conversation MOI
 * (id khac) cho cung mot nhom, con conversation CU van nam trong danh sach
 * va trung TEN. Neu khong phan biet, nguoi dung se bam nham conversation da
 * chet -> moi lien ket -> gui tin luon loi "error_occurred".
 *
 * Signals (da kiem chung truc tiep tren server OmiCall production):
 *  - conv.status === 'inactive'  -> OmiCall danh dau nhom da ket thuc.
 *  - conv.last_message.type === 'activity' va khong co message_id
 *    -> tin cuoi cung chi la su kien agent vao nhom, chua co tin nhan nao.
 *  - conv.chat_session.joined_agents rong -> khong con agent nao trong nhom.
 */
function classifyConversationState(c) {
  const raw = (c && c.raw) || {};
  const conv = raw.conv || {};
  const cs = conv.chat_session || {};
  const lm = conv.last_message || {};

  const staleReasons = [];

  if (conv.status === 'inactive') {
    staleReasons.push('OmiCall danh dau nhom da ket thuc (da roi nhom)');
  }

  if (lm.type === 'activity' && !lm.message_id) {
    staleReasons.push('Tin nhan cuoi cung chi la hoat dong (agent moi vao nhom), chua co tin nhan nao');
  }

  const joined = cs.joined_agents;
  if (Array.isArray(joined) && joined.length === 0) {
    staleReasons.push('Khong con nhan vien nao duoc gan vao nhom');
  }

  const isStale = staleReasons.length > 0;

  // Nhom chua duoc gan agent (has_member=false) -> van gui duoc sau khi
  // tu dong gan, nen KHONG coi la stale.
  const hasMember = raw.has_member === true;
  const joinedCount = Array.isArray(joined) ? joined.length : null;
  const needsAgent = !hasMember && (joinedCount === null || joinedCount === 0);

  return {
    isAlive: !isStale,
    alive: !isStale,
    isStale,
    needsAgent,
    hasMember,
    staleReason: isStale ? staleReasons.join('; ') : '',
    // Thoi diem hoat dong cuoi cung -> dung de sap xep "nhom moi nhat len dau".
    lastActivityAt: Number(
      (conv.last_message_info && conv.last_message_info.send_time) ||
        conv.last_updated_date ||
        conv.created_date ||
        0
    ) || 0,
  };
}

/**
 * Liệt kê hội thoại, gom CẢ HAI chiều sắp xếp (cũ→mới và mới→cũ).
 *
 * ⚠️ Vì sao cần gom cả hai?
 *  OmiCall `search_v4` chỉ trả về khoảng ~337 hội thoại đầu tiên theo thứ tự
 *  `last_message_time`. Nhóm Zalo **vừa tạo** chưa có tin nhắn nên có
 *  `last_message_time` rất nhỏ → xếp cuối danh sách khi sort TĂNG dần →
 *  **không bao giờ xuất hiện** trong danh sách nhóm dù nhóm đã tồn tại.
 *  (Người dùng phải biết convId và tìm bằng keyword mới thấy.)
 *
 *  → Gọi cả 2 chiều rồi gộp theo convId → nhóm mới lẫn nhóm cũ đều có.
 *
 * @param {object} opts
 * @returns {Promise<{success:boolean, conversations?:Array, error?:string}>}
 */
async function listConversationsBoth(opts = {}) {
  // Gọi qua module.exports để có thể mock/override trong test.
  const fetchList = module.exports.listConversations || listConversations;

  // Không có keyword → gom cả 2 chiều. Có keyword → 1 chiều là đủ (kết quả đã
  // lọc sẵn và nhỏ).
  if (opts.keyword) {
    const one = await fetchList(opts);
    if (!one || !one.success) return one;
    const pickedKw = pickLiveConversations(one.conversations || []);
    return {
      success: true,
      conversations: pickedKw.list,
      total: pickedKw.total,
      stale: pickedKw.staleCount,
    };
  }

  const [asc, desc] = await Promise.all([
    fetchList({ ...opts, sortDir: 'asc' }),
    fetchList({ ...opts, sortDir: 'desc' }),
  ]);

  const merged = [];
  const seen = new Set();
  for (const res of [asc, desc]) {
    if (!res || !res.success) continue;
    for (const c of res.conversations || []) {
      const key = String(c.convId || c.raw?.id || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(c);
    }
  }

  // ── Loại conversation "đã chết" + gộp trùng TÊN ────────────────────────────
  // Khi agent rời nhóm rồi vào lại, OmiCall tạo conv MỚI (id khác) cho cùng
  // một nhóm và giữ lại conv CŨ (conv đã chết) — hai conv TRÙNG TÊN.
  // Chỉ giữ conv còn sống cho mỗi tên, ưu tiên conv hoạt động gần nhất
  // → nút "Tải nhóm" luôn trả về nhóm MỚI nhất, không còn conv chết.
  if (!merged.length) {
    const failed = !asc?.success ? asc : desc;
    return {
      success: false,
      error: failed?.error || 'Không lấy được danh sách hội thoại OmiCall',
      attempts: [...(asc?.attempts || []), ...(desc?.attempts || [])],
    };
  }
  const picked = pickLiveConversations(merged);
  const unique = picked.list;

  // Sắp xếp: nhóm hoạt động gần nhất lên đầu (nhóm mới tạo luôn nằm trên).
  unique.sort((a, b) => Number(b.lastActivityAt || 0) - Number(a.lastActivityAt || 0));

  return { success: true, conversations: unique, total: picked.total, stale: picked.staleCount };
}

/**
 * Chẩn đoán tài khoản OmiCall: kênh đã kết nối + thử liệt kê hội thoại.
 *
 * Mục đích: xác định chính xác vì sao `send_text` trả `invalid_param`:
 *  - Tài khoản chưa bật module "đa kênh"/"Zalo cá nhân" → cần bật ở OmiCall.
 *  - `convId` không thuộc tenant → cần lấy đúng id.
 *
 * @returns {Promise<{success:boolean, data?:object, error?:string}>}
 */
async function diagnoseAccount(opts = {}) {
  const cfg = { ...getConfig(), ...(opts.config || {}) };
  const apiKey = String(cfg.apiKey || '').trim();
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  if (!apiKey) return { success: false, error: 'Chưa cấu hình OmiCall API key' };

  let token = null;
  let tokenError = null;
  try {
    token = await getAccessToken({ apiKey, baseUrl, force: true });
  } catch (e) {
    tokenError = e.message;
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-api-key': apiKey,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const probes = [];
  const run = async (label, host, path, method, body) => {
    let res;
    let raw = '';
    try {
      res = await fetchWithTimeout(`${host}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      raw = await res.text();
    } catch (e) {
      probes.push({ label, host, path, http: 0, result: 'FETCH_FAIL', detail: e.message });
      return;
    }
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch (_) {
      parsed = null;
    }
    const isHtml = /^\s*<(!doctype|html)/i.test(raw);
    probes.push({
      label,
      host,
      path,
      http: res.status,
      result: isHtml ? 'HTML' : res.ok ? 'OK' : 'ERR',
      status_code: parsed && parsed.status_code !== undefined ? parsed.status_code : null,
      message: (parsed && (parsed.message || parsed.msg)) || '',
      payload: parsed && parsed.payload !== undefined ? parsed.payload : undefined,
    });
  };

  for (const host of resolveMessageHosts(baseUrl)) {
    await run('channels', host, '/omnichannel/channel/get_all', 'POST', {});
    await run('conv_search', host, '/omi_v2/omnichannel/search_v4?page=1&size=20', 'POST', {
      types: [],
      keyword: '',
      sort: { field_code: 'last_message_time', is_asc: true },
      is_session: false,
      channel_ids: [],
    });
    await run('conv_search_get', host, '/omi_v2/omnichannel/search_v4?page=1&size=20', 'GET', null);
  }

  // Tenant info trên host public (xác nhận token thuộc đúng doanh nghiệp)
  for (const host of resolveMessageHosts(baseUrl)) {
    if (!/public-v1/i.test(host)) continue;
    await run('tenant_detail', host, '/api/tenant/detail', 'POST', {});
  }

  return {
    success: true,
    data: {
      tokenObtained: !!token,
      tokenError,
      probes,
    },
  };
}

/**
 * T\u00ecm conversation \u0111ANG S\u1ed0NG m\u1ed1i nh\u1ea5t theo t\u00e9n nh\u00f3m Zalo.
 *
 * WHY: khi agent r\u1ed7i nh\u00f3m r\u1ed3i v\u00e0o l\u1ea1i, OmiCall t\u1ea1o conv M\u1ed0I (id kh\u00e1c)
 * cho c\u00f9ng m\u1ed9t nh\u00f3m. Conv c\u0169 v\u1eabn n\u1e1m trong DB \u0111\u1ec3 li\u00ean k\u1eb7t \u2192 g\u1eedi tin
 * lu\u00f4n l\u1ed7i "error_occurred". H\u00e0m n\u00e0y gi\u1e5i t\u00ean nh\u00f3m \u2192 tr\u1ea3 v\u1ec1 conv s\u1ed1ng.
 *
 * @param {string} name - t\u00e9n nh\u00f3m Zalo (kh\u00f4ng ph\u00e2i bi\u1ec7t)
 * @returns {Promise<{found:boolean, convId?:string, name?:string, reason?:string}>}
 */
async function findLiveConversationByName(name) {
  const kw = String(name || '').trim();
  if (!kw) return { found: false, reason: 'Thi\u1ebfu t\u00e9n nh\u00f3m' };

  const res = await listConversationsBoth({ keyword: kw, size: 100 });
  if (!res || !res.success) {
    return { found: false, reason: (res && res.error) || 'Kh\u00f4ng l\u1ea5y \u0111\u01b0\u1ee3c danh s\u00e1ch h\u1ed9i tho\u1ea1i OmiCall' };
  }

  const want = kw.toLowerCase();
  const groups = (res.conversations || []).filter((c) => c.convSubType === 'group');
  const exact = groups.filter((c) => String(c.name || '').trim().toLowerCase() === want);
  const alive = exact.filter((c) => !c.isStale);
  const pool = alive.length ? alive : exact;

  if (!pool.length) {
    return { found: false, reason: 'Kh\u00f4ng t\u00ecm th\u1ea5y nh\u00f3m Zalo \u0111\u00fang ho\u1ea1t \u0111\u1ed9ng tr\u00ean OmiCall' };
  }

  // M\u1ed1i nh\u1ea5t theo th\u1eddi gian ho\u1ea1t \u0111\u1ed9ng.
  pool.sort((a, b) => Number(b.lastActivityAt || 0) - Number(a.lastActivityAt || 0));
  const best = pool[0];
  return {
    found: true,
    convId: best.convId,
    name: best.name,
    channelId: best.channelId,
    lastActivityAt: best.lastActivityAt || 0,
  };
}

/**
 * Ch\u1ecdnh danh s\u00e1ch conversation \u0111\u1ec3 d\u00f9ng \u0111\u01b0\u1ee3c g\u1eedi tin.
 *
 * 1. LO\u1ea1I conversation "\u0111\u00e3 ch\u1ebft" (agent \u0111\u00e3 r\u1ed7i nh\u00f3m / m\u1ea5t quy\u1ec1n).
 * 2. G\u1ed9P conversation tr\u00f9ng T\u00caN \u2014 gi\u1eef conv ho\u1ea1t \u0111\u1ed9ng g\u1ea7n nh\u1ea5t.
 * 3. S\u1eafp x\u1ebfp nh\u00f3m ho\u1ea1t \u0111\u1ed9ng g\u1ea7n nh\u1ea5t l\u00ean \u0111\u1ea7u.
 *
 * @param {Array} conversations
 * @returns {{list: Array, staleCount: number, total: number}}
 */
function pickLiveConversations(conversations) {
  const merged = Array.isArray(conversations) ? conversations : [];

  const byName = new Map();
  const list = [];

  for (const c of merged) {
    if (c.isStale) {
      logger.info('[OMICALL] B\u1ec7 qua conversation \u0111\u00e3 ch\u1ebft', {
        convId: c.convId,
        name: c.name,
        reason: c.staleReason,
      });
      continue;
    }
    const nameKey = String(c.name || '').trim().toLowerCase();
    if (!nameKey) {
      list.push(c);
      continue;
    }
    const prev = byName.get(nameKey);
    if (!prev) {
      byName.set(nameKey, c);
      list.push(c);
      continue;
    }
    // C\u00f9ng t\u00ean \u2192 gi\u1eef conv ho\u1ea1t \u0111\u1ed9ng g\u1ea7n nh\u1ea5t.
    const prevAt = Number(prev.lastActivityAt || 0);
    const curAt = Number(c.lastActivityAt || 0);
    if (curAt > prevAt) {
      const idx = list.indexOf(prev);
      if (idx >= 0) list[idx] = c;
      byName.set(nameKey, c);
    }
  }

  list.sort((a, b) => Number(b.lastActivityAt || 0) - Number(a.lastActivityAt || 0));

  return { list, staleCount: merged.length - list.length, total: merged.length };
}

/**
 * T\u00edm convId \u0111ANG S\u1ed0NG cho m\u1ed9t nh\u00f3m Zalo \u0111\u00e3 bi\u1ebft link sai.
 *
 * WHY: khi agent r\u1ed7i nh\u00f3m r\u1ed3i v\u00e0o l\u1ea1i, OmiCall t\u1ea1o conv M\u1ed0I (id kh\u00e1c)
 * cho c\u00f9ng m\u1ed9t nh\u00f3m. Conv c\u0169 v\u1eabn n\u1e1m trong DB \u0111\u1ec3 li\u00ean k\u1eb7t \u2192 g\u1eedi tin
 * lu\u00f4n l\u1ed7i "error_occurred". H\u00e0m n\u00e0y t\u1ef1 \u0111\u1ed9ng tra c\u1ee9u conv \u0111ang d\u00f9ng
 * v\u00e0 tr\u1ea3 v\u1ec1 conv s\u1ed1ng m\u1ed1i nh\u1ea5t c\u00f9ng t\u00ean.
 *
 * @param {object} opts
 * @param {string} opts.convId   - convId \u0111ang l\u01b0u (c\u00f3 th\u0111\u00e3 ch\u1ebft)
 * @param {string} opts.groupName - t\u00ean nh\u00f3m Zalo (d\u00f9ng \u0111\u1ec3 t\u00ecm conv m\u1ed1i)
 * @returns {Promise<{convId:string, changed:boolean, staleReason:string, reason:string}>}
 */
async function resolveLiveConvId(opts = {}) {
  const current = String(opts.convId || '').trim();
  const groupName = String(opts.groupName || '').trim();

  const out = {
    convId: current,
    changed: false,
    staleReason: '',
    reason: '',
  };

  if (!current) {
    out.reason = 'Thi\u1ebfu convId';
    return out;
  }

  // C\u1ea7n t\u00ean nh\u00f3m \u0111\u1ec3 t\u00ecm conv thay th\u1ebf.
  if (!groupName) {
    out.reason = 'Thi\u1ebfu t\u00ean nh\u00f3m \u0111\u1ec3 t\u00ecm conv thay th\u1ebf';
    return out;
  }

  const res = await listConversationsBoth({ keyword: groupName, size: 100 });
  if (!res || !res.success) {
    out.reason = (res && res.error) || 'Kh\u00f4ng l\u1ea5y \u0111\u01b0\u1ee3c danh s\u00e1ch nh\u00f3m OmiCall';
    return out;
  }

  const want = groupName.trim().toLowerCase();
  const sameName = (res.conversations || []).filter(
    (c) => String(c.name || '').trim().toLowerCase() === want
  );

  // Conv \u0111ang d\u00f9ng c\u00f3 c\u00f2n s\u1ed1ng trong danh s\u00e1ch \u2192 gi\u1eef nguy\u00ean.
  const mine = sameName.find((c) => String(c.convId) === current);
  if (mine && !mine.isStale) {
    out.reason = 'Conv hi\u1ec7n t\u1ea1i v\u1eabn c\u00f2n s\u1ed1ng';
    return out;
  }

  // Conv \u0111ang d\u00f9ng \u0111\u00e3 ch\u1ebft \u2192 t\u00ecm conv s\u1ed1ng kh\u00e1c c\u00f9ng t\u00ean.
  const alive = sameName.filter((c) => !c.isStale && String(c.convId) !== current);
  if (!alive.length) {
    out.staleReason = (mine && mine.staleReason) || 'Conv \u0111ang d\u00f9ng kh\u00f4ng c\u00f2n s\u1ed1ng';
    out.reason = alive.length
      ? 'Kh\u00f4ng t\u00ecm th\u1ea5y conv s\u1ed1ng thay th\u1ebf'
      : 'Kh\u00f4ng t\u00ecm th\u1ea5y nh\u00f3m Zalo n\u00e0o kh\u00e1c \u0111ang ho\u1ea1t \u0111\u1ed9ng';
    return out;
  }

  alive.sort((a, b) => Number(b.lastActivityAt || 0) - Number(a.lastActivityAt || 0));
  const best = alive[0];
  out.convId = best.convId;
  out.changed = true;
  out.staleReason = (mine && mine.staleReason) || 'Conv c\u0169 \u0111\u00e3 ch\u1ebft';
  out.reason = '\u0110\u00e3 t\u1ef1 \u0111\u1ed9ng sang conv s\u1ed1ng m\u1ed1i nh\u1ea5t';
  return out;
}

module.exports = {
  DEFAULT_BASE_URL,
  getConfig,
  getPublicConfig,
  saveConfig,
  getAccessToken,
  clearTokenCache,
  sendZaloPersonalMessage,
  assignAgentToGroup,
  classifyConversationState,
  pickLiveConversations,
  findLiveConversationByName,
  resolveLiveConvId,
  testConnection,
  probeSendEndpoints,
  listConversations,
  listConversationsBoth,
  diagnoseAccount,
};
