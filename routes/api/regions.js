/**
 * Admin API — Quản lý khu vực giao hàng & phân công tài xế
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount tại /api/admin/regions — CHỈ ADMIN.
 *
 * Endpoint:
 *  GET    /api/admin/regions                    → danh mục khu vực + tài xế + SL khách
 *  GET    /api/admin/regions/stats              → thống kê khách / đơn / lít theo khu vực
 *  GET    /api/admin/regions/history            → lịch sử phân công (toàn bộ)
 *  GET    /api/admin/regions/:id/history        → lịch sử phân công của 1 khu vực
 *  POST   /api/admin/regions/:id/assign         → gán / thay đổi tài xế
 *  DELETE /api/admin/regions/:id/assign         → ngừng phân công
 *
 * Bảo mật:
 *  - requireAdmin (role = ADMIN). Driver bị chặn 403 từ apiGuard.
 *  - Driver KHÔNG tự ý đổi khu vực phụ trách (đã chặn ở tầng API).
 */

const express = require('express');
const router = express.Router();
const logger = require('../../src/utils/logger');
const db = require('../../database');
const RegionService = require('../../src/services/RegionService');
const { requireAdmin } = require('./admin');

// ═══════════════════════════════════════════════════════════════════════════
// DANH MỤC KHU VỰC + PHÂN CÔNG
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/admin/regions — danh sách khu vực + tài xế phụ trách + số khách
router.get('/', requireAdmin, (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
    const regions = RegionService.listAssignments().filter((r) => includeInactive || r.active);

    // Danh sách tài xế (để UI chọn) — driver_staff + app_users(role=DRIVER).
    const drivers = [];
    try {
      const rows = db
        .prepare(
          `SELECT ds.id, ds.username, ds.full_name, ds.phone, ds.active,
                  au.active AS account_active
           FROM driver_staff ds
           LEFT JOIN app_users au ON au.id = ds.app_user_id
           ORDER BY ds.active DESC, ds.full_name, ds.username`
        )
        .all();
      for (const r of rows) {
        drivers.push({
          id: r.id,
          username: r.username,
          fullName: r.full_name || r.username,
          phone: r.phone,
          active: !!r.active && r.account_active !== 0,
        });
      }
    } catch (_) { /* bảng driver_staff có thể chưa có — trả mảng rỗng */ }

    // Tài xế có tài khoản DRIVER nhưng chưa có hồ sơ driver_staff
    try {
      const accounts = db
        .prepare(
          `SELECT username, full_name, phone, active FROM app_users
           WHERE role = 'DRIVER' AND username NOT IN (SELECT username FROM driver_staff)
           ORDER BY full_name, username`
        )
        .all();
      for (const a of accounts) {
        drivers.push({
          id: null,
          username: a.username,
          fullName: a.full_name || a.username,
          phone: a.phone,
          active: !!a.active,
        });
      }
    } catch (_) { /* ignore */ }

    // ── Chống chồng chéo khu vực ──────────────────────────────────────
    // Mỗi khu vực chỉ có 1 tài xế chính. Gửi kèm cho mỗi tài xế:
    //  - regionIds      : khu vực đang phụ trách.
    //  - takenRegionIds : khu vực đang do TÀI XẾ KHÁC phụ trách (UI khoá chọn).
    let overlapInfo = {};
    try {
      const list = RegionService.listDriversWithRegions();
      overlapInfo = list.reduce((acc, d) => {
        acc[d.username] = { regionIds: d.regionIds, takenRegionIds: d.takenRegionIds };
        return acc;
      }, {});
    } catch (e) {
      logger.error('[admin/regions] overlap info error', { error: e.message });
    }

    for (const d of drivers) {
      const info = overlapInfo[d.username] || {};
      d.regionIds = info.regionIds || [];
      d.takenRegionIds = info.takenRegionIds || [];
    }

    res.json({ success: true, regions, drivers });
  } catch (err) {
    logger.error('[admin/regions] list error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải danh sách khu vực' });
  }
});

// GET /api/admin/regions/stats — thống kê theo khu vực
router.get('/stats', requireAdmin, (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year, 10) : null;
    const month = req.query.month ? parseInt(req.query.month, 10) : null;
    const stats = RegionService.getStats({ year, month });
    res.json({ success: true, stats, year, month });
  } catch (err) {
    logger.error('[admin/regions] stats error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải thống kê khu vực' });
  }
});

// GET /api/admin/regions/history — lịch sử phân công toàn bộ
router.get('/history', requireAdmin, (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
    res.json({ success: true, history: RegionService.listHistory(limit) });
  } catch (err) {
    logger.error('[admin/regions] history error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải lịch sử phân công' });
  }
});

// GET /api/admin/regions/:id/history — lịch sử phân công 1 khu vực
router.get('/:id/history', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Khu vực không hợp lệ' });
    res.json({ success: true, history: RegionService.getHistory(id, req.query.limit) });
  } catch (err) {
    logger.error('[admin/regions] region history error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải lịch sử phân công' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ĐIỀU PHỐI ĐƠN HÀNG
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/admin/regions/dispatch/unassigned — đơn chờ điều phối (chưa có tài xế)
router.get('/dispatch/unassigned', requireAdmin, (req, res) => {
  try {
    const sales = RegionService.listUnassignedSales({
      date: req.query.date || null,
      limit: req.query.limit,
    });
    res.json({ success: true, sales, count: sales.length });
  } catch (err) {
    logger.error('[admin/regions] unassigned list error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải danh sách đơn chờ điều phối' });
  }
});

// POST /api/admin/regions/dispatch/:saleId/assign — gán / chuyển tài xế cho đơn
router.post('/dispatch/:saleId/assign', requireAdmin, (req, res) => {
  try {
    const saleId = parseInt(req.params.saleId, 10);
    if (!saleId) return res.status(400).json({ error: 'Đơn hàng không hợp lệ' });

    const driverUsername = req.body?.driverUsername || null;

    // Gán cho tài xế → dùng chung cơ chế "đảm nhận" để các đơn chờ điều phố
    // CÙNG KHU VỰC (chưa giao) cũng chuyển cho tài xế đó.
    let result;
    if (driverUsername) {
      result = RegionService.claimUnassignedSale(saleId, driverUsername, {
        actor: req.user?.username || null,
        req,
        note: req.body?.note || null,
        skipRegionCheck: true,
      });
      // Đơn đã có tài xế khác → fallback sang gán trực tiếp (Admin có quyền).
      if (!result.success && result.error === 'Đơn này đã được gán cho tài xế khác') {
        result = RegionService.assignSaleDriver(saleId, driverUsername, {
          actor: req.user?.username || null,
          req,
          note: req.body?.note || null,
        });
      }
    } else {
      result = RegionService.assignSaleDriver(saleId, null, {
        actor: req.user?.username || null,
        req,
        note: req.body?.note || null,
      });
    }

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    // Đồng bộ phiếu giao + thông báo cho tài xế mới (nếu có)
    // ⚠️ `claimUnassignedSale` đã tự sync + notify → chỉ sync lại khi dùng
    //    đường `assignSaleDriver` (gán trực tiếp / bỏ gán).
    const assignedDriver = result.driverUsername || null;
    if (assignedDriver && result.transferred === undefined) {
      try {
        RegionService.syncDeliveryAndNotify([saleId], assignedDriver);
      } catch (e) {
        logger.error('[admin/regions] notify driver error', { error: e.message });
      }
    }

    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[admin/regions] dispatch assign error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi điều phối đơn hàng' });
  }
});

// POST /api/admin/regions/:id/assign — gán / thay đổi tài xế
router.post('/:id/assign', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Khu vực không hợp lệ' });

    const driverUsername = req.body?.driverUsername || null;
    const result = RegionService.assignDriver(id, driverUsername, {
      note: req.body?.note || null,
      actor: req.user?.username || null,
      req,
      // Admin xác nhận thu hồi khu vực đang có tài xế khác phụ trách.
      confirmTakeover: req.body?.confirmTakeover === true,
    });

    if (!result.success) {
      return res.status(400).json({
        error: result.error,
        requiresConfirm: !!result.requiresConfirm,
        code: result.code || null,
        currentDriver: result.currentDriver || null,
        currentDriverName: result.currentDriverName || null,
      });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[admin/regions] assign error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi phân công tài xế' });
  }
});

// DELETE /api/admin/regions/:id/assign — ngừng phân công
router.delete('/:id/assign', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Khu vực không hợp lệ' });

    const result = RegionService.unassignDriver(id, {
      note: req.body?.note || req.query.note || null,
      actor: req.user?.username || null,
      req,
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[admin/regions] unassign error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi ngừng phân công tài xế' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ĐIỀU PHỐI ĐƠN HÀNG
// ═══════════════════════════════════════════════════════════════════════════

module.exports = router;
module.exports.requireAdmin = requireAdmin;
