/**
 * Report Notify Orchestrator — Điều phối gửi báo cáo tự động.
 * ─────────────────────────────────────────────────────────────────────────────
 * Trách nhiệm:
 *  1. Đọc cấu hình từ bảng `settings` (bật/tắt, kênh, giờ gửi).
 *  2. Dựng báo cáo ngày (DailyReportService) + render text.
 *  3. Gửi qua kênh (NotificationService).
 *  4. Ghi lịch sử vào bảng `report_notifications`.
 *  5. Chống gửi trùng cùng ngày (idempotent) — trừ khi gửi thủ công.
 */

const db = require('../../database');
const logger = require('../utils/logger');
const DailyReportService = require('./DailyReportService');
const NotificationService = require('./NotificationService');

// ── Cấu hình ─────────────────────────────────────────────────────────────────

/** Đọc toàn bộ setting liên quan dưới dạng object. */
function getConfig() {
  const keys = [
    'report_notify_enabled',
    'report_notify_channel',
    'report_notify_time',
    'report_notify_title',
    'zalo_oa_access_token',
    'zalo_report_user_id',
    'telegram_bot_token',
    'telegram_report_chat_id',
    'report_notify_webhook_url',
  ];
  const out = {};
  for (const key of keys) {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      out[key] = row ? String(row.value ?? '') : '';
    } catch (_) {
      out[key] = '';
    }
  }
  return out;
}

/** Tự động có bật không. */
function isEnabled() {
  return getConfig().report_notify_enabled === '1';
}

/** Kênh đang cấu hình. */
function getChannel() {
  const ch = getConfig().report_notify_channel || 'zalo';
  return NotificationService.CHANNELS[ch] ? ch : 'zalo';
}

/**
 * Đã gửi thành công báo cáo của ngày này chưa?
 * @param {string} dateStr
 * @param {string} [channel]
 */
function hasSent(dateStr, channel) {
  try {
    const row = channel
      ? db
          .prepare(
            `SELECT id FROM report_notifications
             WHERE report_date = ? AND channel = ? AND status = 'sent' LIMIT 1`
          )
          .get(dateStr, channel)
      : db
          .prepare(
            `SELECT id FROM report_notifications
             WHERE report_date = ? AND status = 'sent' LIMIT 1`
          )
          .get(dateStr);
    return Boolean(row);
  } catch (_) {
    return false;
  }
}

/** Ghi lịch sử gửi. */
function logNotification({
  reportDate,
  channel,
  recipient,
  title,
  summary,
  payload,
  status,
  responseCode,
  errorMessage,
}) {
  try {
    db.prepare(
      `INSERT INTO report_notifications
       (report_date, channel, recipient, title, summary, payload, status, response_code, error_message, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      reportDate,
      channel,
      recipient || null,
      title || null,
      summary || null,
      payload ? JSON.stringify(payload) : null,
      status,
      responseCode || null,
      errorMessage || null,
      status === 'sent' ? new Date().toISOString() : null
    );
  } catch (err) {
    logger.error('[REPORT_NOTIFY] Failed to write notification log', {
      error: err.message,
    });
  }
}

/** Lấy recipient hiển thị theo kênh (để ghi log). */
function resolveRecipient(channel) {
  const cfg = getConfig();
  if (channel === 'zalo') return cfg.zalo_report_user_id;
  if (channel === 'telegram') return cfg.telegram_report_chat_id;
  return cfg.report_notify_webhook_url;
}

// ── Gửi ──────────────────────────────────────────────────────────────────────

/**
 * Gửi báo cáo cho một ngày.
 * @param {object} options
 * @param {string} [options.date] - YYYY-MM-DD, mặc định hôm nay
 * @param {string} [options.channel] - ghi đè kênh
 * @param {boolean} [options.force] - bỏ qua kiểm tra trùng & cờ enabled
 * @param {boolean} [options.dryRun] - chỉ dựng nội dung, KHÔNG gửi
 * @returns {Promise<object>}
 */
async function dispatchDailyReport(options = {}) {
  const date = options.date || DailyReportService.todayVN();
  const channel = options.channel || getChannel();
  const force = Boolean(options.force);
  const dryRun = Boolean(options.dryRun);

  if (!force && !isEnabled()) {
    return {
      ok: false,
      skipped: true,
      reason: 'Báo cáo tự động đang tắt (report_notify_enabled = 0)',
      date,
      channel,
    };
  }

  if (!force && !dryRun && hasSent(date, channel)) {
    return {
      ok: false,
      skipped: true,
      reason: `Đã gửi báo cáo ngày ${date} qua ${channel}`,
      date,
      channel,
    };
  }

  let report;
  let text;
  try {
    report = DailyReportService.buildDailyReport(date);
    text = DailyReportService.formatReportText(report);
  } catch (err) {
    logger.error('[REPORT_NOTIFY] Failed to build report', {
      date,
      error: err.message,
    });
    logNotification({
      reportDate: date,
      channel,
      status: 'failed',
      errorMessage: `Build report failed: ${err.message}`,
    });
    return { ok: false, error: `Không dựng được báo cáo: ${err.message}`, date, channel };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      date,
      channel,
      text,
      report,
    };
  }

  const result = await NotificationService.sendReport(report, channel);

  logNotification({
    reportDate: date,
    channel,
    recipient: resolveRecipient(channel),
    title: `${report.distributorName || 'Beer POS'} — ${date}`,
    summary: `Doanh thu ${DailyReportService.formatVND(report.today.revenue)} · ${report.today.orders} đơn`,
    payload: {
      revenue: report.today.revenue,
      profit: report.today.profit,
      orders: report.today.orders,
      expense: report.today.expense,
      liters: report.today.liters,
      payment: report.today.payment,
      totalDebt: report.today.totalDebt,
      netKegs: report.today.netKegs,
    },
    status: result.ok ? 'sent' : 'failed',
    responseCode: result.code,
    errorMessage: result.ok ? null : result.error,
  });

  return {
    ok: result.ok,
    date,
    channel,
    error: result.error || null,
    text,
    report,
  };
}

/**
 * Có nên gửi báo cáo NGAY BÂY GIỜ không?
 *
 * Cron chạy mỗi phút. Hàm này kiểm tra:
 *  1. Tính năng đã bật chưa (`report_notify_enabled`).
 *  2. Giờ hiện tại (giờ VN) có khớp `report_notify_time` không.
 *
 * Tách riêng khỏi `runScheduledDailyReport()` để test được logic thời gian
 * mà không phải chờ cron thật.
 *
 * @param {Date} [now] - thời điểm hiện tại (mặc định Date.now())
 * @returns {boolean}
 */
function shouldRunNow(now) {
  if (!isEnabled()) return false;

  const cfg = getConfig();
  const target = String(cfg.report_notify_time || '21:30');
  const match = target.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return false;

  const targetH = match[1];
  const targetM = match[2];

  // Giờ hiện tại theo Asia/Ho_Chi_Minh (UTC+7)
  const base = now instanceof Date ? now : new Date();
  const vn = new Date(base.getTime() + 7 * 60 * 60 * 1000);
  const curH = String(vn.getUTCHours()).padStart(2, '0');
  const curM = String(vn.getUTCMinutes()).padStart(2, '0');

  return curH === targetH && curM === targetM;
}

/**
 * Cron entry — chạy mỗi tối, tự gửi nếu bật.
 * @returns {Promise<object>}
 */
async function runScheduledDailyReport() {
  const date = DailyReportService.todayVN();
  const cfg = getConfig();

  if (cfg.report_notify_enabled !== '1') {
    logger.info('[REPORT_NOTIFY] Scheduled job skipped (disabled)');
    return { ok: true, skipped: true, reason: 'disabled', date };
  }

  const channel = getChannel();
  logger.info('[REPORT_NOTIFY] Scheduled daily report', { date, channel });

  const result = await dispatchDailyReport({ date, channel });
  if (!result.ok && !result.skipped) {
    logger.error('[REPORT_NOTIFY] Scheduled daily report failed', {
      date,
      channel,
      error: result.error,
    });
  }
  return result;
}

/**
 * Lịch sử gửi (cho UI).
 * @param {number} [limit]
 */
function getHistory(limit = 30) {
  try {
    return db
      .prepare(
        `SELECT id, report_date, channel, recipient, title, summary, status,
                response_code, error_message, sent_at, created_at
         FROM report_notifications
         ORDER BY id DESC LIMIT ?`
      )
      .all(Math.min(200, Math.max(1, parseInt(limit) || 30)));
  } catch (err) {
    logger.error('[REPORT_NOTIFY] Failed to load history', { error: err.message });
    return [];
  }
}

module.exports = {
  dispatchDailyReport,
  runScheduledDailyReport,
  shouldRunNow,
  getConfig,
  isEnabled,
  getChannel,
  hasSent,
  getHistory,
  logNotification,
};
