/**
 * Admin API — Quản lý hồ sơ tài xế & lương tháng
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount tại /api/admin/driver-staff — CHỈ ADMIN.
 *
 * Phân biệt với /api/admin/drivers (nhóm tài khoản đăng nhập):
 *  - /api/admin/drivers     → quản lý TÀI KHOẢN (app_users) cho Driver Portal
 *  - /api/admin/driver-staff→ quản lý HỒ SƠ tài xế + LƯƠNG CỨNG theo tháng
 *
 * Bảo mật:
 *  - requireAdmin (role = ADMIN). Driver bị chặn 403 từ apiGuard trước khi
 *    tới route này, vì /api/admin* không nằm trong whitelist DRIVER.
 *  - Response KHÔNG bao giờ chứa password_hash.
 */

const express = require('express');
const router = express.Router();
const logger = require('../../src/utils/logger');
const DriverStaffService = require('../../src/services/DriverStaffService');
const { requireAdmin } = require('./admin');

// ── Helper: parse year/month an toàn ────────────────────────────────────────
function parsePeriod(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (!y || y < 2000 || y > 2100) return null;
  if (!m || m < 1 || m > 12) return null;
  return { year: y, month: m };
}

// ═══════════════════════════════════════════════════════════════════════════
// HỒ SƠ TÀI XẾ
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/admin/driver-staff — danh sách tài xế
router.get('/', requireAdmin, (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
    const drivers = DriverStaffService.getAll({ includeInactive });
    res.json({ success: true, data: drivers, total: drivers.length });
  } catch (err) {
    logger.error('[admin/driver-staff] list error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải danh sách tài xế' });
  }
});

// GET /api/admin/driver-staff/salary/summary?year=&month= — bảng lương tháng
// PHẢI đặt TRƯỚC '/:id' để không bị route generic bắt trước.
router.get('/salary/summary', requireAdmin, (req, res) => {
  try {
    const now = new Date();
    const period = parsePeriod(
      req.query.year || now.getFullYear(),
      req.query.month || now.getMonth() + 1
    );
    if (!period) return res.status(400).json({ error: 'Kỳ lương không hợp lệ' });

    const data = DriverStaffService.getMonthlySalarySummary(period.year, period.month);
    res.json({ success: true, data, year: period.year, month: period.month });
  } catch (err) {
    logger.error('[admin/driver-staff] salary summary error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải bảng lương tài xế' });
  }
});

// GET /api/admin/driver-staff/:id
router.get('/:id', requireAdmin, (req, res) => {
  try {
    const driver = DriverStaffService.getById(parseInt(req.params.id));
    if (!driver) return res.status(404).json({ error: 'Không tìm thấy tài xế' });
    res.json({ success: true, data: driver });
  } catch (err) {
    logger.error('[admin/driver-staff] detail error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải thông tin tài xế' });
  }
});

// POST /api/admin/driver-staff — tạo tài xế (+ tài khoản đăng nhập nếu chưa có)
router.post('/', requireAdmin, (req, res) => {
  try {
    const {
      username,
      password,
      fullName,
      phone,
      monthlySalary,
      bankAccount,
      note,
      startDate,
      mustChangePassword,
    } = req.body || {};

    if (!username) {
      return res.status(400).json({ error: 'Thiếu tên đăng nhập của tài xế' });
    }

    const result = DriverStaffService.create({
      username,
      password,
      fullName,
      phone,
      monthlySalary,
      bankAccount,
      note,
      startDate,
      mustChangePassword,
    });

    if (!result.success) return res.status(400).json({ error: result.error });

    logger.info('[admin/driver-staff] created', { username: result.username });
    res.status(201).json({
      success: true,
      id: result.id,
      username: result.username,
      accountCreated: result.accountCreated,
    });
  } catch (err) {
    logger.error('[admin/driver-staff] create error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tạo tài xế' });
  }
});

// PUT /api/admin/driver-staff/:id — cập nhật hồ sơ / lương cố định / đổi mật khẩu
router.put('/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = DriverStaffService.update(id, req.body || {});
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true, id });
  } catch (err) {
    logger.error('[admin/driver-staff] update error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật tài xế' });
  }
});

// DELETE /api/admin/driver-staff/:id — khoá tài xế (soft delete)
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = DriverStaffService.remove(id);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  } catch (err) {
    logger.error('[admin/driver-staff] delete error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi khoá tài xế' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LƯƠNG THÁNG
// ═══════════════════════════════════════════════════════════════════════════

// PUT /api/admin/driver-staff/:id/salary — thiết lập lương 1 tài xế cho 1 tháng
router.put('/:id/salary', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const period = parsePeriod(req.body?.year, req.body?.month);
    if (!period) return res.status(400).json({ error: 'Kỳ lương không hợp lệ' });

    const result = DriverStaffService.setMonthlySalary(id, period.year, period.month, {
      baseSalary: req.body?.baseSalary,
      bonus: req.body?.bonus,
      deduction: req.body?.deduction,
      workDays: req.body?.workDays,
      note: req.body?.note,
      status: req.body?.status,
    });
    if (!result.success) return res.status(400).json({ error: result.error });

    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('[admin/driver-staff] set salary error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi thiết lập lương tài xế' });
  }
});

// POST /api/admin/driver-staff/:id/salary/paid — đánh dấu đã trả / huỷ trả
router.post('/:id/salary/paid', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const period = parsePeriod(req.body?.year, req.body?.month);
    if (!period) return res.status(400).json({ error: 'Kỳ lương không hợp lệ' });

    const paid = req.body?.paid !== false;
    const result = DriverStaffService.markSalaryPaid(id, period.year, period.month, paid);
    if (!result.success) return res.status(400).json({ error: result.error });

    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('[admin/driver-staff] mark paid error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật trạng thái trả lương' });
  }
});

// GET /api/admin/driver-staff/:id/salary-history — lịch sử lương
router.get('/:id/salary-history', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const limit = Math.min(60, Math.max(1, parseInt(req.query.limit) || 24));
    const history = DriverStaffService.getSalaryHistory(id, limit);
    res.json({ success: true, data: history });
  } catch (err) {
    logger.error('[admin/driver-staff] salary history error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải lịch sử lương' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ỨNG LƯƠNG TÀI XẾ
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/admin/driver-staff/:id/advances?year=&month= — danh sách khoản ứng
router.get('/:id/advances', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const period = parsePeriod(
      req.query.year || new Date().getFullYear(),
      req.query.month || new Date().getMonth() + 1
    );
    if (!period) return res.status(400).json({ error: 'Kỳ lương không hợp lệ' });

    const advances = DriverStaffService.getAdvances(id, period.year, period.month);
    const total = DriverStaffService.getAdvanceTotal(id, period.year, period.month);
    res.json({ success: true, data: advances, total, year: period.year, month: period.month });
  } catch (err) {
    logger.error('[admin/driver-staff] list advances error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải danh sách ứng lương' });
  }
});

// POST /api/admin/driver-staff/:id/advances — ghi nhận khoản ứng lương
router.post('/:id/advances', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const period = parsePeriod(req.body?.year, req.body?.month);
    if (!period) return res.status(400).json({ error: 'Kỳ lương không hợp lệ' });

    const result = DriverStaffService.createAdvance(id, period.year, period.month, {
      amount: req.body?.amount,
      method: req.body?.method,
      note: req.body?.note,
      createdBy: req.user?.username || null,
    });
    if (!result.success) return res.status(400).json({ error: result.error });

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    logger.error('[admin/driver-staff] create advance error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi ghi nhận ứng lương' });
  }
});

// DELETE /api/admin/driver-staff/advances/:advanceId — huỷ khoản ứng
router.delete('/advances/:advanceId', requireAdmin, (req, res) => {
  try {
    const advanceId = parseInt(req.params.advanceId);
    const result = DriverStaffService.cancelAdvance(advanceId);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  } catch (err) {
    logger.error('[admin/driver-staff] cancel advance error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi huỷ khoản ứng' });
  }
});

module.exports = router;
