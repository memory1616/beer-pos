/**
 * Sepay — API gạch nợ công nợ tự động
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount tại `/api/debt-ledger/sepay`.
 *
 * ⚠️ ROUTE WEBHOOK (public, KHÔNG cần đăng nhập):
 *   POST /webhook/sepay  — mount RIÊNG ở server.js (trước auth guard)
 *   vì Sepay gọi từ server bên ngoài, không có session.
 *
 * Endpoint quản trị:
 *  GET  /api/debt-ledger/sepay/status          — Trạng thái + thống kê
 *  GET  /api/debt-ledger/sepay/transactions    — Danh sách giao dịch
 *  POST /api/debt-ledger/sepay/settings         — Lưu cấu hình (ADMIN)
 *  POST /api/debt-ledger/sepay/reconcile        — Đối soát tay qua API (ADMIN)
 *  POST /api/debt-ledger/sepay/transactions/:id/assign — Gán khách + gạch nợ
 *  POST /api/debt-ledger/sepay/transactions/:id/ignore  — Bỏ qua giao dịch
 *  POST /api/debt-ledger/sepay/customer-code    — Gán/sửa mã khách
 */

const express = require('express');
const router = express.Router();

const logger = require('../../src/utils/logger');
const DebtPermissionService = require('../../src/services/debt/DebtPermissionService');
const DebtSepayService = require('../../src/services/debt/DebtSepayService');
const db = require('../../database');

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

/** STAFF hoặc ADMIN. */
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

// ═══════════════════════════════════════════════════════════════════════════
// A. TRẠNG THÁI & THỐNG KÊ
// ═══════════════════════════════════════════════════════════════════════════
router.get('/status', requireAuth, requireStaff, (req, res) => {
  try {
    const summary = DebtSepayService.getSummary();
    const settings = DebtSepayService.getSettings();
    res.json({
      success: true,
      data: {
        summary,
        // KHÔNG trả về secret cho client
        hasApiToken: !!settings.apiToken,
        hasWebhookSecret: !!settings.webhookSecret,
        paymentCodePrefix: settings.paymentCodePrefix,
        bankAccounts: settings.bankAccounts,
        autoSettle: settings.autoSettle,
        webhookUrl: '/webhook/sepay',
        // Auto-poll: đối soát định kỳ qua API → tự gạch nợ dù webhook lỗi
        autoPollEnabled: settings.autoPollEnabled,
        autoPollIntervalMin: settings.autoPollIntervalMin,
        autoPollLookbackDays: settings.autoPollLookbackDays,
        // Gạch nợ thông minh: nhận diện khách theo số TK / tên người gửi
        smartMatchEnabled: DebtSepayService.getSetting('sepay_smart_match_enabled', '1') !== '0',
        smartMatchByName: DebtSepayService.getSetting('sepay_smart_match_by_name', '1') !== '0',
        smartMatchMinConfidence: parseFloat(
          DebtSepayService.getSetting('sepay_smart_min_confidence', '0.9')
        ) || 0.9,
      },
    });
  } catch (e) {
    logger.error('[SEPAY_API] status error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// B. DANH SÁCH GIAO DỊCH
// ═══════════════════════════════════════════════════════════════════════════
router.get('/transactions', requireAuth, requireStaff, (req, res) => {
  try {
    const { status, customerId, from, to, limit, offset } = req.query || {};
    const result = DebtSepayService.listTransactions({
      status,
      customerId,
      from,
      to,
      limit,
      offset,
    });
    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('[SEPAY_API] list transactions error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// C. CẤU HÌNH (ADMIN)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/settings', requireAuth, requireAdmin, (req, res) => {
  try {
    const {
      apiToken,
      webhookSecret,
      bankAccounts,
      paymentCodePrefix,
      autoSettle,
      autoPollEnabled,
      autoPollIntervalMin,
      autoPollLookbackDays,
    } = req.body || {};

    const result = DebtSepayService.saveSettings({
      apiToken: apiToken !== undefined ? apiToken : undefined,
      webhookSecret: webhookSecret !== undefined ? webhookSecret : undefined,
      bankAccounts: bankAccounts !== undefined ? bankAccounts : undefined,
      paymentCodePrefix: paymentCodePrefix !== undefined ? paymentCodePrefix : undefined,
      autoSettle: autoSettle !== undefined ? !!autoSettle : undefined,
      autoPollEnabled:
        autoPollEnabled !== undefined ? !!autoPollEnabled : undefined,
      autoPollIntervalMin:
        autoPollIntervalMin !== undefined ? autoPollIntervalMin : undefined,
      autoPollLookbackDays:
        autoPollLookbackDays !== undefined ? autoPollLookbackDays : undefined,
    });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true });
  } catch (e) {
    logger.error('[SEPAY_API] save settings error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// D. ĐỐI SOÁT TAY QUA API SEPANY (bù cho webhook bị lỗi)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/reconcile', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.body || {};
    // Sửa mã khách lưu sai (do regex greedy) TRƯỚC khi đối soát
    const repair = DebtSepayService.repairDebtCodes();
    const result = await DebtSepayService.reconcile({
      from,
      to,
      user: req.user,
    });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    // Realtime — báo các khách vừa được gạch nợ
    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('debt:updated', { action: 'sepay_reconcile' });
      io.to('admin').emit('sepay:reconciled', {
        added: result.added,
        settled: result.settled,
        failed: result.failed,
        repairedCodes: repair.fixed,
      });
    }

    res.json({ success: true, data: { ...result, repairedCodes: repair } });
  } catch (e) {
    logger.error('[SEPAY_API] reconcile error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// D2. SỬA MÃ KHÁCH LƯU SAI TRONG GIAO DỊCH SEPAY
// ───────────────────────────────────────────────────────────────────────────
// Giao dịch có nội dung kiểu "…KH0006-211126-18:37:58…" trước đây bị trích
// sai mã thành "KH00062111" (regex greedy nuốt phần ngày giờ).
// Endpoint này trích lại mã đúng cho toàn bộ giao dịch đã lưu.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/repair-codes', requireAuth, requireAdmin, (req, res) => {
  try {
    const result = DebtSepayService.repairDebtCodes();
    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('[SEPAY_API] repair-codes error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// E. GÁN KHÁCH THỦ CÔNG + GẠCH NỢ
// ═══════════════════════════════════════════════════════════════════════════
router.post('/transactions/:id/assign', requireAuth, requireStaff, (req, res) => {
  try {
    const { customerId } = req.body || {};
    const result = DebtSepayService.assignCustomerAndSettle(
      req.params.id,
      customerId,
      { user: req.user }
    );

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error, code: result.code });
    }

    const io = req.app.get('io');
    if (io && result.customerId) {
      io.to('admin').emit('debt:updated', {
        customerId: result.customerId,
        newDebt: result.balanceAfter,
        action: 'sepay_payment',
      });
    }

    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('[SEPAY_API] assign error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// F. BỎ QUA GIAO DỊCH
// ═══════════════════════════════════════════════════════════════════════════
router.post('/transactions/:id/ignore', requireAuth, requireStaff, (req, res) => {
  try {
    const { note } = req.body || {};
    const result = DebtSepayService.ignoreTransaction(req.params.id, note);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true });
  } catch (e) {
    logger.error('[SEPAY_API] ignore error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// G. MÃ KHÁCH HÀNG (debt_code)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/customer-code', requireAuth, requireStaff, (req, res) => {
  try {
    const { customerId, code } = req.body || {};

    // Nếu không truyền `code` → tự sinh/gán mã
    if (!code) {
      const generated = DebtSepayService.ensureCustomerDebtCode(customerId);
      if (!generated) {
        return res.status(400).json({ success: false, error: 'Không gán được mã khách' });
      }
      const cust = db
        .prepare('SELECT id, name, phone, debt_code FROM customers WHERE id = ?')
        .get(parseInt(customerId, 10));
      return res.json({ success: true, data: { debtCode: generated, customer: cust } });
    }

    const result = DebtSepayService.setCustomerDebtCode(customerId, code);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true, data: { debtCode: result.debtCode } });
  } catch (e) {
    logger.error('[SEPAY_API] customer-code error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// H. GẠCH NỢ THÔNG MINH — số tài khoản ngân hàng của khách
// ─────────────────────────────────────────────────────────────────────────────
// Khách chuyển theo SỐ TÀI KHOẢN (không quét mã QR) → nội dung CK không
// có mã KH. Đăng ký số TK cho khách → hệ thống tự nhận diện & gạch nợ.
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/debt-ledger/sepay/bank-accounts — danh sách khách đã đăng ký số TK. */
router.get('/bank-accounts', requireAuth, requireStaff, (req, res) => {
  try {
    const items = DebtSepayService.listCustomerBankAccounts();
    res.json({ success: true, data: items });
  } catch (e) {
    logger.error('[SEPAY_API] bank-accounts error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/debt-ledger/sepay/bank-accounts
 * Đăng ký số tài khoản cho khách → hệ thống tự gạch nợ khi khách CK từ số TK.
 * Body: { customerId, accountNumber, accountHolder? }
 */
router.post('/bank-accounts', requireAuth, requireStaff, async (req, res) => {
  try {
    const { customerId, accountNumber, accountHolder } = req.body || {};
    const result = DebtSepayService.setCustomerBankAccount(
      customerId,
      accountNumber,
      accountHolder
    );

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    // Gán xong → thử đối soát lại các giao dịch đang chờ (có thể khớp ngay).
    let resmart = null;
    try {
      const pending = db
        .prepare(
          `SELECT COUNT(*) AS c FROM sepay_transactions
            WHERE status IN ('manual','pending') AND transfer_type = 'in'`
        )
        .get();
      if (pending && pending.c > 0) {
        resmart = await DebtSepayService.resmartMatchPending({ user: req.user });
      }
    } catch (e) {
      logger.error('[SEPAY_API] resmart after set account error', { error: e.message });
    }

    const io = req.app.get('io');
    if (io && resmart && resmart.settled > 0) {
      io.to('admin').emit('debt:updated', { action: 'sepay_smart_match' });
      io.to('admin').emit('sepay:reconciled', {
        added: resmart.settled,
        settled: resmart.settled,
        failed: resmart.failed,
      });
    }

    res.json({ success: true, data: { ...result, resmart } });
  } catch (e) {
    logger.error('[SEPAY_API] set bank account error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/** DELETE /api/debt-ledger/sepay/bank-accounts/:customerId — gỡ số TK. */
router.delete('/bank-accounts/:customerId', requireAuth, requireAdmin, (req, res) => {
  try {
    const result = DebtSepayService.clearCustomerBankAccount(req.params.customerId);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true });
  } catch (e) {
    logger.error('[SEPAY_API] clear bank account error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/debt-ledger/sepay/smart-rematch
 * Chạy lại gạch nợ thông minh cho toàn bộ giao dịch đang chờ (manual/pending).
 */
router.post('/smart-rematch', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await DebtSepayService.resmartMatchPending({ user: req.user });

    const io = req.app.get('io');
    if (io && result.settled > 0) {
      io.to('admin').emit('debt:updated', { action: 'sepay_smart_match' });
      io.to('admin').emit('sepay:reconciled', {
        added: result.settled,
        settled: result.settled,
        failed: result.failed,
      });
    }

    res.json({ success: true, data: result });
  } catch (e) {
    logger.error('[SEPAY_API] smart-rematch error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
