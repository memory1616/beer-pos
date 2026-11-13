/**
 * DebtPaymentService — Ghi nhận thanh toán công nợ (PAYMENT)
 * ─────────────────────────────────────────────────────────────────────────────
 * Dùng cho:
 *  - Nhập thanh toán thủ công trên UI Sổ công nợ (trang quản trị).
 *  - Quick Entry (thay thế Zalo) — nhân viên nhập `+1000` hoặc số tiền.
 *
 * Quy tắc:
 *  - Không cho phép thanh toán vượt số dư công nợ (quyết định đã chốt: block).
 *  - Không cho phép thanh toán khi khách không có công nợ.
 *  - Mỗi giao dịch có idempotency key → chống double-click / retry.
 *  - Audit log bắt buộc.
 */

const db = require('../../../database');
const logger = require('../../utils/logger');
const DebtLedgerService = require('./DebtLedgerService');
const DebtAuditService = require('./DebtAuditService');
const DebtPermissionService = require('./DebtPermissionService');
const { TRANSACTION_TYPES, SOURCES, REFERENCE_TYPES } = require('./constants');

/**
 * Ghi nhận thanh toán.
 *
 * @param {object} opts
 * @param {number} opts.customerId
 * @param {number} opts.amount      - số tiền (VND, luôn > 0)
 * @param {object} opts.user        - người thực hiện (req.user)
 * @param {string} [opts.note]
 * @param {number} [opts.saleId]    - gắn với đơn hàng (tuỳ chọn)
 * @param {string} [opts.source]    - SOURCES.*
 * @param {string} [opts.idempotencyKey]
 * @returns {{success:boolean, error?:string, transactionId?:number, balanceBefore?:number, balanceAfter?:number, appliedAmount?:number}}
 */
function recordPayment(opts = {}) {
  const { customerId, amount, user, note, saleId, source, idempotencyKey } = opts;

  const custId = parseInt(customerId, 10);
  const value = DebtLedgerService.roundMoney(amount);

  if (!custId || Number.isNaN(custId)) {
    return { success: false, error: 'customerId không hợp lệ' };
  }
  if (!(value > 0)) {
    return { success: false, error: 'Số tiền phải lớn hơn 0' };
  }

  // 1. Phân quyền
  if (!DebtPermissionService.canRecordPayment(user, custId)) {
    return {
      success: false,
      error: 'Bạn không có quyền ghi nhận thanh toán cho khách hàng này',
      code: 'NO_PERMISSION',
    };
  }

  // 2. Kiểm tra số dư (chặn thanh toán vượt)
  const balanceBefore = DebtLedgerService.computeBalance(custId);
  if (balanceBefore <= 0) {
    return { success: false, error: 'Khách hàng không có công nợ' };
  }
  if (value > balanceBefore) {
    return {
      success: false,
      error: `Số tiền vượt quá công nợ hiện tại (${balanceBefore.toLocaleString('vi-VN')}đ)`,
      code: 'OVERPAYMENT_BLOCKED',
      balanceBefore,
    };
  }

  // 3. Ghi bút toán
  const result = DebtLedgerService.recordTransaction({
    customerId: custId,
    transactionType: TRANSACTION_TYPES.PAYMENT,
    amount: value,
    direction: DebtLedgerService.DIRECTION.DECREASE,
    referenceType: saleId ? REFERENCE_TYPES.ORDER : REFERENCE_TYPES.NONE,
    referenceId: saleId || null,
    description: note || `Thanh toán công nợ (${value.toLocaleString('vi-VN')}đ)`,
    createdBy: (user && user.username) || null,
    source: source || SOURCES.MANUAL_UI,
    idempotencyKey: idempotencyKey || null,
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  // 4. Bảng `payments` (lịch sử thu tiền legacy — giữ để không phá báo cáo cũ)
  try {
    db.prepare('INSERT INTO payments (customer_id, amount, date, note) VALUES (?, ?, ?, ?)').run(
      custId,
      value,
      db.getVietnamDateStr(),
      note || `Thu tiền công nợ (${value.toLocaleString('vi-VN')}đ)`
    );
  } catch (e) {
    logger.error('[DEBT_PAYMENT] insert payments error', { error: e.message });
  }

  // 5. Phân bổ vào bảng chiếu `order_debts` (nếu gắn đơn)
  if (saleId) {
    try {
      const proj = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleId);
      if (proj) {
        const newPaid = proj.paid_amount + value;
        const newRemaining = Math.max(0, proj.original_amount - newPaid);
        const status = newRemaining <= 0 ? 'paid' : 'partial';
        db.prepare(
          `UPDATE order_debts
              SET paid_amount = ?, remaining_amount = ?, status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`
        ).run(newPaid, newRemaining, status, proj.id);
        db.prepare('UPDATE sales SET payment_status = ? WHERE id = ?').run(status, saleId);
      }
    } catch (e) {
      logger.error('[DEBT_PAYMENT] allocate to order_debts error', { error: e.message });
    }
  } else {
    // 5b. KHÔNG gắn đơn cụ thể → phân bổ vào các đơn chưa thanh toán của khách
    // (theo thứ tự cũ nhất trước — FIFO). Cần thiết với mô hình "ghi nợ khi tạo
    // đơn": khi khách trả tiền mặt cho nhiều đơn gộp lại, các đơn này phải
    // được đánh dấu paid/partial tương ứng.
    try {
      const unpaidOrders = db
        .prepare(
          `SELECT * FROM order_debts
            WHERE customer_id = ? AND status != 'paid' AND status != 'cancelled'
            ORDER BY created_at ASC, id ASC`
        )
        .all(custId);

      let remaining = value;
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
      logger.error('[DEBT_PAYMENT] FIFO allocate error', { error: e.message });
    }
  }

  // 6. Audit log
  DebtAuditService.record({
    transactionId: result.transactionId,
    action: DebtAuditService.AUDIT_ACTIONS.CREATE,
    actorId: (user && user.username) || null,
    beforeData: { balance: balanceBefore },
    afterData: { balance: result.balanceAfter, amount: value, saleId: saleId || null },
  });

  return {
    success: true,
    transactionId: result.transactionId,
    balanceBefore,
    balanceAfter: result.balanceAfter,
    appliedAmount: value,
    duplicate: !!result.duplicate,
  };
}

module.exports = { recordPayment };
