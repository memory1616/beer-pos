/**
 * DriverCashService — Thu tiền mặt của tài xế tại điểm giao
 * ─────────────────────────────────────────────────────────────────────────────
 * NGHIỆP VỤ:
 *  1. Tài xế nhận tiền mặt của khách tại điểm giao → xác nhận → ghi nhận
 *     vào SỔ CÔNG NỢ:
 *       • Phần gạch nợ  = min(amount, số dư nợ trước)  → bút toán PAYMENT
 *       • Phần trả vượt = amount - phần gạch nợ        → bút toán CREDIT
 *         (khách nộp trước — giữ số dư âm, đúng mô hình SePay).
 *     Mỗi lần thu đều ghi 1 dòng `driver_cash_collections` (có idempotency).
 *  2. Cuối ngày cần biết tài xế đã thu bao nhiêu tiền mặt → tổng hợp
 *     theo ngày nghiệp vụ (báo cáo).
 *
 * NGUYÊN TẮC:
 *  - Sổ công nợ (ledger) là nguồn sự thật; bảng `driver_cash_collections`
 *    là BẢNG CHIẾU để báo cáo "tài xế đã thu bao nhiêu tiền mặt".
 *  - Idempotency: `idempotency_key` UNIQUE → chống double-click / retry.
 *  - Lỗi ghi sổ công nợ → KHÔNG tạo dòng thu tiền (tránh lệch tiền mặt).
 */

const db = require('../../database');
const logger = require('../utils/logger');
const DebtLedgerService = require('./debt/DebtLedgerService');
const DebtNotifyService = require('./debt/DebtNotifyService');
const DebtAuditService = require('./debt/DebtAuditService');
const DebtPermissionService = require('./debt/DebtPermissionService');
const { TRANSACTION_TYPES, SOURCES, REFERENCE_TYPES } = require('./debt/constants');

const COLLECTION_STATUS = {
  RECORDED: 'recorded',
  REVERSED: 'reversed',
};

/** Làm tròn 2 chữ số thập phân (tiền VND). */
function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function getSetting(key, fallback = null) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row || row.value === null || row.value === undefined || row.value === '') {
      return fallback;
    }
    return String(row.value);
  } catch (_) {
    return fallback;
  }
}

/**
 * Sinh mã phiếu thu tiền mặt: TT-YYYYMMDD-XXXX
 * @param {string} businessDate - YYYY-MM-DD
 * @returns {string}
 */
function generateCollectionNo(businessDate) {
  const ymd = String(businessDate || db.getBusinessDateStr()).replace(/-/g, '');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM driver_cash_collections
        WHERE collection_no LIKE ?`
    )
    .get(`TT-${ymd}-%`);
  const seq = (row?.c || 0) + 1;
  return `TT-${ymd}-${String(seq).padStart(4, '0')}`;
}

/**
 * Phân bổ FIFO số tiền đã gạch vào các đơn chưa thanh toán của khách
 * (bảng chiếu `order_debts`) — giữ UI cũ khớp với ledger.
 *
 * @param {number} customerId
 * @param {number} amount
 */
function allocateToOrders(customerId, amount) {
  if (!(amount > 0)) return;
  try {
    const unpaidOrders = db
      .prepare(
        `SELECT * FROM order_debts
          WHERE customer_id = ? AND status != 'paid' AND status != 'cancelled'
          ORDER BY created_at ASC, id ASC`
      )
      .all(customerId);

    let remaining = amount;
    for (const od of unpaidOrders) {
      if (remaining <= 0) break;
      const toApply = Math.min(remaining, od.remaining_amount || 0);
      if (toApply <= 0) continue;
      const newPaid = (od.paid_amount || 0) + toApply;
      const newRemaining = Math.max(0, od.original_amount - newPaid);
      const status = newRemaining <= 0 ? 'paid' : 'partial';
      db.prepare(
        `UPDATE order_debts
            SET paid_amount = ?, remaining_amount = ?, status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(newPaid, newRemaining, status, od.id);
      db.prepare('UPDATE sales SET payment_status = ? WHERE id = ?').run(status, od.sale_id);
      remaining -= toApply;
    }
  } catch (e) {
    logger.error('[DRIVER_CASH] allocateToOrders error', { error: e.message });
  }
}

/**
 * Ghi nhận tài xế thu tiền mặt của khách tại điểm giao.
 *
 * @param {object} opts
 * @param {number} opts.customerId
 * @param {number} opts.amount           - số tiền mặt nhận (VND, > 0)
 * @param {string} opts.driverUsername   - username tài xế
 * @param {number} [opts.saleId]
 * @param {number} [opts.deliveryId]
 * @param {string} [opts.note]
 * @param {string} [opts.idempotencyKey]
 * @param {object} [opts.user]           - req.user (để kiểm tra quyền)
 * @returns {{success:boolean, error?:string, code?:string, collection?:object,
 *            appliedAmount?:number, creditAmount?:number, balanceBefore?:number,
 *            balanceAfter?:number, transactionId?:number, creditTransactionId?:number}}
 */
function recordCollection(opts = {}) {
  const {
    customerId,
    amount,
    driverUsername,
    saleId = null,
    deliveryId = null,
    note = null,
    idempotencyKey = null,
    user = null,
  } = opts;

  const custId = parseInt(customerId, 10);
  const driver = String(driverUsername || '').trim();
  const value = roundMoney(amount);

  if (!custId || Number.isNaN(custId)) {
    return { success: false, error: 'Khách hàng không hợp lệ' };
  }
  if (!driver) {
    return { success: false, error: 'Thiếu thông tin tài xế' };
  }
  if (!(value > 0)) {
    return { success: false, error: 'Số tiền mặt phải lớn hơn 0' };
  }
  if (getSetting('driver_cash_collection_enabled', '1') !== '1') {
    return { success: false, error: 'Tính năng thu tiền mặt đang tắt', code: 'DISABLED' };
  }

  // ── Idempotency: đã ghi rồi → trả về bản ghi cũ ───────────────────────
  if (idempotencyKey) {
    try {
      const existing = db
        .prepare('SELECT * FROM driver_cash_collections WHERE idempotency_key = ?')
        .get(idempotencyKey);
      if (existing) {
        return {
          success: true,
          duplicate: true,
          collection: existing,
          appliedAmount: existing.applied_amount,
          creditAmount: existing.credit_amount,
          balanceBefore: existing.balance_before,
          balanceAfter: existing.balance_after,
          transactionId: existing.debt_transaction_id,
          creditTransactionId: existing.credit_transaction_id,
        };
      }
    } catch (e) {
      logger.error('[DRIVER_CASH] idempotency lookup error', { error: e.message });
    }
  }

  // ── Phân quyền ─────────────────────────────────────────────────────────
  const actor = user || { username: driver, role: 'DRIVER' };
  if (!DebtPermissionService.canRecordPayment(actor, custId)) {
    return {
      success: false,
      error: 'Bạn không có quyền ghi nhận thanh toán cho khách hàng này',
      code: 'NO_PERMISSION',
    };
  }

  const customer = db
    .prepare('SELECT id, name, archived FROM customers WHERE id = ?')
    .get(custId);
  if (!customer) {
    return { success: false, error: 'Không tìm thấy khách hàng' };
  }
  if (customer.archived) {
    return { success: false, error: 'Khách hàng đã bị lưu trữ' };
  }

  const businessDate = db.getBusinessDateStr();

  // ── Tính phần gạch nợ / phần trả vượt ─────────────────────────────────
  const balanceBefore = DebtLedgerService.computeBalance(custId);
  const owed = balanceBefore > 0 ? balanceBefore : 0;
  const applied = roundMoney(Math.min(value, owed));
  const credit = roundMoney(Math.max(0, value - applied));

  let paymentResult = null;
  let creditResult = null;

  try {
    const tx = db.transaction(() => {
      // 1. Bút toán PAYMENT (gạch nợ) — chỉ khi có nợ để gạch
      if (applied > 0) {
        const res = DebtLedgerService.recordTransaction({
          customerId: custId,
          transactionType: TRANSACTION_TYPES.PAYMENT,
          amount: applied,
          direction: DebtLedgerService.DIRECTION.DECREASE,
          referenceType: saleId ? REFERENCE_TYPES.ORDER : REFERENCE_TYPES.NONE,
          referenceId: saleId ? String(saleId) : null,
          description:
            note || `Thu tiền mặt tại điểm giao (${applied.toLocaleString('vi-VN')}đ) - ${driver}`,
          createdBy: driver,
          source: SOURCES.DRIVER_CASH,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:payment` : null,
          allowNegativeBalance: true,
          keepNegativeBalance: true,
          businessDate,
          buildNotification: (ctx) =>
            DebtNotifyService.buildPaymentNotificationPayload({
              customerId: ctx.customerId,
              customerName: ctx.customerName,
              transactionId: ctx.transactionId,
              amount: value,
              balanceBefore,
              // Số dư cuối = balanceBefore - applied - credit (CẢ HAI bút toán
              // đều DECREASE) → tính trước để nội dung tin khớp thực tế.
              balanceAfter: roundMoney(balanceBefore - applied - credit),
              applied,
              credit,
              source: SOURCES.DRIVER_CASH,
            }),
        });
        if (!res.success) throw new Error(res.error || 'Không ghi được bút toán thanh toán');
        paymentResult = res;

        // Bảng `payments` (lịch sử thu tiền legacy — giữ để không phá báo cáo cũ)
        try {
          db.prepare('INSERT INTO payments (customer_id, amount, date, note) VALUES (?, ?, ?, ?)').run(
            custId,
            applied,
            businessDate,
            note || `Thu tiền mặt tại điểm giao (${applied.toLocaleString('vi-VN')}đ) - ${driver}`
          );
        } catch (e) {
          logger.error('[DRIVER_CASH] insert payments error', { error: e.message });
        }

        // Phân bổ FIFO vào bảng chiếu `order_debts`
        allocateToOrders(custId, applied);
      }

      // 2. Bút toán CREDIT (khách trả vượt → nộp trước, số dư âm)
      if (credit > 0) {
        const res = DebtLedgerService.recordTransaction({
          customerId: custId,
          transactionType: TRANSACTION_TYPES.CREDIT,
          amount: credit,
          direction: DebtLedgerService.DIRECTION.DECREASE,
          referenceType: saleId ? REFERENCE_TYPES.ORDER : REFERENCE_TYPES.NONE,
          referenceId: saleId ? String(saleId) : null,
          description: `Khách trả vượt công nợ bằng tiền mặt (${credit.toLocaleString('vi-VN')}đ) - ${driver}`,
          createdBy: driver,
          source: SOURCES.DRIVER_CASH,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:credit` : null,
          allowNegativeBalance: true,
          keepNegativeBalance: true,
          businessDate,
        });
        if (!res.success) throw new Error(res.error || 'Không ghi được bút toán tiền nộp trước');
        creditResult = res;
      }

      // 3. Dòng thu tiền mặt (bảng chiếu cho báo cáo cuối ngày)
      const collectionNo = generateCollectionNo(businessDate);
      const info = db
        .prepare(
          `INSERT INTO driver_cash_collections
             (collection_no, driver_username, customer_id, customer_name,
              sale_id, delivery_id, amount, applied_amount, credit_amount,
              debt_transaction_id, credit_transaction_id,
              balance_before, balance_after, business_date, note, status, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          collectionNo,
          driver,
          custId,
          customer.name,
          saleId,
          deliveryId,
          value,
          applied,
          credit,
          paymentResult ? paymentResult.transactionId : null,
          creditResult ? creditResult.transactionId : null,
          balanceBefore,
          roundMoney(balanceBefore - applied - credit),
          businessDate,
          note,
          COLLECTION_STATUS.RECORDED,
          idempotencyKey
        );

      return {
        id: info.lastInsertRowid,
        collectionNo,
        balanceAfter: roundMoney(balanceBefore - applied - credit),
      };
    });

    const out = tx();

    // 4. Audit log (ngoài transaction — không được làm hỏng nghiệp vụ)
    try {
      DebtAuditService.record({
        transactionId: paymentResult ? paymentResult.transactionId : null,
        action: DebtAuditService.AUDIT_ACTIONS.CREATE,
        actorId: driver,
        beforeData: { balance: balanceBefore },
        afterData: {
          balance: out.balanceAfter,
          amount: value,
          applied,
          credit,
          collectionNo: out.collectionNo,
        },
      });
    } catch (e) {
      logger.error('[DRIVER_CASH] audit error', { error: e.message });
    }

    // 5. Job thông báo fallback (khi bút toán PAYMENT không tạo được job)
    if (applied > 0 && paymentResult && !paymentResult.notificationJob) {
      try {
        DebtNotifyService.notifyPaymentAsync({
          customerId: custId,
          amount: value,
          applied,
          credit,
          balanceBefore,
          balanceAfter: out.balanceAfter,
          source: SOURCES.DRIVER_CASH,
          transactionId: paymentResult.transactionId,
        });
      } catch (e) {
        logger.error('[DRIVER_CASH] notify fallback error', { error: e.message });
      }
    }

    const collection = db
      .prepare('SELECT * FROM driver_cash_collections WHERE id = ?')
      .get(out.id);

    logger.info('[DRIVER_CASH] Recorded cash collection', {
      driver,
      customerId: custId,
      amount: value,
      applied,
      credit,
      balanceAfter: out.balanceAfter,
    });

    return {
      success: true,
      collection,
      appliedAmount: applied,
      creditAmount: credit,
      balanceBefore,
      balanceAfter: out.balanceAfter,
      transactionId: paymentResult ? paymentResult.transactionId : null,
      creditTransactionId: creditResult ? creditResult.transactionId : null,
    };
  } catch (e) {
    logger.error('[DRIVER_CASH] recordCollection error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Tổng hợp tiền mặt tài xế đã thu trong ngày + trạng thái bàn giao.
 *
 * @param {string} driverUsername
 * @param {string} [date] - ngày nghiệp vụ (YYYY-MM-DD), mặc định hôm nay
 * @returns {object}
 */
function getDailySummary(driverUsername, date) {
  const driver = String(driverUsername || '').trim();
  const businessDate = date || db.getBusinessDateStr();

  if (!driver) {
    return {
      success: false,
      error: 'Thiếu thông tin tài xế',
    };
  }

  try {
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total_amount,
                COALESCE(SUM(applied_amount), 0) AS applied_amount,
                COALESCE(SUM(credit_amount), 0) AS credit_amount,
                COUNT(*) AS collection_count
           FROM driver_cash_collections
          WHERE driver_username = ? AND business_date = ? AND status != 'reversed'`
      )
      .get(driver, businessDate);

    const collections = db
      .prepare(
        `SELECT id, collection_no, customer_id, customer_name, sale_id, delivery_id,
                amount, applied_amount, credit_amount, balance_before, balance_after,
                business_date, note, created_at
           FROM driver_cash_collections
          WHERE driver_username = ? AND business_date = ? AND status != 'reversed'
          ORDER BY id DESC`
      )
      .all(driver, businessDate);


    return {
      success: true,
      driverUsername: driver,
      businessDate,
      totalAmount: roundMoney(totals?.total_amount || 0),
      appliedAmount: roundMoney(totals?.applied_amount || 0),
      creditAmount: roundMoney(totals?.credit_amount || 0),
      collectionCount: totals?.collection_count || 0,
      collections,
    };
  } catch (e) {
    logger.error('[DRIVER_CASH] getDailySummary error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Tài xế khai báo bàn giao tiền mặt cuối ngày.
 * (Upsert — khai lại nhiều lần trong ngày chỉ giữ phiếu mới nhất.)
 *
 * @param {string} driverUsername
 * @param {string} [date]
 * @param {object} [opts] { note }
 * @returns {object}
 *//**
 * Tổng hợp tiền mặt tất cả tài xế trong ngày (quản lý).
 *
 * @param {string} [date]
 * @returns {object}
 */
function getAdminDailyOverview(date) {
  const businessDate = date || db.getBusinessDateStr();
  try {
    const rows = db
      .prepare(
        `SELECT c.driver_username,
                COALESCE(SUM(c.amount), 0) AS total_amount,
                COALESCE(SUM(c.applied_amount), 0) AS applied_amount,
                COALESCE(SUM(c.credit_amount), 0) AS credit_amount,
                COUNT(*) AS collection_count
           FROM driver_cash_collections c
          WHERE c.business_date = ? AND c.status != 'reversed'
          GROUP BY c.driver_username
          ORDER BY total_amount DESC`
      )
      .all(businessDate);

    const drivers = rows.map((r) => ({
      driverUsername: r.driver_username,
      totalAmount: roundMoney(r.total_amount),
      appliedAmount: roundMoney(r.applied_amount),
      creditAmount: roundMoney(r.credit_amount),
      collectionCount: r.collection_count,
    }));

    const totalAmount = roundMoney(drivers.reduce((sum, d) => sum + d.totalAmount, 0));

    return {
      success: true,
      businessDate,
      totalAmount,
      totalCollections: drivers.reduce((sum, d) => sum + d.collectionCount, 0),
      drivers,
    };
  } catch (e) {
    logger.error('[DRIVER_CASH] getAdminDailyOverview error', { error: e.message });
    return { success: false, error: e.message };
  }
}

module.exports = {
  COLLECTION_STATUS,
  generateCollectionNo,
  recordCollection,
  getDailySummary,
  getAdminDailyOverview,
};
