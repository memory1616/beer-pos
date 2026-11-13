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
// Tài liệu: https://openapi.zalo.me/v2.0/oa/message/cs
// Yêu cầu:
//   - OA Access Token (lấy ở openapi.zalo.me → OA quản lý → Access Token)
//   - user_id của người nhận (người đã chat với OA để nhận user_id)
async function sendZalo({ text }) {
  const accessToken = getSetting('zalo_oa_access_token');
  const userId = getSetting('zalo_report_user_id');

  if (!accessToken) {
    return { ok: false, code: 0, error: 'Chưa cấu hình Zalo OA Access Token' };
  }
  if (!userId) {
    return { ok: false, code: 0, error: 'Chưa cấu hình user_id người nhận Zalo' };
  }

  try {
    const res = await fetchWithTimeout('https://openapi.zalo.me/v2.0/oa/message/cs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        access_token: accessToken,
      },
      body: JSON.stringify({
        user_id: String(userId),
        message: { text: text },
      }),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok || body.error) {
      const msg =
        body.message || `HTTP ${res.status}${body.error ? ' ' + body.error : ''}`;
      return { ok: false, code: body.code || res.status, error: msg };
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
  CHANNELS,
};
