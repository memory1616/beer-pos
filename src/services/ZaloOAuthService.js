/**
 * Zalo OAuth v4 Service — lấy & làm mới OA Access Token.
 * ─────────────────────────────────────────────────────────────────────────────
 * Tài liệu: https://docs.zaloplatforms.com/docs/OA/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new
 *
 * Luồng (PKCE):
 *   1. Sinh code_verifier + code_challenge (S256) → lưu code_verifier vào settings.
 *   2. Admin OA mở authorize URL → Zalo redirect về callback kèm `?code=`.
 *   3. Đổi code lấy access_token + refresh_token → lưu vào settings.
 *
 * Token: access_token sống 25h, refresh_token sống 3 tháng (chỉ dùng 1 lần).
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

const OA_AUTH_URL = 'https://oauth.zaloapp.com/v4/oa/permission';
const OA_TOKEN_URL = 'https://oauth.zaloapp.com/v4/oa/access_token';
const REQUEST_TIMEOUT_MS = 15000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSetting(key, fallback = '') {
  try {
    const row = require('../../database')
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key);
    return row && row.value !== null ? String(row.value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function setSetting(key, value) {
  const db = require('../../database');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    key,
    value === null || value === undefined ? '' : String(value)
  );
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Base64URL không padding (chuẩn PKCE S256). */
function base64UrlEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Sinh cặp code_verifier / code_challenge (PKCE S256).
 *
 * Theo SDK chính thức Zalo (zalo-php-sdk):
 *   code_verifier = Base64URL(random 32 bytes)   → 43 ký tự
 *   code_challenge = Base64URL(SHA-256(verifier)) → không padding
 *
 * @returns {{codeVerifier: string, codeChallenge: string}}
 */
function generatePkce() {
  // 32 bytes → base64url = 43 ký tự (đúng yêu cầu của Zalo)
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(
    crypto.createHash('sha256').update(codeVerifier, 'ascii').digest()
  );
  return { codeVerifier, codeChallenge };
}

/**
 * Tính appsecret_proof = HMAC-SHA256(access_token, secret_key) hex.
 * Header `X-Appsecret-Proof` — Zalo có thể bật chế độ bắt buộc proof cho app
 * (nếu thiếu → lỗi -242).
 *
 * @param {string} accessToken
 * @param {string} secretKey
 * @returns {string|null} hex string, hoặc null nếu thiếu secret key
 */
function buildAppSecretProof(accessToken, secretKey) {
  if (!accessToken || !secretKey) return null;
  return crypto
    .createHmac('sha256', secretKey)
    .update(accessToken)
    .digest('hex');
}

// ── Bước 1: tạo authorize URL ───────────────────────────────────────────────

/**
 * Tạo URL cấp quyền cho admin OA.
 * @param {string} redirectUri - Callback URL đã đăng ký trong Zalo App
 * @returns {{ok: boolean, url?: string, error?: string, codeChallenge?: string}}
 */
function buildAuthorizeUrl(redirectUri) {
  const appId = getSetting('zalo_oa_app_id');
  if (!appId) {
    return { ok: false, error: 'Chưa cấu hình Zalo App ID' };
  }
  if (!redirectUri) {
    return { ok: false, error: 'Thiếu redirect_uri (callback URL)' };
  }

  const { codeVerifier, codeChallenge } = generatePkce();
  // Lưu verifier để callback dùng khi đổi code → token
  setSetting('zalo_oa_code_verifier', codeVerifier);

  // `state` chống CSRF: Zalo trả lại nguyên giá trị, ta kiểm tra ở callback.
  const state = base64UrlEncode(crypto.randomBytes(16));
  setSetting('zalo_oa_state', state);

  const params = new URLSearchParams({
    app_id: String(appId),
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  return {
    ok: true,
    url: `${OA_AUTH_URL}?${params.toString()}`,
    codeChallenge,
    state,
  };
}

/**
 * Kiểm tra `state` trả về từ Zalo có khớp với giá trị đã lưu không.
 * @param {string} state
 * @returns {boolean}
 */
function verifyState(state) {
  if (!state) return false;
  const saved = getSetting('zalo_oa_state');
  if (!saved) return false; // không có state đã lưu → không hợp lệ
  return saved === String(state);
}

/**
 * Xoá state + verifier sau khi đã dùng (chống replay).
 */
function clearOAuthSession() {
  try {
    setSetting('zalo_oa_state', '');
    setSetting('zalo_oa_code_verifier', '');
  } catch (_) {
    /* ignore */
  }
}

// ── Bước 2: đổi authorization code lấy token ───────────────────────────────

/**
 * Đổi authorization code lấy access_token + refresh_token, lưu vào settings.
 * @param {string} code - authorization code từ callback
 * @returns {Promise<{ok:boolean, error?:string, accessToken?:string}>}
 */
async function exchangeCodeForToken(code) {
  const appId = getSetting('zalo_oa_app_id');
  const secretKey = getSetting('zalo_oa_secret_key');
  const codeVerifier = getSetting('zalo_oa_code_verifier');

  if (!code) return { ok: false, error: 'Thiếu authorization code' };
  if (!appId || !secretKey) {
    return { ok: false, error: 'Chưa cấu hình Zalo App ID / Secret Key' };
  }

  const body = new URLSearchParams({
    code: String(code),
    app_id: String(appId),
    grant_type: 'authorization_code',
  });
  // PKCE: chỉ gửi code_verifier nếu app bật PKCE
  if (codeVerifier) body.set('code_verifier', codeVerifier);

  try {
    const res = await fetchWithTimeout(OA_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        secret_key: secretKey,
      },
      body: body.toString(),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok || json.error) {
      const msg = json.message || `HTTP ${res.status}${json.error ? ' (error ' + json.error + ')' : ''}`;
      logger.error('[ZALO_OAUTH] Exchange code failed', { error: msg });
      return { ok: false, error: msg };
    }

    if (json.access_token) setSetting('zalo_oa_access_token', String(json.access_token));
    if (json.refresh_token) setSetting('zalo_oa_refresh_token', String(json.refresh_token));
    // Code chỉ dùng 1 lần → xoá verifier + state sau khi dùng
    clearOAuthSession();

    logger.info('[ZALO_OAUTH] Access token obtained', {
      expires_in: json.expires_in || null,
      hasRefreshToken: Boolean(json.refresh_token),
    });

    return {
      ok: true,
      accessToken: json.access_token || null,
      refreshToken: json.refresh_token || null,
      expiresIn: json.expires_in || null,
    };
  } catch (err) {
    const msg =
      err.name === 'AbortError' ? 'Timeout khi đổi code lấy token' : err.message;
    logger.error('[ZALO_OAUTH] Exchange code error', { error: msg });
    return { ok: false, error: msg };
  }
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  verifyState,
  clearOAuthSession,
  generatePkce,
  buildAppSecretProof,
};
