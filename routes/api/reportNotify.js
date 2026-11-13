/**
 * Report Notify API — Cấu hình & điều khiển gửi báo cáo tự động.
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount tại /api/report-notify — CHỈ ADMIN.
 *
 * Endpoint:
 *  GET  /api/report-notify/config      — đọc cấu hình + trạng thái kênh
 *  POST /api/report-notify/config      — lưu cấu hình (bật/tắt, kênh, giờ)
 *  POST /api/report-notify/preview     — dựng nội dung báo cáo (không gửi)
 *  POST /api/report-notify/send        — gửi ngay (force = true)
 *  GET  /api/report-notify/history     — lịch sử gửi
 */

const express = require('express');
const router = express.Router();
const logger = require('../../src/utils/logger');
const DailyReportService = require('../../src/services/DailyReportService');
const NotificationService = require('../../src/services/NotificationService');
const ReportNotifyService = require('../../src/services/ReportNotifyService');
const ZaloOAuthService = require('../../src/services/ZaloOAuthService');
const { ROLE_ADMIN } = require('../../middleware/permissions');

// ── Chỉ ADMIN ───────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }
  if (req.user.role !== ROLE_ADMIN) {
    return res.status(403).json({
      error: 'Chỉ quản trị viên mới được cấu hình báo cáo tự động',
      code: 'ADMIN_ONLY',
    });
  }
  next();
}

// ── GET /config ──────────────────────────────────────────────────────────────
router.get('/config', requireAdmin, (req, res) => {
  try {
    const cfg = ReportNotifyService.getConfig();

    // KHÔNG trả về token ra ngoài — chỉ trả về trạng thái đã cấu hình hay chưa.
    res.json({
      enabled: cfg.report_notify_enabled === '1',
      channel: ReportNotifyService.getChannel(),
      time: cfg.report_notify_time || '21:30',
      title: cfg.report_notify_title || 'Báo cáo bán hàng',
      channels: NotificationService.getChannelStatus(),
      recipients: {
        zalo: cfg.zalo_report_user_id || '',
        telegram: cfg.telegram_report_chat_id || '',
        webhook: cfg.report_notify_webhook_url || '',
      },
      hasToken: {
        zalo: Boolean(cfg.zalo_oa_access_token),
        telegram: Boolean(cfg.telegram_bot_token),
      },
      // OAuth v4 (nâng cao) — không trả secret, chỉ trả trạng thái
      zaloAppId: cfg.zalo_oa_app_id || '',
      hasZaloSecret: Boolean(cfg.zalo_oa_secret_key),
      hasZaloRefresh: Boolean(cfg.zalo_oa_refresh_token),
    });
  } catch (err) {
    logger.error('[REPORT_NOTIFY] config error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải cấu hình báo cáo' });
  }
});

// ── POST /config ─────────────────────────────────────────────────────────────
router.post('/config', requireAdmin, (req, res) => {
  try {
    const body = req.body || {};

    const allowed = new Set([
      'report_notify_enabled',
      'report_notify_channel',
      'report_notify_time',
      'report_notify_title',
      'zalo_oa_access_token',
      'zalo_oa_refresh_token',
      'zalo_oa_app_id',
      'zalo_oa_secret_key',
      'zalo_oa_code_verifier',
      'zalo_report_user_id',
      'telegram_bot_token',
      'telegram_report_chat_id',
      'report_notify_webhook_url',
    ]);

    // Chuẩn hoá boolean → '0'/'1'
    if (body.report_notify_enabled !== undefined) {
      body.report_notify_enabled =
        body.report_notify_enabled === true ||
        body.report_notify_enabled === '1' ||
        body.report_notify_enabled === 1
          ? '1'
          : '0';
    }

    // Validate giờ gửi (HH:mm)
    if (body.report_notify_time !== undefined) {
      const t = String(body.report_notify_time).trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) {
        return res.status(400).json({ error: 'Giờ gửi không hợp lệ (phải là HH:mm)' });
      }
      body.report_notify_time = t;
    }

    // Validate kênh
    if (body.report_notify_channel !== undefined) {
      const ch = String(body.report_notify_channel).trim().toLowerCase();
      if (!NotificationService.CHANNELS[ch]) {
        return res.status(400).json({
          error: `Kênh không hợp lệ. Hỗ trợ: ${Object.keys(NotificationService.CHANNELS).join(', ')}`,
        });
      }
      body.report_notify_channel = ch;
    }

    const stmt = require('../../database').prepare(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
    );

    const applied = {};
    Object.entries(body).forEach(([key, value]) => {
      if (!allowed.has(key)) return;
      // Cho phép xoá token (chuỗi rỗng) → set rỗng
      const v = value === null || value === undefined ? '' : String(value);
      stmt.run(key, v);
      applied[key] = v;
    });

    if (Object.keys(applied).length === 0) {
      return res.status(400).json({ error: 'Không có cấu hình hợp lệ' });
    }

    logger.info('[REPORT_NOTIFY] Config updated', {
      keys: Object.keys(applied),
      user: req.user.username,
    });

    res.json({ success: true, updated: Object.keys(applied) });
  } catch (err) {
    logger.error('[REPORT_NOTIFY] config save error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi lưu cấu hình báo cáo' });
  }
});

// ── POST /preview ────────────────────────────────────────────────────────────
router.post('/preview', requireAdmin, (req, res) => {
  try {
    const date = req.body?.date || DailyReportService.todayVN();
    const report = DailyReportService.buildDailyReport(date);
    res.json({
      success: true,
      date,
      text: DailyReportService.formatReportText(report),
      report,
    });
  } catch (err) {
    logger.error('[REPORT_NOTIFY] preview error', { error: err.message });
    res.status(500).json({ error: 'Không dựng được báo cáo: ' + err.message });
  }
});

// ── POST /send ───────────────────────────────────────────────────────────────
router.post('/send', requireAdmin, async (req, res) => {
  try {
    const date = req.body?.date || DailyReportService.todayVN();
    const channel = req.body?.channel || ReportNotifyService.getChannel();
    const dryRun = req.body?.dryRun === true;

    const result = await ReportNotifyService.dispatchDailyReport({
      date,
      channel,
      force: true,
      dryRun,
    });

    if (result.ok) {
      res.json({
        success: true,
        dryRun: Boolean(result.dryRun),
        date,
        channel,
        text: result.text,
      });
    } else {
      res.status(502).json({
        success: false,
        error: result.error || 'Gửi báo cáo thất bại',
        date,
        channel,
      });
    }
  } catch (err) {
    logger.error('[REPORT_NOTIFY] send error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi gửi báo cáo: ' + err.message });
  }
});

// ── GET /zalo/authorize-url ──────────────────────────────────────────────────
// Tạo URL cấp quyền Zalo OAuth v4 (PKCE) để admin OA mở và đồng ý.
router.get('/zalo/authorize-url', requireAdmin, (req, res) => {
  try {
    const redirectUri =
      req.query.redirect_uri ||
      `${req.protocol}://${req.get('host')}/api/report-notify/zalo/callback`;

    const result = ZaloOAuthService.buildAuthorizeUrl(redirectUri);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true, url: result.url });
  } catch (err) {
    logger.error('[REPORT_NOTIFY] zalo authorize url error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tạo URL cấp quyền Zalo' });
  }
});

// ── GET /zalo/callback ───────────────────────────────────────────────────────
// Callback của Zalo: redirect về kèm ?code=<AUTHORIZATION_CODE>&oa_id=...
// Đổi code lấy access_token + refresh_token, lưu vào DB.
router.get('/zalo/callback', async (req, res) => {
  try {
    const { code, error: zaloError, error_description: errorDesc } = req.query;

    if (zaloError) {
      return res
        .status(400)
        .send(
          `<h3 style="font-family:sans-serif">❌ Zalo từ chối cấp quyền</h3><p>${
            errorDesc || zaloError
          }</p><p><a href="/report-notify">← Quay lại cấu hình</a></p>`
        );
    }

    if (!code) {
      return res
        .status(400)
        .send(
          '<h3 style="font-family:sans-serif">❌ Thiếu authorization code</h3><p><a href="/report-notify">← Quay lại cấu hình</a></p>'
        );
    }

    const result = await ZaloOAuthService.exchangeCodeForToken(code);

    if (!result.ok) {
      return res
        .status(400)
        .send(
          `<h3 style="font-family:sans-serif">❌ Không đổi được token</h3><p>${result.error}</p><p><a href="/report-notify">← Quay lại cấu hình</a></p>`
        );
    }

    res.send(
      `<h3 style="font-family:sans-serif">✅ Đã cấu hình Zalo OA thành công!</h3>` +
        '<p>Access token đã được lưu. Hệ thống sẽ tự làm mới token mỗi ngày lúc 03:00.</p>' +
        '<p><a href="/report-notify">← Quay lại cấu hình báo cáo</a></p>'
    );
  } catch (err) {
    logger.error('[REPORT_NOTIFY] zalo callback error', { error: err.message });
    res.status(500).send(
      '<h3 style="font-family:sans-serif">❌ Lỗi callback</h3><p><a href="/report-notify">← Quay lại cấu hình</a></p>'
    );
  }
});

// ── GET /zalo/users ──────────────────────────────────────────────────────────
// Lấy danh sách user_id đã tương tác với OA — giúp admin chọn đúng người nhận.
router.get('/zalo/users', requireAdmin, async (req, res) => {
  try {
    const result = await NotificationService.fetchZaloUsers({
      offset: req.query.offset,
      count: req.query.count,
      tagName: req.query.tag_name,
    });

    if (!result.ok) {
      return res.status(502).json({
        success: false,
        error: result.error || 'Không lấy được danh sách user Zalo',
        code: result.code,
      });
    }

    res.json({
      success: true,
      users: result.users,
      total: result.total,
    });
  } catch (err) {
    logger.error('[REPORT_NOTIFY] zalo users error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi lấy danh sách user Zalo' });
  }
});

// ── POST /zalo/refresh-token ────────────────────────────────────────────────
// Làm mới OA Access Token (access token hết hạn sau 25 giờ).
router.post('/zalo/refresh-token', requireAdmin, async (req, res) => {
  try {
    const result = await NotificationService.refreshZaloToken();
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('[REPORT_NOTIFY] zalo refresh token error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi làm mới token Zalo' });
  }
});

// ── GET /history ─────────────────────────────────────────────────────────────
router.get('/history', requireAdmin, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    res.json({ success: true, history: ReportNotifyService.getHistory(limit) });
  } catch (err) {
    logger.error('[REPORT_NOTIFY] history error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải lịch sử gửi báo cáo' });
  }
});

module.exports = router;
