/**
 * DebtManualService — Ghi nợ tay (MANUAL_DEBT) & điều chỉnh công nợ (ADJUSTMENT)
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ QUY TẮC TUYỆT ĐỐI:
 *  Lệnh `-` (ghi nợ tay) TUYỆT ĐỐI KHÔNG tạo đơn hàng Beer POS và KHÔNG
 *  thay đổi doanh thu bán hàng. Đây chỉ là bút toán công nợ bổ sung.
 */

const logger = require('../../utils/logger');
const DebtLedgerService = require('./DebtLedgerService');
const DebtAuditService = require('./DebtAuditService');
const DebtPermissionService = require('./DebtPermissionService');
const { TRANSACTION_TYPES, SOURCES, REFERENCE_TYPES } = require('./constants');

/**
 * Ghi nợ tay (lệnh `-`).
 *
 * @param {object} opts
 * @param {number} opts.customerId
 * @param {number} opts.amount    - số tiền (VND > 0)
 * @param {object} opts.user      - người thực hiện
 * @param {string} [opts.note]
 * @param {string} [opts.source]
 * @param {string} [opts.idempotencyKey]
 */
function recordManualDebt(opts = {}) {
  const { customerId, amount, user, note, source, idempotencyKey } = opts;

  const custId = parseInt(customerId, 10);
  const value = DebtLedgerService.roundMoney(amount);

  if (!custId || Number.isNaN(custId)) {
    return { success: false, error: 'customerId không hợp lệ' };
  }
  if (!(value > 0)) {
    return { success: false, error: 'Số tiền phải lớn hơn 0' };
  }

  // Phân quyền: STAFF chỉ ghi được cho khách được phân công
  if (!DebtPermissionService.canRecordManualDebt(user, custId)) {
    return {
      success: false,
      error: 'Bạn không có quyền ghi nợ cho khách hàng này',
      code: 'NO_PERMISSION',
    };
  }

  const balanceBefore = DebtLedgerService.computeBalance(custId);

  const result = DebtLedgerService.recordTransaction({
    customerId: custId,
    transactionType: TRANSACTION_TYPES.MANUAL_DEBT,
    amount: value,
    direction: DebtLedgerService.DIRECTION.INCREASE,
    referenceType: REFERENCE_TYPES.NONE,
    referenceId: null,
    description: note || `Ghi nợ tay (${value.toLocaleString('vi-VN')}đ)`,
    createdBy: (user && user.username) || null,
    source: source || SOURCES.MANUAL_UI,
    idempotencyKey: idempotencyKey || null,
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  DebtAuditService.record({
    transactionId: result.transactionId,
    action: DebtAuditService.AUDIT_ACTIONS.CREATE,
    actorId: (user && user.username) || null,
    beforeData: { balance: balanceBefore },
    afterData: { balance: result.balanceAfter, amount: value, type: 'MANUAL_DEBT' },
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

/**
 * Điều chỉnh công nợ (ADJUSTMENT) — CHỈ ADMIN.
 * Dương = tăng nợ, âm = giảm nợ. Luôn tạo bút toán MỚI.
 */
function adjustDebt(opts = {}) {
  const { customerId, amount, user, reason, source, idempotencyKey } = opts;

  const custId = parseInt(customerId, 10);
  const value = DebtLedgerService.roundMoney(amount);

  if (!custId || Number.isNaN(custId)) {
    return { success: false, error: 'customerId không hợp lệ' };
  }
  if (!value) {
    return { success: false, error: 'Số tiền điều chỉnh không hợp lệ' };
  }

  // Điều chỉnh công nợ là quyền ADMIN
  if (!DebtPermissionService.hasAction(user, DebtPermissionService.ACTIONS.ADJUST)) {
    return {
      success: false,
      error: 'Chỉ quản trị viên mới được điều chỉnh công nợ',
      code: 'NO_PERMISSION',
    };
  }

  const balanceBefore = DebtLedgerService.computeBalance(custId);

  const result = DebtLedgerService.adjust(custId, value, {
    createdBy: (user && user.username) || null,
    source: source || SOURCES.MANUAL_UI,
    reason: reason || 'Điều chỉnh công nợ',
    referenceType: REFERENCE_TYPES.NONE,
    referenceId: null,
    idempotencyKey: idempotencyKey || null,
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  DebtAuditService.record({
    transactionId: result.transactionId,
    action: DebtAuditService.AUDIT_ACTIONS.ADJUST,
    actorId: (user && user.username) || null,
    beforeData: { balance: balanceBefore },
    afterData: { balance: result.balanceAfter, amount: value, reason: reason || '' },
  });

  return {
    success: true,
    transactionId: result.transactionId,
    balanceBefore,
    balanceAfter: result.balanceAfter,
    diff: value,
  };
}

/**
 * Đảo giao dịch (REVERSAL) — CHỈ ADMIN. Bút toán gốc KHÔNG bị xoá.
 */
function reverseTransaction(opts = {}) {
  const { transactionId, user, reason, source } = opts;

  const txId = parseInt(transactionId, 10);
  if (!txId || Number.isNaN(txId)) {
    return { success: false, error: 'transactionId không hợp lệ' };
  }

  if (!DebtPermissionService.hasAction(user, DebtPermissionService.ACTIONS.REVERSE)) {
    return {
      success: false,
      error: 'Chỉ quản trị viên mới được đảo giao dịch',
      code: 'NO_PERMISSION',
    };
  }

  const result = DebtLedgerService.reverseTransaction(txId, {
    createdBy: (user && user.username) || null,
    source: source || SOURCES.MANUAL_UI,
    reason: reason || null,
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  logger.info('[DEBT_MANUAL] Reversed transaction', {
    transactionId: txId,
    newTransactionId: result.transactionId,
  });

  return {
    success: true,
    transactionId: result.transactionId,
    originalTransactionId: txId,
    balanceAfter: result.balanceAfter,
  };
}

module.exports = {
  recordManualDebt,
  adjustDebt,
  reverseTransaction,
};
