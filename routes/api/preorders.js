/**
 * API — Đặt hàng trước (Pre-order)
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoints (chỉ ADMIN):
 *   GET    /api/preorders                 → danh sách đơn đặt trước
 *   GET    /api/preorders/scheduled?date= → đơn chờ đẩy cho một ngày
 *   POST   /api/preorders/:id/release     → đẩy ngay (không chờ 07:00)
 *   POST   /api/preorders/:id/cancel      → huỷ đơn đặt trước chưa đẩy
 *   GET    /api/preorders/settings        → giờ đẩy + số đơn chờ
 *   PUT    /api/preorders/settings        → đổi giờ đẩy
 *   POST   /api/preorders/run             → chạy release thủ công (dry-run mặc định)
 */

const express = require('express');
const router = express.Router();
const db = require('../../database');
const logger = require('../../src/utils/logger');
const PreOrderService = require('../../src/services/PreOrderService');
const { requireAdmin } = require('./admin');

// Tất cả endpoint đều yêu cầu ADMIN.
router.use(requireAdmin);

/**
 * Danh sách đơn đặt trước.
 * Query: ?status=SCHEDULED|RELEASED|ALL (mặc định ALL), ?date=YYYY-MM-DD
 */
router.get('/', (req, res) => {
  try {
    const status = String(req.query.status || 'ALL').toUpperCase();
    const date = req.query.date ? PreOrderService.normalizeScheduleDate(req.query.date) : null;
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 200);

    const where = ["s.type = 'sale'", 's.archived = 0', 's.deleted = 0'];
    const params = [];

    if (status === 'SCHEDULED' || status === 'RELEASED') {
      where.push('s.preorder_status = ?');
      params.push(status);
    } else {
      where.push("s.preorder_status IS NOT NULL");
    }

    if (date) {
      where.push('s.preorder_date = ?');
      params.push(date);
    }

    const rows = db
      .prepare(
        `SELECT s.id, s.customer_id, s.date, s.created_on, s.sale_time,
                s.total, s.deliver_kegs, s.preorder_date, s.preorder_status,
                s.preorder_released_at, s.driver_username, s.region_id,
                s.region_name, s.dispatch_status,
                c.name AS customer_name, c.phone AS customer_phone,
                c.address AS customer_address
           FROM sales s
           LEFT JOIN customers c ON c.id = s.customer_id
          WHERE ${where.join(' AND ')}
          ORDER BY s.preorder_date DESC, s.id DESC
          LIMIT ?`
      )
      .all(...params, limit);

    res.json({ success: true, data: rows, count: rows.length });
  } catch (e) {
    logger.error('[api/preorders] list error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/** Đơn chờ đẩy cho một ngày (dùng cho màn "Đơn đặt trước"). */
router.get('/scheduled', (req, res) => {
  try {
    const date = req.query.date
      ? PreOrderService.normalizeScheduleDate(req.query.date)
      : db.getVietnamDateStr();
    if (!date) {
      return res.status(400).json({ success: false, error: 'Ngày không hợp lệ (YYYY-MM-DD)' });
    }
    const rows = PreOrderService.listScheduled({ date, limit: 500 });
    res.json({ success: true, data: rows, count: rows.length, date });
  } catch (e) {
    logger.error('[api/preorders] scheduled error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/** Đẩy ngay 1 đơn (không chờ 07:00). */
router.post('/:id/release', async (req, res) => {
  try {
    const saleId = parseInt(req.params.id, 10);
    if (!Number.isInteger(saleId)) {
      return res.status(400).json({ success: false, error: 'ID đơn không hợp lệ' });
    }
    const result = await PreOrderService.releaseNow(saleId);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('[api/preorders] release error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/** Huỷ đơn đặt trước chưa được đẩy. */
router.post('/:id/cancel', (req, res) => {
  try {
    const saleId = parseInt(req.params.id, 10);
    if (!Number.isInteger(saleId)) {
      return res.status(400).json({ success: false, error: 'ID đơn không hợp lệ' });
    }
    const result = PreOrderService.cancelPreOrder(saleId);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true });
  } catch (e) {
    logger.error('[api/preorders] cancel error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/** Cấu hình: giờ đẩy + số đơn đang chờ. */
router.get('/settings', (req, res) => {
  try {
    const hour = PreOrderService.getReleaseHour();
    const today = db.getVietnamDateStr();
    const waitingToday = PreOrderService.listScheduled({ date: today, limit: 500 }).length;

    // Đếm đơn đang chờ theo từng ngày (7 ngày tới) → cho UI hiển thị lịch.
    const upcoming = db
      .prepare(
        `SELECT preorder_date AS date, COUNT(*) AS count
           FROM sales
          WHERE preorder_status = 'SCHEDULED'
            AND preorder_date >= ?
          GROUP BY preorder_date
          ORDER BY preorder_date ASC
          LIMIT 30`
      )
      .all(today);

    res.json({
      success: true,
      data: { releaseHour: hour, releaseTime: `${String(hour).padStart(2, '0')}:00`, waitingToday, upcoming },
    });
  } catch (e) {
    logger.error('[api/preorders] settings error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/** Đổi giờ đẩy đơn (0-23). */
router.put('/settings', (req, res) => {
  try {
    const result = PreOrderService.setReleaseHour(req.body?.releaseHour);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    logger.info('[api/preorders] release hour changed', { releaseHour: result.hour });
    res.json({ success: true, data: { releaseHour: result.hour } });
  } catch (e) {
    logger.error('[api/preorders] set settings error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/** Chạy release thủ công (dry-run mặc định — truyền { dryRun: false } để thực thi). */
router.post('/run', async (req, res) => {
  try {
    const dryRun = req.body?.dryRun !== false;
    const date = req.body?.date ? PreOrderService.normalizeScheduleDate(req.body.date) : db.getVietnamDateStr();
    const result = await PreOrderService.releaseDuePreOrders({ date, dryRun });
    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('[api/preorders] run error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
