/**
 * Notification Channels — Gửi báo cáo tự động qua Zalo OA / Telegram / Webhook.
 * ─────────────────────────────────────────────────────────────────────────────
 * Thiết kế:
 *  - Mỗi kênh là một adapter có cùng chữ ký: `send({text, title, meta})` →
 *    `{ ok, code, error }`.
 *  - Không nhúng secret vào code: token lấy từ bảng `settings` (được admin
 *    cấu hình qua UI) — không nằm trong .env/git.
 *  - Dùng `fetch` native của Node 20 (không thêm dependency).
 */

const logger = require('../utils/logger');
const DailyReportService = require('./DailyReportService');

// Timeout cho mọi request ra ngoài (tránh treo cron job).
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

/** fetch có timeout. */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Kênh: Zalo OA ───────────────────────────────────────────────────────────
// Tài liệu: https://docs.zaloplatforms.com/docs/OA/tin-nhan/tin-tu-van/gui-tin-tu-van-dang-van-ban
//
// ⚠️ API v2.0 ĐÃ BỊ ZALO SHUTDOWN (lỗi -240 "api v2 shutdown").
//    Endpoint đúng là v3.0 và body phải bọc `recipient.user_id`.
//
// Yêu cầu:
//   - OA Access Token (OAuth v4: https://oauth.zaloapp.com/v4/oa/access_token)
//   - user_id của người nhận (lấy từ API GET v3.0/oa/user/getlist)
async function sendZalo({ text }) {
  const accessToken = getSetting('zalo_oa_access_token');
  const userId = getSetting('zalo_report_user_id');

  if (!accessToken) {
    return { ok: false, code: 0, error: 'Chưa cấu hình Zalo OA Access Token' };
  }
  if (!userId) {
    return { ok: false, code: 0, error: 'Chưa cấu hình user_id người nhận Zalo' };
  }

  const result = await postZaloMessage(accessToken, userId, text);

  // Token hết hạn (sau 25h) → thử refresh 1 lần rồi gửi lại.
  if (!result.ok && result.code === -216 && getSetting('zalo_oa_refresh_token')) {
    logger.warn('[ZALO] Access token expired, trying refresh');
    const refreshed = await refreshZaloToken();
    if (refreshed.ok && refreshed.accessToken) {
      return postZaloMessage(refreshed.accessToken, userId, text);
    }
    return {
      ok: false,
      code: result.code,
      error: `Token Zalo đã hết hạn và refresh thất bại: ${refreshed.error}`,
    };
  }

  return result;
}

/** Gửi 1 tin nhắn CS (v3.0) với token cho trước. */
async function postZaloMessage(accessToken, userId, text) {
  try {
    const res = await fetchWithTimeout('https://openapi.zalo.me/v3.0/oa/message/cs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        access_token: accessToken,
      },
      body: JSON.stringify({
        // v3.0 yêu cầu object `recipient`, không phải `user_id` ở top-level.
        recipient: { user_id: String(userId) },
        message: { text: String(text).slice(0, 2000) }, // giới hạn 2000 ký tự
      }),
    });

    const body = await res.json().catch(() => ({}));

    // Zalo trả HTTP 200 kể cả khi lỗi → phải kiểm tra body.error
    if (!res.ok || (body.error && body.error !== 0)) {
      const msg =
        body.message || `HTTP ${res.status}${body.error ? ' ' + body.error : ''}`;
      return { ok: false, code: body.error || res.status, error: msg };
    }

    return { ok: true, code: 0, data: body.data || null };
  } catch (err) {
    return {
      ok: false,
      code: 0,
      error: err.name === 'AbortError' ? 'Timeout khi gửi Zalo' : err.message,
    };
  }
}

// ── Kênh: Telegram Bot ───────────────────────────────────────────────────────
// Gửi qua Telegram Bot API. Token dạng "<bot_token>" lấy từ @BotFather.
async function sendTelegram({ text }) {
  const token = getSetting('telegram_bot_token');
  const chatId = getSetting('telegram_report_chat_id');

  if (!token) {
    return { ok: false, code: 0, error: 'Chưa cấu hình Telegram Bot Token' };
  }
  if (!chatId) {
    return { ok: false, code: 0, error: 'Chưa cấu hình Telegram chat_id' };
  }

  try {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: String(chatId), text: text }),
      }
    );

    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      return {
        ok: false,
        code: body.error_code || res.status,
        error: body.description || `HTTP ${res.status}`,
      };
    }
    return { ok: true, code: 0, data: { message_id: body.result?.message_id } };
  } catch (err) {
    return {
      ok: false,
      code: 0,
      error: err.name === 'AbortError' ? 'Timeout khi gửi Telegram' : err.message,
    };
  }
}

// ── Kênh: Webhook ────────────────────────────────────────────────────────────
// Đẩy JSON ra hệ thống ngoài (Google Sheets / n8n / Lark / Make).
async function sendWebhook({ text, title, meta }) {
  const url = getSetting('report_notify_webhook_url');
  if (!url) {
    return { ok: false, code: 0, error: 'Chưa cấu hình webhook URL' };
  }

  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title || 'Báo cáo bán hàng',
        text: text,
        data: meta || null,
        sent_at: new Date().toISOString(),
      }),
    });

    if (!res.ok) {
      return { ok: false, code: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, code: 0 };
  } catch (err) {
    return {
      ok: false,
      code: 0,
      error: err.name === 'AbortError' ? 'Timeout khi gọi webhook' : err.message,
    };
  }
}

// ── Kênh: Zalo OA — công cụ hỗ trợ (lấy user_id, refresh token) ─────────────

/**
 * Lấy danh sách user_id đã tương tác/quan tâm với OA.
 * Endpoint: GET https://openapi.zalo.me/v3.0/oa/user/getlist
 * Yêu cầu app có quyền "Quản lý thông tin người dùng".
 *
 * @param {object} [options]
 * @param {number} [options.offset=0]
 * @param {number} [options.count=50] - tối đa 50/request
 * @param {string} [options.tagName]
 * @returns {Promise<{ok:boolean, code:number, error?:string, users?:Array, total?:number}>}
 */
async function fetchZaloUsers(options = {}) {
  const accessToken = getSetting('zalo_oa_access_token');
  if (!accessToken) {
    return { ok: false, code: 0, error: 'Chưa cấu hình Zalo OA Access Token' };
  }

  const offset = Math.max(0, parseInt(options.offset) || 0);
  const count = Math.min(50, Math.max(1, parseInt(options.count) || 50));

  const data = { offset, count };
  if (options.tagName) data.tag_name = options.tagName;

  try {
    const res = await fetchWithTimeout(
      `https://openapi.zalo.me/v3.0/oa/user/getlist?data=${encodeURIComponent(
        JSON.stringify(data)
      )}`,
      { method: 'GET', headers: { access_token: accessToken } }
    );

    const body = await res.json().catch(() => ({}));

    if (!res.ok || (body.error && body.error !== 0)) {
      const msg =
        body.message || `HTTP ${res.status}${body.error ? ' ' + body.error : ''}`;
      return { ok: false, code: body.error || res.status, error: msg };
    }

    const users = Array.isArray(body.data?.users) ? body.data.users : [];
    return {
      ok: true,
      code: 0,
      users,
      total: body.data?.total || users.length,
    };
  } catch (err) {
    return {
      ok: false,
      code: 0,
      error: err.name === 'AbortError' ? 'Timeout khi lấy danh sách user Zalo' : err.message,
    };
  }
}

/**
 * Làm mới OA Access Token bằng refresh token (OAuth v4).
 * Endpoint: POST https://oauth.zaloapp.com/v4/oa/access_token
 * Body (x-www-form-urlencoded): grant_type=refresh_token&refresh_token&app_id
 * Header: secret_key
 *
 * LƯU Ý: refresh token chỉ dùng được 1 lần, sau đó phải lưu refresh token mới.
 * @returns {Promise<{ok:boolean, error?:string, accessToken?:string, refreshToken?:string}>}
 */
async function refreshZaloToken() {
  const refreshToken = getSetting('zalo_oa_refresh_token');
  const appId = getSetting('zalo_oa_app_id');
  const secretKey = getSetting('zalo_oa_secret_key');

  if (!refreshToken || !appId || !secretKey) {
    return {
      ok: false,
      error:
        'Thiếu cấu hình refresh token. Cần zalo_oa_refresh_token + zalo_oa_app_id + zalo_oa_secret_key',
    };
  }

  try {
    const res = await fetchWithTimeout('https://oauth.zaloapp.com/v4/oa/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        secret_key: secretKey,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        app_id: String(appId),
      }).toString(),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      return {
        ok: false,
        error: body.message || `HTTP ${res.status}`,
      };
    }

    // Lưu token mới (access token hết hạn sau 25h, refresh token sau 3 tháng)
    const db = require('../../database');
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
    );
    if (body.access_token) stmt.run('zalo_oa_access_token', String(body.access_token));
    if (body.refresh_token) {
      stmt.run('zalo_oa_refresh_token', String(body.refresh_token));
    }

    logger.info('[ZALO] Refreshed OA access token', {
      expires_in: body.expires_in || null,
    });

    return {
      ok: true,
      accessToken: body.access_token || null,
      refreshToken: body.refresh_token || null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'AbortError' ? 'Timeout khi refresh token Zalo' : err.message,
    };
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────

const CHANNELS = {
  zalo: { label: 'Zalo OA', send: sendZalo, requiresRecipient: true },
  telegram: { label: 'Telegram Bot', send: sendTelegram, requiresRecipient: true },
  webhook: { label: 'Webhook', send: sendWebhook, requiresRecipient: false },
};

/**
 * Gửi nội dung qua kênh được chỉ định.
 * @param {string} channel - 'zalo' | 'telegram' | 'webhook'
 * @param {string} text - nội dung plain text
 * @param {object} [options] - { title, meta }
 * @returns {Promise<{ok:boolean, code:number, error?:string, channel:string}>}
 */
async function sendVia(channel, text, options = {}) {
  const adapter = CHANNELS[channel];
  if (!adapter) {
    return {
      ok: false,
      code: 0,
      channel: channel || 'unknown',
      error: `Kênh không hỗ trợ: ${channel}`,
    };
  }
  const result = await adapter.send({ text, title: options.title, meta: options.meta });
  return { ...result, channel };
}

/**
 * Lấy danh sách kênh + trạng thái cấu hình (để hiển thị trên UI).
 */
function getChannelStatus() {
  return Object.entries(CHANNELS).map(([key, adapter]) => {
    const configured =
      key === 'zalo'
        ? Boolean(getSetting('zalo_oa_access_token') && getSetting('zalo_report_user_id'))
        : key === 'telegram'
          ? Boolean(getSetting('telegram_bot_token') && getSetting('telegram_report_chat_id'))
          : Boolean(getSetting('report_notify_webhook_url'));

    return {
      key,
      label: adapter.label,
      configured,
      requiresRecipient: adapter.requiresRecipient,
    };
  });
}

/**
 * Gửi báo cáo ngày đã tổng hợp qua kênh.
 * @param {object} report - kết quả DailyReportService.buildDailyReport()
 * @param {string} channel
 */
async function sendReport(report, channel) {
  const text = DailyReportService.formatReportText(report);
  const result = await sendVia(channel, text, {
    title: `${report.distributorName || 'Beer POS'} — ${report.date}`,
    meta: {
      date: report.date,
      revenue: report.today.revenue,
      profit: report.today.profit,
      orders: report.today.orders,
      expense: report.today.expense,
      liters: report.today.liters,
      payment: report.today.payment,
      totalDebt: report.today.totalDebt,
    },
  });

  if (result.ok) {
    logger.info('[REPORT_NOTIFY] Sent daily report', {
      channel,
      date: report.date,
      revenue: report.today.revenue,
    });
  } else {
    logger.error('[REPORT_NOTIFY] Failed to send daily report', {
      channel,
      date: report.date,
      error: result.error,
    });
  }

  return { ...result, text };
}

module.exports = {
  sendVia,
  sendReport,
  getChannelStatus,
  fetchZaloUsers,
  refreshZaloToken,
  CHANNELS,
};
