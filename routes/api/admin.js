/**
 * Admin API — Quản lý tài khoản tài xế (Driver Portal)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount tại /api/admin/drivers — CHỈ ADMIN được truy cập.
 *
 * Bảo mật:
 *  - requireAuth + role = ADMIN (driver bị chặn 403 từ apiGuard trước khi
 *    tới route này, vì /api/admin* không nằm trong whitelist DRIVER).
 *  - Response KHÔNG bao giờ chứa password_hash.
 *  - Driver KHÔNG thể tự tạo/tự nâng quyền — mọi thao tác đi qua đây.
 */

const express = require('express');
const router = express.Router();
const db = require('../../database');
const fs = require('fs');
const path = require('path');
const logger = require('../../src/utils/logger');
const UserService = require('../../src/services/UserService');
const DeliveryService = require('../../src/services/DeliveryService');
const { ROLE_ADMIN, ROLE_DRIVER } = require('../../middleware/permissions');

// ── Chỉ ADMIN ──────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }
  if (req.user.role !== ROLE_ADMIN) {
    return res.status(403).json({
      error: 'Chỉ quản trị viên mới được quản lý tài khoản tài xế',
      code: 'ADMIN_ONLY',
    });
  }
  next();
}

// GET /api/admin/drivers — danh sách tài khoản
router.get('/drivers', requireAdmin, (req, res) => {
  try {
    const role = req.query.role ? String(req.query.role).toUpperCase() : undefined;
    const drivers = UserService.list(role ? { role } : {});
    res.json({ drivers, total: drivers.length });
  } catch (err) {
    logger.error('[admin/drivers] list error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải danh sách tài xế' });
  }
});

// GET /api/admin/drivers/:id
router.get('/drivers/:id', requireAdmin, (req, res) => {
  const driver = UserService.getById(parseInt(req.params.id));
  if (!driver) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  res.json({ driver });
});

// POST /api/admin/drivers — tạo tài khoản tài xế
router.post('/drivers', requireAdmin, (req, res) => {
  try {
    const { username, password, fullName, phone, role } = req.body || {};

    const result = UserService.create({
      username,
      password,
      fullName,
      phone,
      // Admin có thể tạo tài khoản ADMIN (quản trị) hoặc DRIVER (tài xế)
      role: role ? String(role).toUpperCase() : ROLE_DRIVER,
      mustChangePassword: req.body?.mustChangePassword !== false,
    });

    if (!result.success) return res.status(400).json({ error: result.error });

    logger.info('[admin/drivers] created', { username: result.username, role: result.role });
    res.status(201).json({
      success: true,
      id: result.id,
      username: result.username,
      role: result.role,
    });
  } catch (err) {
    logger.error('[admin/drivers] create error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tạo tài khoản tài xế' });
  }
});

// PUT /api/admin/drivers/:id — sửa / khoá / đổi role / đổi mật khẩu
router.put('/drivers/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = UserService.update(id, req.body || {}, ROLE_ADMIN);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true, id });
  } catch (err) {
    logger.error('[admin/drivers] update error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật tài khoản' });
  }
});

// POST /api/admin/drivers/:id/reset-password
router.post('/drivers/:id/reset-password', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { password } = req.body || {};
    const result = UserService.changePassword(id, password, ROLE_ADMIN);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  } catch (err) {
    logger.error('[admin/drivers] reset-password error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi đổi mật khẩu' });
  }
});

// DELETE /api/admin/drivers/:id — khoá tài khoản (soft delete)
router.delete('/drivers/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = UserService.remove(id);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  } catch (err) {
    logger.error('[admin/drivers] delete error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi khoá tài khoản' });
  }
});

// GET /api/admin/drivers/:id/sessions — phiên đăng nhập đang hoạt động
router.get('/drivers/:id/sessions', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const sessions = db
      .prepare(
        `SELECT token, username, role, created_at, expires_at, last_active
         FROM auth_sessions WHERE app_user_id = ? ORDER BY last_active DESC`
      )
      .all(id);
    // Không trả về token (chỉ cần số lượng + thời điểm)
    res.json({
      sessions: sessions.map((s) => ({
        username: s.username,
        role: s.role,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
        lastActive: s.last_active,
      })),
      total: sessions.length,
    });
  } catch (err) {
    logger.error('[admin/drivers] sessions error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải phiên đăng nhập' });
  }
});

// GET /api/admin/logs/error — đọc N dòng cuối của logs/error.log (chẩn đoán)
// Chỉ ADMIN. Không chứa dữ liệu kinh doanh, chỉ log kỹ thuật.
router.get('/logs/error', requireAdmin, (req, res) => {
  try {
    const lines = Math.min(parseInt(req.query.lines || '60', 10), 500);
    // Logger ghi vào <root>/src/logs (src/utils/logger.js → path.join(__dirname,'..','logs'))
    // nhưng server.js deploy log dùng <root>/logs — thử cả hai.
    const candidates = [
      path.join(__dirname, '../../src/logs/error.log'),
      path.join(__dirname, '../../logs/error.log'),
    ];
    const found = candidates.find((f) => fs.existsSync(f));
    if (!found) {
      const dirs = candidates.map((f) => path.dirname(f));
      const listing = dirs.map((d) => {
        try {
          return d + ' => [' + fs.readdirSync(d).join(', ') + ']';
        } catch (e) {
          return d + ' => (unreadable: ' + e.message + ')';
        }
      });
      return res.type('text/plain').send('NOT FOUND\n' + listing.join('\n'));
    }
    const content = fs.readFileSync(found, 'utf8');
    const tail = content.split('\n').filter(Boolean).slice(-lines).join('\n');
    res.type('text/plain').send(found + '\n' + (tail || '(empty)'));
  } catch (err) {
    res.status(500).json({ error: 'Không đọc được log: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// QUẢN LÝ PHIẾU GIAO HÀNG (ADMIN)
// ═══════════════════════════════════════════════════════════════════════════
//
// Nghiệp vụ (2026-11-23):
//  1. "Mỗi hóa đơn giao hàng chỉ được đối soát một lần."
//  2. "Không cho sửa số liệu đã xác nhận nếu không có quyền quản lý."
//
// → Ở đây CHỈ quản lý (ADMIN) được phép:
//   - Xem phiếu giao đã đối soát (báo cáo).
//   - Sửa lại số liệu đã xác nhận (có `force` → ghi đè khoá đối soát, có
//     audit log đầy đủ).

// GET /api/admin/deliveries/reconciliation — danh sách phiếu giao đã đối soát
router.get('/deliveries/reconciliation', requireAdmin, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10) || 0;
    const onlyReconciled = req.query.reconciled !== '0';

    const where = onlyReconciled
      ? "WHERE dr.reconciled_at IS NOT NULL AND dr.reconciled_at <> ''"
      : '';

    const rows = db
      .prepare(
        `SELECT dr.id, dr.sale_id, dr.customer_id, dr.driver_username,
                dr.status, dr.delivered_liters, dr.missing_liters, dr.excess_liters,
                dr.damaged_liters, dr.collected_kegs, dr.expected_kegs,
                dr.reconciled_at, dr.reconciled_by, dr.confirmed_by,
                dr.scheduled_date, dr.completed_at,
                c.name AS customer_name
           FROM delivery_records dr
           LEFT JOIN customers c ON c.id = dr.customer_id
           ${where}
          ORDER BY dr.reconciled_at DESC, dr.id DESC
          LIMIT ? OFFSET ?`
      )
      .all(limit, offset);

    const total = db
      .prepare(
        `SELECT COUNT(*) AS c FROM delivery_records dr
          ${onlyReconciled ? "WHERE dr.reconciled_at IS NOT NULL AND dr.reconciled_at <> ''" : ''}`
      )
      .get()?.c || 0;

    res.json({ success: true, deliveries: rows, total, limit, offset });
  } catch (err) {
    logger.error('[admin/deliveries/reconciliation] list error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải danh sách phiếu giao đã đối soát' });
  }
});

// GET /api/admin/deliveries/:id — chi tiết phiếu giao (items + lịch sử)
router.get('/deliveries/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ error: 'ID phiếu giao không hợp lệ' });
    }

    const record = DeliveryService.getRecordById(id);
    if (!record) {
      return res.status(404).json({ error: 'Không tìm thấy phiếu giao' });
    }

    const items = db
      .prepare('SELECT * FROM delivery_record_items WHERE delivery_id = ? ORDER BY id')
      .all(id);
    const events = db
      .prepare('SELECT * FROM delivery_events WHERE delivery_id = ? ORDER BY id DESC')
      .all(id);
    const customer = record.customer_id
      ? db.prepare('SELECT id, name, phone FROM customers WHERE id = ?').get(record.customer_id)
      : null;

    res.json({ success: true, delivery: record, items, events, customer });
  } catch (err) {
    logger.error('[admin/deliveries/detail] error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi tải chi tiết phiếu giao' });
  }
});

// PUT /api/admin/deliveries/:id/confirm — quản lý sửa lại số liệu đã xác nhận
//
// ⚠️ Đây là đường DUY NHẤT để ghi đè khoá "đối soát 1 lần" / "số liệu đã
//    xác nhận". Mọi thao tác đều ghi `delivery_events` (audit trail).
router.put('/deliveries/:id/confirm', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ error: 'ID phiếu giao không hợp lệ' });
    }

    const record = DeliveryService.getRecordById(id);
    if (!record) {
      return res.status(404).json({ error: 'Không tìm thấy phiếu giao' });
    }

    const { items, collectedKegs, note } = req.body || {};
    const result = DeliveryService.confirmDelivery(
      id,
      record.driver_username,
      {
        items: Array.isArray(items) ? items : [],
        collectedKegs: collectedKegs !== undefined ? collectedKegs : record.collected_kegs,
        note: note || `Sửa lại bởi quản lý (${req.user.username})`,
      },
      { user: req.user, force: true }
    );

    if (!result.success) {
      const status = result.code === 'MANAGEMENT_REQUIRED' ? 403 : 400;
      return res.status(status).json({ error: result.error, code: result.code });
    }

    res.json(result);
  } catch (err) {
    logger.error('[admin/deliveries/confirm] error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi cập nhật phiếu giao: ' + err.message });
  }
});

// POST /api/admin/deliveries/:id/reconcile — đánh dấu phiếu đã đối soát
// (dùng khi phiếu được giao ngoài hệ thống và cần khoá lại 1 lần).
router.post('/deliveries/:id/reconcile', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ error: 'ID phiếu giao không hợp lệ' });
    }

    const record = DeliveryService.getRecordById(id);
    if (!record) {
      return res.status(404).json({ error: 'Không tìm thấy phiếu giao' });
    }

    const result = DeliveryService.markReconciled(id, req.user.username);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[admin/deliveries/reconcile] error', { error: err.message });
    res.status(500).json({ error: 'Lỗi khi đánh dấu đối soát: ' + err.message });
  }
});

module.exports = router;
module.exports.requireAdmin = requireAdmin;
