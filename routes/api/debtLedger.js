/**
 * Sổ Công nợ Gia Huy — API (module quản lý công nợ)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount tại `/api/debt-ledger`.
 *
 * Phân quyền (theo yêu cầu):
 *  ADMIN  : toàn quyền (xem/ghi/điều chỉnh/đảo/quản lý nhóm/phân quyền/lịch sử)
 *  STAFF  : chỉ ghi nhận thanh toán & ghi nợ tay cho khách hàng được phân công;
 *           xem sổ công nợ của các khách được phân công.
 *           KHÔNG điều chỉnh / KHÔNG đảo / KHÔNG quản lý nhóm.
 *  CUSTOMER: không có quyền ghi giao dịch.
 *
 * Endpoint:
 *  GET  /api/debt-ledger/overview           — Tổng quan
 *  GET  /api/debt-ledger/customers          — Danh sách khách + số dư
 *  GET  /api/debt-ledger/customers/:id      — Chi tiết công nợ 1 khách
 *  GET  /api/debt-ledger/customers/:id/transactions — Lịch sử giao dịch
 *  POST /api/debt-ledger/payment            — Nhập thanh toán thủ công
 *  POST /api/debt-ledger/manual-debt        — Ghi nợ tay (lệnh `-`)
 *  POST /api/debt-ledger/adjust             — Điều chỉnh công nợ (ADMIN)
 *  POST /api/debt-ledger/reverse            — Đảo giao dịch (ADMIN)
 *  GET  /api/debt-ledger/groups             — Danh sách nhóm Zalo
 *  POST /api/debt-ledger/groups             — Liên kết nhóm ↔ khách (ADMIN)
 *  DELETE /api/debt-ledger/groups/:id       — Gỡ liên kết (ADMIN)
 *  GET  /api/debt-ledger/permissions        — Danh sách phân quyền
 *  POST /api/debt-ledger/permissions        — Phân quyền (ADMIN)
 *  DELETE /api/debt-ledger/permissions      — Thu hồi quyền (ADMIN)
 *  GET  /api/debt-ledger/bridge             — Trạng thái Zalo Bridge
 *  POST /api/debt-ledger/quick-entry        — Quick Entry `+`/`-` (thay thế Zalo)
 *  GET  /api/debt-ledger/audit              — Nhật ký (ADMIN)
 */

const express = require('express');
const router = express.Router();

const db = require('../../database');
const logger = require('../../src/utils/logger');
const DebtLedgerService = require('../../src/services/debt/DebtLedgerService');
const DebtPermissionService = require('../../src/services/debt/DebtPermissionService');
const DebtPaymentService = require('../../src/services/debt/DebtPaymentService');
const DebtManualService = require('../../src/services/debt/DebtManualService');
const DebtCommandService = require('../../src/services/debt/DebtCommandService');
const DebtZaloBridge = require('../../src/services/debt/DebtZaloBridge');
const DebtAuditService = require('../../src/services/debt/DebtAuditService');
const DebtReconciliationService = require('../../src/services/debt/DebtReconciliationService');
const { PLATFORMS, GROUP_STATUS, SOURCES } = require('../../src/services/debt/constants');

// ── Helpers ─────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', loginRequired: true });
  }
  next();
}

function requireAdmin(req, res, next) {
  const u = DebtPermissionService.normalizeUser(req.user);
  if (!u.isAdmin) {
    return res.status(403).json({
      error: 'Chỉ quản trị viên mới được thực hiện thao tác này',
      code: 'ADMIN_ONLY',
    });
  }
  next();
}

/** Nhân viên (STAFF) hoặc ADMIN. */
function requireStaff(req, res, next) {
  const u = DebtPermissionService.normalizeUser(req.user);
  if (!u.isAdmin && !u.isStaff) {
    return res.status(403).json({
      error: 'Chỉ nhân viên được phân quyền hoặc quản trị viên mới được truy cập',
      code: 'STAFF_ONLY',
    });
  }
  next();
}

/** Xem khách cụ thể: ADMIN xem tất cả, STAFF xem khách được phân công. */
function canAccessCustomer(req, customerId) {
  const u = DebtPermissionService.normalizeUser(req.user);
  if (u.isAdmin) return true;
  if (u.isStaff) return DebtPermissionService.isAssignedToCustomer(u.username, customerId);
  return false;
}

/** Danh sách customerId mà người dùng hiện tại được phép xem (null = tất cả). */
function visibleCustomerIds(req) {
  const u = DebtPermissionService.normalizeUser(req.user);
  if (u.isAdmin) return null; // không giới hạn
  if (u.isStaff) {
    return DebtPermissionService.listAssignedCustomers(u.username).map((c) => c.id);
  }
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════
// A. TỔNG QUAN
// ═══════════════════════════════════════════════════════════════════════════
router.get('/overview', requireAuth, (req, res) => {
  try {
    const u = DebtPermissionService.normalizeUser(req.user);
    const allowedIds = visibleCustomerIds(req);

    const scoped = (sql, params = []) => {
      if (allowedIds === null) return db.prepare(sql).all(...params);
      if (!allowedIds.length) return [];
      const placeholders = allowedIds.map(() => '?').join(',');
      return db.prepare(`${sql} AND dt.customer_id IN (${placeholders})`).all(...params, ...allowedIds);
    };

    const today = db.getVietnamDateStr();

    const todayDebt = scoped(
      `SELECT COALESCE(SUM(dt.amount), 0) AS total
         FROM debt_transactions dt
        WHERE dt.direction = 'INCREASE'
          AND dt.transaction_type IN ('ORDER_DEBT','MANUAL_DEBT')
          AND date(dt.created_at) = date(?)`,
      [today]
    )[0];

    const todayPayment = scoped(
      `SELECT COALESCE(SUM(dt.amount), 0) AS total
         FROM debt_transactions dt
        WHERE dt.direction = 'DECREASE'
          AND dt.transaction_type = 'PAYMENT'
          AND date(dt.created_at) = date(?)`,
      [today]
    )[0];

    // Số khách còn nợ + top nợ
    const debtCustomers = scoped(
      `SELECT dt.customer_id,
              COALESCE(SUM(CASE WHEN dt.direction='INCREASE' THEN dt.amount ELSE -dt.amount END),0) AS balance
         FROM debt_transactions dt
        GROUP BY dt.customer_id
       HAVING balance > 0
        ORDER BY balance DESC`
    );

    const topDebtors = debtCustomers.slice(0, 10).map((row) => {
      const c = db.prepare('SELECT id, name, phone FROM customers WHERE id = ?').get(row.customer_id);
      return {
        customerId: row.customer_id,
        name: c?.name || '(không rõ)',
        phone: c?.phone || '',
        balance: DebtLedgerService.roundMoney(row.balance),
      };
    });

    const totalBalance = debtCustomers.reduce(
      (s, r) => s + r.balance,
      0
    );
    const txCount = db.prepare('SELECT COUNT(*) AS c FROM debt_transactions').get()?.c || 0;
    const customersWithLedger = db
      .prepare('SELECT COUNT(DISTINCT customer_id) AS c FROM debt_transactions')
      .get()?.c || 0;

    res.json({
      success: true,
      data: {
        totalDebt: DebtLedgerService.roundMoney(totalBalance),
        todayDebtAdded: DebtLedgerService.roundMoney(todayDebt?.total || 0),
        todayPayment: DebtLedgerService.roundMoney(todayPayment?.total || 0),
        debtCustomerCount: debtCustomers.length,
        topDebtors,
        transactionCount: txCount,
        customersWithLedger,
        scope: allowedIds === null ? 'ALL' : 'ASSIGNED',
        role: u.role,
      },
    });
  } catch (e) {
    logger.error('[DEBT_LEDGER] overview error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// B. DANH SÁCH KHÁCH HÀNG
// ═══════════════════════════════════════════════════════════════════════════
router.get('/customers', requireAuth, (req, res) => {
  try {
    const allowedIds = visibleCustomerIds(req);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 200));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    let rows;
    if (allowedIds === null) {
      rows = DebtLedgerService.listAccounts({ limit, offset });
    } else if (!allowedIds.length) {
      rows = [];
    } else {
      const placeholders = allowedIds.map(() => '?').join(',');
      rows = db
        .prepare(
          `SELECT c.id, c.name, c.phone,
                  c.debt AS mirror_debt,
                  COALESCE(SUM(CASE WHEN dt.direction = 'INCREASE'
                                   THEN dt.amount ELSE -dt.amount END), 0) AS ledger_balance,
                  COUNT(dt.id) AS tx_count
             FROM customers c
             LEFT JOIN debt_transactions dt ON dt.customer_id = c.id
            WHERE c.archived = 0 AND c.id IN (${placeholders})
            GROUP BY c.id
            ORDER BY ledger_balance DESC, c.name ASC
            LIMIT ? OFFSET ?`
        )
        .all(...allowedIds, limit, offset)
        .map((r) => ({
          id: r.id,
          name: r.name,
          phone: r.phone,
          balance: DebtLedgerService.roundMoney(r.ledger_balance),
          mirrorDebt: DebtLedgerService.roundMoney(r.mirror_debt || 0),
          transactionCount: r.tx_count,
          hasLedger: r.tx_count > 0,
        }));
    }

    // Nhóm Zalo liên kết + trạng thái tài khoản
    const groups = db.prepare('SELECT customer_id, platform, group_id, group_name, status FROM debt_customer_groups').all();
    const groupMap = new Map();
    for (const g of groups) {
      if (!groupMap.has(g.customer_id)) groupMap.set(g.customer_id, []);
      groupMap.get(g.customer_id).push(g);
    }

    const accounts = db.prepare('SELECT customer_id, status, opening_balance FROM debt_accounts').all();
    const accountMap = new Map(accounts.map((a) => [a.customer_id, a]));

    const data = rows.map((r) => {
      const bd = r.hasLedger ? DebtLedgerService.getBalanceBreakdown(r.id) : null;
      return {
        ...r,
        totalDebt: r.balance,
        paid: bd ? Math.abs(bd.payment) : 0,
        breakdown: bd,
        groups: groupMap.get(r.id) || [],
        accountStatus: accountMap.get(r.id)?.status || 'none',
      };
    });

    res.json({ success: true, data, count: data.length });
  } catch (e) {
    logger.error('[DEBT_LEDGER] customers error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// C. CHI TIẾT CÔNG NỢ 1 KHÁCH
// ═══════════════════════════════════════════════════════════════════════════
router.get('/customers/:id', requireAuth, (req, res) => {
  try {
    const customerId = parseInt(req.params.id, 10);
    if (!customerId || Number.isNaN(customerId)) {
      return res.status(400).json({ success: false, error: 'customerId không hợp lệ' });
    }
    if (!canAccessCustomer(req, customerId)) {
      return res.status(403).json({
        success: false,
        error: 'Bạn không có quyền xem công nợ của khách hàng này',
        code: 'NO_PERMISSION',
      });
    }

    const customer = db
      .prepare('SELECT id, name, phone, address, debt, archived FROM customers WHERE id = ?')
      .get(customerId);
    if (!customer) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy khách hàng' });
    }

    const breakdown = DebtLedgerService.getBalanceBreakdown(customerId);
    const transactions = DebtLedgerService.listTransactions(customerId, 200);
    const account = db
      .prepare('SELECT * FROM debt_accounts WHERE customer_id = ?')
      .get(customerId);
    const groups = db
      .prepare('SELECT * FROM debt_customer_groups WHERE customer_id = ?')
      .all(customerId);
    const orderDebts = db
      .prepare(
        `SELECT od.*, s.total AS sale_total, s.date AS sale_date
           FROM order_debts od
           LEFT JOIN sales s ON s.id = od.sale_id
          WHERE od.customer_id = ?
          ORDER BY od.created_at DESC`
      )
      .all(customerId);

    res.json({
      success: true,
      data: {
        customer,
        account: account || null,
        openingBalance: breakdown.openingBalance,
        breakdown,
        balance: breakdown.balance,
        transactions,
        groups,
        orderDebts,
      },
    });
  } catch (e) {
    logger.error('[DEBT_LEDGER] customer detail error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/customers/:id/transactions', requireAuth, (req, res) => {
  try {
    const customerId = parseInt(req.params.id, 10);
    if (!canAccessCustomer(req, customerId)) {
      return res.status(403).json({ success: false, error: 'Không có quyền', code: 'NO_PERMISSION' });
    }
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    const transactions = DebtLedgerService.listTransactions(customerId, limit);
    res.json({ success: true, data: transactions });
  } catch (e) {
    logger.error('[DEBT_LEDGER] transactions error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// D. NHẬP THANH TOÁN THỦ CÔNG
// ═══════════════════════════════════════════════════════════════════════════
router.post('/payment', requireAuth, requireStaff, (req, res) => {
  try {
    const { customerId, amount, note, saleId } = req.body || {};
    const result = DebtPaymentService.recordPayment({
      customerId,
      amount,
      user: req.user,
      note,
      saleId: saleId ? parseInt(saleId, 10) : null,
      idempotencyKey: req.headers['x-request-id'] || null,
    });

    if (!result.success) {
      const code = result.code === 'NO_PERMISSION' ? 403 : 400;
      return res.status(code).json({ success: false, error: result.error, code: result.code });
    }

    // Realtime
    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('debt:updated', {
        customerId: parseInt(customerId, 10),
        newDebt: result.balanceAfter,
        action: 'payment',
      });
    }

    res.json({
      success: true,
      data: {
        transactionId: result.transactionId,
        balanceBefore: result.balanceBefore,
        balanceAfter: result.balanceAfter,
        appliedAmount: result.appliedAmount,
      },
    });
  } catch (e) {
    logger.error('[DEBT_LEDGER] payment error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Ghi nợ tay (lệnh `-`) — không tạo đơn hàng, không đổi doanh thu
// ═══════════════════════════════════════════════════════════════════════════
router.post('/manual-debt', requireAuth, requireStaff, (req, res) => {
  try {
    const { customerId, amount, note } = req.body || {};
    const result = DebtManualService.recordManualDebt({
      customerId,
      amount,
      user: req.user,
      note,
      idempotencyKey: req.headers['x-request-id'] || null,
    });

    if (!result.success) {
      const code = result.code === 'NO_PERMISSION' ? 403 : 400;
      return res.status(code).json({ success: false, error: result.error, code: result.code });
    }

    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('debt:updated', {
        customerId: parseInt(customerId, 10),
        newDebt: result.balanceAfter,
        action: 'manual_debt',
      });
    }

    res.json({
      success: true,
      data: {
        transactionId: result.transactionId,
        balanceBefore: result.balanceBefore,
        balanceAfter: result.balanceAfter,
      },
    });
  } catch (e) {
    logger.error('[DEBT_LEDGER] manual-debt error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ĐIỀU CHỈNH & ĐẢO (ADMIN)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/adjust', requireAuth, requireAdmin, (req, res) => {
  try {
    const { customerId, amount, reason } = req.body || {};
    const result = DebtManualService.adjustDebt({
      customerId,
      amount,
      user: req.user,
      reason,
      idempotencyKey: req.headers['x-request-id'] || null,
    });
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error, code: result.code });
    }
    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('[DEBT_LEDGER] adjust error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/reverse', requireAuth, requireAdmin, (req, res) => {
  try {
    const { transactionId, reason } = req.body || {};
    const result = DebtManualService.reverseTransaction({
      transactionId,
      user: req.user,
      reason,
    });
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error, code: result.code });
    }
    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('[DEBT_LEDGER] reverse error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// NHÓM ZALO (mapping khách ↔ nhóm)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/groups', requireAuth, (req, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT g.*, c.name AS customer_name
           FROM debt_customer_groups g
           LEFT JOIN customers c ON c.id = g.customer_id
          ORDER BY c.name, g.group_name`
      )
      .all();
    res.json({ success: true, data: rows });
  } catch (e) {
    logger.error('[DEBT_LEDGER] groups error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/groups', requireAuth, requireAdmin, (req, res) => {
  try {
    const { customerId, groupId, groupName, platform } = req.body || {};
    const custId = parseInt(customerId, 10);
    const plat = platform || PLATFORMS.ZALO_PERSONAL;

    if (!custId || Number.isNaN(custId) || !groupId) {
      return res.status(400).json({ success: false, error: 'Thiếu customerId hoặc groupId' });
    }
    if (plat === PLATFORMS.ZALO_OA) {
      return res.status(400).json({
        success: false,
        error: 'Module này KHÔNG dùng Zalo OA. Chỉ hỗ trợ nhóm Zalo cá nhân.',
      });
    }

    const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(custId);
    if (!customer) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy khách hàng' });
    }

    const existing = db
      .prepare('SELECT id, customer_id FROM debt_customer_groups WHERE platform = ? AND group_id = ?')
      .get(plat, String(groupId));

    if (existing) {
      db.prepare(
        `UPDATE debt_customer_groups
            SET customer_id = ?, group_name = ?, status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(custId, groupName || null, GROUP_STATUS.ACTIVE, existing.id);
      DebtAuditService.record({
        action: DebtAuditService.AUDIT_ACTIONS.GROUP_LINK,
        actorId: req.user?.username || null,
        beforeData: { customerId: existing.customer_id },
        afterData: { customerId: custId, groupId: String(groupId) },
      });
    } else {
      db.prepare(
        `INSERT INTO debt_customer_groups (customer_id, platform, group_id, group_name, status)
         VALUES (?, ?, ?, ?, ?)`
      ).run(custId, plat, String(groupId), groupName || null, GROUP_STATUS.ACTIVE);
      DebtAuditService.record({
        action: DebtAuditService.AUDIT_ACTIONS.GROUP_LINK,
        actorId: req.user?.username || null,
        afterData: { customerId: custId, groupId: String(groupId) },
      });
    }

    res.json({ success: true });
  } catch (e) {
    logger.error('[DEBT_LEDGER] link group error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/groups/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = db.prepare('SELECT * FROM debt_customer_groups WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy liên kết' });
    }
    // Không xoá vật lý — chuyển trạng thái inactive (giữ dấu vết)
    db.prepare(
      "UPDATE debt_customer_groups SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(id);
    DebtAuditService.record({
      action: DebtAuditService.AUDIT_ACTIONS.GROUP_UNLINK,
      actorId: req.user?.username || null,
      beforeData: existing,
      afterData: { status: 'inactive' },
    });
    res.json({ success: true });
  } catch (e) {
    logger.error('[DEBT_LEDGER] unlink group error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHÂN QUYỀN NHÂN VIÊN
// ═══════════════════════════════════════════════════════════════════════════
router.get('/permissions', requireAuth, (req, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT p.*, c.name AS customer_name, c.phone
           FROM debt_staff_permissions p
           LEFT JOIN customers c ON c.id = p.customer_id
          ORDER BY p.staff_id, c.name`
      )
      .all();
    const staff = DebtPermissionService.listStaffUsers();
    res.json({ success: true, data: { permissions: rows, staff } });
  } catch (e) {
    logger.error('[DEBT_LEDGER] permissions error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/permissions', requireAuth, requireAdmin, (req, res) => {
  try {
    const { staffId, customerId, canRecordPayment, status } = req.body || {};
    const result = DebtPermissionService.setPermission(staffId, customerId, {
      canRecordPayment,
      status,
    });
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    DebtAuditService.record({
      action: DebtAuditService.AUDIT_ACTIONS.PERMISSION_CHANGE,
      actorId: req.user?.username || null,
      afterData: result,
    });
    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('[DEBT_LEDGER] set permission error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/permissions', requireAuth, requireAdmin, (req, res) => {
  try {
    const { staffId, customerId } = req.body || {};
    const result = DebtPermissionService.revokePermission(staffId, customerId);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    DebtAuditService.record({
      action: DebtAuditService.AUDIT_ACTIONS.PERMISSION_CHANGE,
      actorId: req.user?.username || null,
      beforeData: { staffId, customerId },
      afterData: { removed: result.removed },
    });
    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('[DEBT_LEDGER] revoke permission error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TRẠNG THÁI BRIDGE + QUICK ENTRY
// ═══════════════════════════════════════════════════════════════════════════
router.get('/bridge', requireAuth, (req, res) => {
  try {
    const adapter = DebtZaloBridge.getAdapter();
    res.json({
      success: true,
      data: {
        ...adapter.getStatus(),
        settings: {
          commandUnit: DebtCommandService.getCommandUnit(),
          maxCommandAmount: DebtCommandService.getMaxCommandAmount(),
        },
      },
    });
  } catch (e) {
    logger.error('[DEBT_LEDGER] bridge status error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * Quick Entry — thay thế Zalo Personal Bridge.
 * Nhân viên nhập `+1000` / `-1000` (đơn vị nghìn đồng) hoặc nhập trực tiếp.
 */
router.post('/quick-entry', requireAuth, requireStaff, (req, res) => {
  try {
    const { content, customerId, senderId, messageId, groupId } = req.body || {};

    // Nếu nhập số tiền trực tiếp → chuyển thành lệnh chuẩn hoá
    let text = String(content || '').trim();
    const amountRaw = req.body?.amount;
    if (!text && amountRaw) {
      const sign = req.body?.direction === 'increase' ? '-' : '+';
      const unit = DebtCommandService.getCommandUnit();
      const units = Math.round(Number(amountRaw) / unit);
      text = `${sign}${units}`;
    }

    const result = DebtCommandService.handleMessage({
      messageId: messageId || `manual:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      groupId: groupId || `manual:${customerId || 'unknown'}`,
      senderId: senderId || req.user?.username,
      content: text,
      customerId: customerId ? parseInt(customerId, 10) : null,
      platform: PLATFORMS.MANUAL,
      senderRole: req.user?.role || null,
      source: SOURCES.MANUAL_UI,
    });

    if (!result.success) {
      const code = result.code === 'NO_PERMISSION' ? 403 : 400;
      return res.status(code).json({
        success: false,
        error: result.error,
        code: result.code,
        reply: result.reply,
      });
    }

    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('debt:updated', {
        customerId: result.data.customerId,
        newDebt: result.data.balanceAfter,
        action: result.data.sign === '+' ? 'payment' : 'manual_debt',
      });
    }

    res.json({ success: true, data: result.data, reply: result.reply });
  } catch (e) {
    logger.error('[DEBT_LEDGER] quick-entry error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// E. ĐỐI SOÁT (ADMIN)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/reconciliation', requireAuth, requireAdmin, (req, res) => {
  try {
    const result = DebtReconciliationService.run({ apply: false });
    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('[DEBT_LEDGER] reconciliation error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/reconciliation', requireAuth, requireAdmin, (req, res) => {
  try {
    const result = DebtReconciliationService.run({
      apply: req.body?.apply !== false,
      actor: req.user?.username || 'admin',
    });
    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('[DEBT_LEDGER] apply reconciliation error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/reconciliation/customer/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const result = DebtReconciliationService.reconcileCustomer(req.params.id);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true, data: result.data });
  } catch (e) {
    logger.error('[DEBT_LEDGER] reconcile customer error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// NHẬT KÝ (ADMIN)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/audit', requireAuth, requireAdmin, (req, res) => {
  try {
    const customerId = parseInt(req.query.customerId, 10);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    if (customerId) {
      const rows = DebtAuditService.listByCustomer(customerId, limit);
      return res.json({ success: true, data: rows });
    }
    const rows = db
      .prepare(
        `SELECT * FROM debt_audit_logs ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
    res.json({ success: true, data: rows });
  } catch (e) {
    logger.error('[DEBT_LEDGER] audit error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
