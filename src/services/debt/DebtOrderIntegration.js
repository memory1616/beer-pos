/**
 * DebtOrderIntegration — Tích hợp sổ công nợ với vòng đời đơn hàng
 * ─────────────────────────────────────────────────────────────────────────────
 * Nguyên tắc (theo yêu cầu nghiệp vụ):
 *  1. CHỈ ghi công nợ khi đơn chuyển thực sự sang trạng thái `DELIVERED`
 *     (giao thành công sạch). KHÔNG ghi khi:
 *       - tạo đơn (PENDING / chưa giao)
 *       - đang giao (IN_PROGRESS)
 *       - hủy đơn / giao thất bại (FAILED)
 *       - giao có sai lệch (DISCREPANCY)  ← quyết định đã chốt: strict
 *  2. `Debt Amount = Amount Customer Owes` — KHÔNG mặc định lấy tổng đơn:
 *       amount_owed = total_gross
 *                   - total_paid (đã thu cho đơn này)
 *                   - total_refunded (đã hoàn/trả hàng)
 *                   - total_discount (KM/mua xuất đã trừ trong total)
 *  3. MỖI ĐƠN CHỈ CÓ MỘT bút toán ORDER_DEBT đang hiệu lực →
 *     dùng `idempotency_key = order_debt:sale:<saleId>` (UNIQUE).
 *  4. Giao nhiều lần / webhook lặp / server restart giữa chừng →
 *     an toàn tuyệt đối (idempotency key + `debt_processed_events`).
 *  5. Đơn thay đổi SAU khi giao → tạo bút toán ĐIỀU CHỈNH/ĐẢO, KHÔNG xoá
 *     bút toán gốc, luôn lưu lý do + người thực hiện.
 */

const db = require('../../../database');
const logger = require('../../utils/logger');
const DebtLedgerService = require('./DebtLedgerService');
const {
  TRANSACTION_TYPES,
  SOURCES,
  REFERENCE_TYPES,
  EVENT_TYPES,
} = require('./constants');

/** Trạng thái giao hàng "sạch" — nguồn: DeliveryService.DELIVERY_STATUS */
const CLEAN_DELIVERED_STATUS = 'DELIVERED';

/**
 * Idempotency key cho bút toán nợ của 1 đơn.
 * @param {number|string} saleId
 */
function orderDebtKey(saleId) {
  return `order_debt:sale:${saleId}`;
}

/**
 * Lấy đơn hàng + khách hàng (đủ thông tin để tính công nợ).
 */
function getSale(saleId) {
  const id = parseInt(saleId, 10);
  if (!id || Number.isNaN(id)) return null;
  return (
    db
      .prepare(
        `SELECT s.id, s.customer_id, s.total, s.status, s.archived, s.deleted,
                s.payment_status, s.delivery_status, s.promo_free_liters,
                s.promo_type, s.reward_liters_used, s.returned_amount,
                s.type, s.date, s.is_credit,
                c.name AS customer_name, c.archived AS customer_archived
           FROM sales s
           LEFT JOIN customers c ON c.id = s.customer_id
          WHERE s.id = ?`
      )
      .get(id) || null
  );
}

/**
 * Tính "Amount Customer Owes" của 1 đơn hàng.
 *
 * Công thức:
 *   total_gross    = sales.total            (đã trừ KM/mua xuất trong logic bán hàng)
 *   total_paid     = tổng PAYMENT gắn với đơn (ledger) ∪ order_debts.paid_amount
 *   total_refunded = tổng REVERSAL/ADJUSTMENT giảm gắn với đơn
 *   amount_owed    = MAX(0, total_gross - total_paid - total_refunded)
 *
 * @param {number} saleId
 * @param {number} customerId
 * @returns {{amountOwed:number, totalGross:number, totalPaid:number, totalRefunded:number, breakdown:object}}
 */
function computeAmountOwed(saleId, customerId) {
  const sale = getSale(saleId);
  if (!sale) {
    return {
      amountOwed: 0,
      totalGross: 0,
      totalPaid: 0,
      totalRefunded: 0,
      breakdown: {},
    };
  }

  const totalGross = sale.total || 0;

  // Đã thu cho đơn này (ledger — nguồn sự thật)
  const ledgerPaid =
    db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total
           FROM debt_transactions
          WHERE customer_id = ? AND reference_type = 'ORDER' AND reference_id = ?
            AND transaction_type = 'PAYMENT' AND direction = 'DECREASE'`
      )
      .get(customerId, String(saleId))?.total || 0;

  // Đã thu ghi nhận ở bảng chiếu `order_debts` (legacy/UI cũ)
  const projectionPaid =
    db
      .prepare(
        `SELECT COALESCE(paid_amount, 0) AS total FROM order_debts WHERE sale_id = ?`
      )
      .get(saleId)?.total || 0;

  // Đã hoàn / đảo gắn với đơn này
  const refunded =
    db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total
           FROM debt_transactions
          WHERE customer_id = ? AND reference_type = 'ORDER' AND reference_id = ?
            AND direction = 'DECREASE'
            AND transaction_type IN ('REVERSAL','ADJUSTMENT')`
      )
      .get(customerId, String(saleId))?.total || 0;

  const totalPaid = Math.max(ledgerPaid, projectionPaid);
  const amountOwed = Math.max(0, totalGross - totalPaid - refunded);

  return {
    amountOwed,
    totalGross,
    totalPaid,
    totalRefunded: refunded,
    breakdown: {
      saleId: sale.id,
      total: totalGross,
      ledgerPaid,
      projectionPaid,
      refunded,
      promoFreeLiters: sale.promo_free_liters || 0,
      rewardLitersUsed: sale.reward_liters_used || 0,
      returnedAmount: sale.returned_amount || 0,
      paymentStatus: sale.payment_status,
    },
  };
}

/**
 * Tìm bút toán ORDER_DEBT đang hiệu lực của 1 đơn.
 */
function findActiveOrderDebt(saleId) {
  return (
    db
      .prepare(
        `SELECT * FROM debt_transactions
          WHERE reference_type = 'ORDER' AND reference_id = ?
            AND transaction_type = 'ORDER_DEBT'
          ORDER BY id DESC LIMIT 1`
      )
      .get(String(saleId)) || null
  );
}

/**
 * Đơn này có phải "bán chịu" không?
 *
 * Nguồn tín hiệu (theo thứ tự ưu tiên):
 *  1. `sales.is_credit = 1` — cờ bền vững được lưu lúc tạo đơn (migration 054)
 *  2. Có bút toán ORDER_DEBT trong ledger (đơn đã ghi nợ trước đó)
 *  3. Có dòng trong `order_debts` (bảng chiếu — đơn cũ đã ghi nợ)
 *
 * Ngoài ra, nếu setting `debt_auto_record_on_delivered = 1` thì mọi đơn đã
 * giao mà KHÔNG có tín hiệu thanh toán cũng được coi là bán chịu (chế độ tự
 * động — mặc định TẮT để tránh ghi nợ nhầm cho đơn thu tiền).
 */
function isCreditSale(saleId) {
  const sale = getSale(saleId);
  if (!sale) return false;
  if (sale.is_credit === 1) return true;
  if (findActiveOrderDebt(saleId)) return true;
  const proj = db.prepare('SELECT id FROM order_debts WHERE sale_id = ?').get(saleId);
  if (proj) return true;

  // Chế độ tự động: đơn đã giao mà chưa có thanh toán nào gắn với đơn
  const autoSetting = db
    .prepare("SELECT value FROM settings WHERE key = 'debt_auto_record_on_delivered'")
    .get();
  if (autoSetting && String(autoSetting.value) === '1') {
    const paid = db
      .prepare(
        `SELECT COUNT(*) AS c FROM debt_transactions
          WHERE reference_type = 'ORDER' AND reference_id = ?
            AND transaction_type = 'PAYMENT'`
      )
      .get(String(saleId))?.c;
    return !paid;
  }

  return false;
}

/**
 * GHI CÔNG NỢ khi đơn hàng được giao thành công (DELIVERED sạch).
 *
 * @param {number} saleId
 * @param {object} [opts]
 * @param {string} [opts.actor]      - username người thực hiện (tài xế / hệ thống)
 * @param {string} [opts.source]     - SOURCES.*
 * @param {boolean} [opts.force]     - bỏ qua kiểm tra cờ bán chịu (dùng cho đối soát)
 * @param {boolean} [opts.dryRun]
 * @returns {{success:boolean, skipped?:boolean, reason?:string, transactionId?:number,
 *            amountOwed?:number, balanceBefore?:number, balanceAfter?:number}}
 */
function recordOrderDebtOnDelivered(saleId, opts = {}) {
  const id = parseInt(saleId, 10);
  if (!id || Number.isNaN(id)) {
    return { success: false, error: 'saleId không hợp lệ' };
  }

  const sale = getSale(id);
  if (!sale) return { success: false, error: 'Không tìm thấy đơn hàng' };

  // 1. Đơn phải còn hiệu lực
  if (sale.archived === 1 || sale.deleted === 1) {
    return { success: true, skipped: true, reason: 'Đơn đã bị xoá/lưu trữ' };
  }
  if (sale.type && sale.type !== 'sale') {
    return { success: true, skipped: true, reason: `Không phải đơn bán (type=${sale.type})` };
  }

  // 2. Phải có khách hàng
  if (!sale.customer_id) {
    return { success: true, skipped: true, reason: 'Đơn không thuộc khách hàng nào' };
  }
  if (sale.customer_archived === 1) {
    return { success: true, skipped: true, reason: 'Khách hàng đã bị lưu trữ' };
  }

  // 3. Phải là đơn bán chịu (trừ khi force)
  if (!opts.force && !isCreditSale(id)) {
    return { success: true, skipped: true, reason: 'Đơn không phải bán chịu' };
  }

  // 4. Đã ghi nợ cho đơn này rồi → idempotent (KHÔNG ghi lại)
  const existing = findActiveOrderDebt(id);
  if (existing) {
    return {
      success: true,
      skipped: true,
      reason: 'Đơn đã có bút toán ORDER_DEBT',
      transactionId: existing.id,
      amountOwed: existing.amount,
      balanceAfter: existing.balance_after,
    };
  }

  // 5. Tính số tiền khách thực sự còn phải trả
  const owed = computeAmountOwed(id, sale.customer_id);
  if (owed.amountOwed <= 0) {
    return {
      success: true,
      skipped: true,
      reason: 'Khách không còn nợ cho đơn này (đã thanh toán đủ)',
      amountOwed: 0,
      breakdown: owed.breakdown,
    };
  }

  if (opts.dryRun) {
    return {
      success: true,
      skipped: false,
      dryRun: true,
      amountOwed: owed.amountOwed,
      breakdown: owed.breakdown,
    };
  }

  // 6. Ghi bút toán (idempotent theo saleId)
  const result = DebtLedgerService.recordTransaction({
    customerId: sale.customer_id,
    transactionType: TRANSACTION_TYPES.ORDER_DEBT,
    amount: owed.amountOwed,
    direction: DebtLedgerService.DIRECTION.INCREASE,
    referenceType: REFERENCE_TYPES.ORDER,
    referenceId: String(id),
    description: `Phát sinh công nợ đơn hàng #${id} (${sale.customer_name || ''})`.trim(),
    createdBy: opts.actor || 'system',
    source: opts.source || SOURCES.POS,
    idempotencyKey: orderDebtKey(id),
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  // 7. Cập nhật bảng chiếu `order_debts` (cho UI cũ) + trạng thái thanh toán
  try {
    const proj = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(id);
    if (proj) {
      const newPaid = Math.min(proj.original_amount, proj.paid_amount || 0);
      const newRemaining = Math.max(0, proj.original_amount - newPaid);
      const status = newRemaining <= 0 ? 'paid' : 'partial';
      db.prepare(
        `UPDATE order_debts
            SET original_amount = ?, remaining_amount = ?, status = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(proj.original_amount, newRemaining, status, proj.id);
    } else {
      db.prepare(
        `INSERT INTO order_debts
           (sale_id, customer_id, original_amount, paid_amount, remaining_amount, status)
         VALUES (?, ?, ?, 0, ?, 'pending')`
      ).run(id, sale.customer_id, owed.amountOwed, owed.amountOwed);
    }
    db.prepare("UPDATE sales SET payment_status = 'unpaid' WHERE id = ? AND payment_status = 'unpaid'").run(
      id
    );
  } catch (e) {
    logger.error('[DEBT_ORDER] update projection error', { saleId: id, error: e.message });
  }

  // 8. Đánh dấu event đã xử lý (chống xử lý lại sau restart)
  try {
    DebtLedgerService.markEventProcessed(EVENT_TYPES.ORDER_DELIVERED, String(id));
  } catch (_) {
    /* ignore */
  }

  logger.info('[DEBT_ORDER] Recorded ORDER_DEBT', {
    saleId: id,
    customerId: sale.customer_id,
    amount: owed.amountOwed,
    balanceAfter: result.balanceAfter,
  });

  return {
    success: true,
    skipped: false,
    transactionId: result.transactionId,
    duplicate: !!result.duplicate,
    amountOwed: owed.amountOwed,
    balanceBefore: result.balanceBefore,
    balanceAfter: result.balanceAfter,
    breakdown: owed.breakdown,
  };
}

/**
 * Hook gọi khi trạng thái giao hàng thay đổi.
 *
 * @param {object} params
 * @param {number} params.saleId
 * @param {string} params.toStatus   - trạng thái MỚI
 * @param {string} [params.fromStatus]
 * @param {string} [params.actor]
 * @returns {object} kết quả (luôn trả về, không throw — lỗi không được làm hỏng
 *                    luồng giao hàng)
 */
function onDeliveryStatusChanged(params = {}) {
  const { saleId, toStatus, fromStatus, actor } = params;

  try {
    if (!saleId || !toStatus) return { success: false, error: 'Thiếu saleId hoặc toStatus' };

    // Chỉ xử lý khi chuyển sang DELIVERED
    if (toStatus !== CLEAN_DELIVERED_STATUS) {
      return { success: true, skipped: true, reason: `Trạng thái ${toStatus} không ghi công nợ` };
    }

    // Đã DELIVERED rồi thì không xử lý lại (chống giao nhiều lần)
    if (fromStatus === CLEAN_DELIVERED_STATUS) {
      return { success: true, skipped: true, reason: 'Đơn đã ở trạng thái DELIVERED' };
    }

    return recordOrderDebtOnDelivered(saleId, {
      actor,
      source: SOURCES.POS,
    });
  } catch (e) {
    logger.error('[DEBT_ORDER] onDeliveryStatusChanged error', {
      saleId,
      toStatus,
      error: e.message,
    });
    return { success: false, error: e.message };
  }
}

/**
 * Đơn hàng thay đổi SAU khi đã ghi công nợ (sửa tổng, trả hàng) →
 * tạo bút toán ADJUSTMENT (không xoá bút toán gốc).
 *
 * @param {number} saleId
 * @param {object} opts { actor, reason, force }
 */
function adjustOrderDebtAfterChange(saleId, opts = {}) {
  const id = parseInt(saleId, 10);
  if (!id || Number.isNaN(id)) return { success: false, error: 'saleId không hợp lệ' };

  const sale = getSale(id);
  if (!sale) return { success: false, error: 'Không tìm thấy đơn hàng' };
  if (!sale.customer_id) return { success: true, skipped: true, reason: 'Đơn không có khách hàng' };

  const original = findActiveOrderDebt(id);
  if (!original) {
    return { success: true, skipped: true, reason: 'Đơn chưa có bút toán ORDER_DEBT' };
  }

  const owed = computeAmountOwed(id, sale.customer_id);
  const currentAmount = original.amount;
  const diff = owed.amountOwed - currentAmount;

  if (Math.abs(diff) < 0.01) {
    return {
      success: true,
      skipped: true,
      reason: 'Số dư công nợ của đơn không thay đổi',
      transactionId: original.id,
      amountOwed: owed.amountOwed,
    };
  }

  const result = DebtLedgerService.adjust(sale.customer_id, diff, {
    createdBy: opts.actor || 'system',
    source: opts.source || SOURCES.POS,
    reason: opts.reason || `Điều chỉnh công nợ đơn hàng #${id}`,
    referenceType: REFERENCE_TYPES.ORDER,
    referenceId: String(id),
    idempotencyKey: opts.idempotencyKey || null,
  });

  if (!result.success) return { success: false, error: result.error };

  return {
    success: true,
    skipped: false,
    transactionId: result.transactionId,
    diff,
    amountOwed: owed.amountOwed,
    balanceAfter: result.balanceAfter,
  };
}

/**
 * Đơn hàng bị HỦY / XOÁ sau khi đã ghi công nợ →
 * tạo bút toán REVERSAL (giữ nguyên bút toán gốc).
 */
function reverseOrderDebt(saleId, opts = {}) {
  const id = parseInt(saleId, 10);
  if (!id || Number.isNaN(id)) return { success: false, error: 'saleId không hợp lệ' };

  const original = findActiveOrderDebt(id);
  if (!original) {
    return { success: true, skipped: true, reason: 'Đơn chưa có bút toán ORDER_DEBT' };
  }

  // Đã đảo rồi → không đảo lần 2
  const alreadyReversed = db
    .prepare(
      `SELECT id FROM debt_transactions
        WHERE reference_type = 'ORDER' AND reference_id = ?
          AND transaction_type = 'REVERSAL'`
    )
    .get(String(id));
  if (alreadyReversed && !opts.force) {
    return { success: true, skipped: true, reason: 'Đơn đã được đảo công nợ trước đó' };
  }

  const result = DebtLedgerService.reverseTransaction(original.id, {
    createdBy: opts.actor || 'system',
    source: opts.source || SOURCES.POS,
    reason: opts.reason || `Huỷ đơn hàng #${id}, hoàn công nợ`,
  });

  if (!result.success) return { success: false, error: result.error };

  return {
    success: true,
    skipped: false,
    transactionId: result.transactionId,
    originalTransactionId: original.id,
    refundedAmount: original.amount,
    balanceAfter: result.balanceAfter,
  };
}

/**
 * Danh sách đơn đã DELIVERED nhưng CHƯA có bút toán ORDER_DEBT (dùng cho đối soát).
 */
function listDeliveredWithoutDebt(limit = 200) {
  return db
    .prepare(
      `SELECT s.id AS sale_id, s.customer_id, s.total, s.payment_status,
              s.delivery_status, s.date, s.is_credit,
              c.name AS customer_name
         FROM sales s
         JOIN customers c ON c.id = s.customer_id
        WHERE s.type = 'sale'
          AND s.archived = 0
          AND s.deleted = 0
          AND s.delivery_status = 'DELIVERED'
          AND NOT EXISTS (
            SELECT 1 FROM debt_transactions dt
             WHERE dt.reference_type = 'ORDER'
               AND dt.reference_id = CAST(s.id AS TEXT)
               AND dt.transaction_type = 'ORDER_DEBT'
          )
        ORDER BY s.date DESC, s.id DESC
        LIMIT ?`
    )
    .all(limit);
}

module.exports = {
  CLEAN_DELIVERED_STATUS,
  orderDebtKey,
  getSale,
  computeAmountOwed,
  findActiveOrderDebt,
  isCreditSale,
  recordOrderDebtOnDelivered,
  onDeliveryStatusChanged,
  adjustOrderDebtAfterChange,
  reverseOrderDebt,
  listDeliveredWithoutDebt,
};
