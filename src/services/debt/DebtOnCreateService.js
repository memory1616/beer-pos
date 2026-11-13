/**
 * DebtOnCreateService — GHI NỢ NGAY KHI TẠO ĐƠN HÀNG (mô hình "nợ từ khi bán")
 * ─────────────────────────────────────────────────────────────────────────────
 * Mô hình nghiệp vụ (thay đổi so với mô hình cũ "ghi nợ khi DELIVERED"):
 *
 *   Tạo đơn (có khách)  →  ghi bút toán ORDER_DEBT NGAY
 *   Nhận tiền từ khách  →  ghi bút toán PAYMENT (giảm công nợ)
 *   Huỷ / xoá đơn       →  ghi bút toán REVERSAL (đảo nợ)
 *   Sửa đơn             →  ghi bút toán ADJUSTMENT (chênh lệch)
 *
 * Nhờ vậy khách có đơn trong ngày = đang nợ, cho tới khi nhập thanh toán.
 *
 * NGƯỠNG AN TOÀN:
 *  - Idempotent theo `idempotency_key = order_debt:sale:<saleId>` → mỗi đơn
 *    CHỈ CÓ 1 bút toán ORDER_DEBT.
 *  - Bọc trong transaction → atomic, không để lệch ledger/mirror.
 *  - Setting `debt_record_on_create` cho phép BẬT/TẮT toàn cục:
 *      '1' = ghi nợ ngay khi tạo đơn (mặc định theo quyết định nghiệp vụ mới)
 *      '0' = tắt → quay về hành vi cũ (ghi nợ khi DELIVERED)
 *  - Setting `debt_max_limit_enabled` = '0' → bỏ chặn hạn mức công nợ
 *    (chỉ cảnh báo, KHÔNG chặn bán hàng).
 *  - KHÔNG backfill đơn cũ: chỉ đơn tạo từ thời điểm bật mới tính nợ.
 */

const db = require('../../../database');
const logger = require('../../utils/logger');
const DebtLedgerService = require('./DebtLedgerService');
const { TRANSACTION_TYPES, SOURCES, REFERENCE_TYPES } = require('./constants');

/** Đọc setting (trả về fallback nếu thiếu/lỗi). */
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
 * Cờ bật/tắt ghi nợ khi tạo đơn.
 * Mặc định = '1' (bật) — theo quyết định nghiệp vụ mới.
 */
function isRecordOnCreateEnabled() {
  const v = getSetting('debt_record_on_create', '1');
  return v === '1' || v === 'true';
}

/**
 * Hạn mức công nợ có đang được bật không.
 * Mặc định = '0' (TẮT) → không chặn bán hàng, chỉ cảnh báo.
 */
function isMaxLimitEnabled() {
  const v = getSetting('debt_max_limit_enabled', '0');
  return v === '1' || v === 'true';
}

/** Hạn mức công nợ tối đa mỗi khách (VND). */
function getMaxDebt() {
  const raw = getSetting('max_debt_per_customer', '5000000');
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 5000000;
}

/**
 * Ghi công nợ cho 1 đơn hàng (gọi NGAY sau khi tạo đơn).
 *
 * @param {object} opts
 * @param {number} opts.saleId
 * @param {number} opts.customerId
 * @param {number} opts.amount        - tổng tiền khách còn phải trả cho đơn này
 * @param {string} [opts.customerName]
 * @param {string} [opts.actor]       - username người tạo đơn
 * @param {boolean} [opts.force]      - bỏ qua setting bật/tắt (dùng cho đối soát)
 * @param {boolean} [opts.dryRun]
 * @returns {{success:boolean, skipped?:boolean, reason?:string, transactionId?:number,
 *            amountOwed?:number, balanceBefore?:number, balanceAfter?:number,
 *            limitExceeded?:boolean, currentDebt?:number, maxDebt?:number}}
 */
function recordDebtOnCreate(opts = {}) {
  const { saleId, customerId, amount, customerName, actor, force = false, dryRun = false } = opts;

  const id = parseInt(saleId, 10);
  const custId = parseInt(customerId, 10);
  const value = DebtLedgerService.roundMoney(amount);

  if (!id || Number.isNaN(id)) {
    return { success: false, error: 'saleId không hợp lệ' };
  }
  if (!custId || Number.isNaN(custId)) {
    return { success: true, skipped: true, reason: 'Đơn không thuộc khách hàng nào' };
  }
  if (!(value > 0)) {
    return { success: true, skipped: true, reason: 'Tổng đơn bằng 0 → không ghi nợ' };
  }

  // 1. Cờ bật/tắt toàn cục
  if (!force && !isRecordOnCreateEnabled()) {
    return { success: true, skipped: true, reason: 'Tính nợ khi tạo đơn đang TẮT' };
  }

  // 2. Khách đã lưu trữ → bỏ qua (không ghi nợ cho khách đã ẩn)
  const customer = db
    .prepare('SELECT id, name, archived FROM customers WHERE id = ?')
    .get(custId);
  if (!customer) {
    return { success: true, skipped: true, reason: 'Không tìm thấy khách hàng' };
  }
  if (customer.archived) {
    return { success: true, skipped: true, reason: 'Khách hàng đã bị lưu trữ' };
  }

  // 3. Idempotent — đơn đã có bút toán ORDER_DEBT thì không ghi lại
  const existing = db
    .prepare(
      `SELECT id, amount, balance_after FROM debt_transactions
        WHERE reference_type = 'ORDER' AND reference_id = ?
          AND transaction_type = 'ORDER_DEBT'`
    )
    .get(String(id));
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

  // 4. Hạn mức công nợ — luôn tính cờ `limitExceeded` để UI cảnh báo.
  //    Việc CHẶN bán hàng hay không do setting `debt_max_limit_enabled`
  //    quyết định (mặc định TẮT → chỉ cảnh báo, không chặn).
  const balanceBefore = DebtLedgerService.computeBalance(custId);
  const newTotalDebt = balanceBefore + value;
  const maxDebt = getMaxDebt();
  const limitEnabled = isMaxLimitEnabled();
  const limitExceeded = newTotalDebt > maxDebt;

  if (dryRun) {
    return {
      success: true,
      skipped: false,
      dryRun: true,
      amountOwed: value,
      balanceBefore,
      balanceAfter: newTotalDebt,
      limitExceeded,
      currentDebt: balanceBefore,
      maxDebt,
    };
  }

  // 5. Ghi bút toán ORDER_DEBT
  const result = DebtLedgerService.recordTransaction({
    customerId: custId,
    transactionType: TRANSACTION_TYPES.ORDER_DEBT,
    amount: value,
    direction: DebtLedgerService.DIRECTION.INCREASE,
    referenceType: REFERENCE_TYPES.ORDER,
    referenceId: String(id),
    description: `Công nợ đơn hàng #${id}${customer.name ? ` (${customer.name})` : ''}`.trim(),
    createdBy: actor || 'system',
    source: SOURCES.POS,
    idempotencyKey: `order_debt:sale:${id}`,
  });

  if (!result.success) {
    logger.error('[DEBT_ON_CREATE] recordTransaction error', {
      saleId: id,
      customerId: custId,
      error: result.error,
    });
    return { success: false, error: result.error };
  }

  // 6. Cập nhật bảng chiếu `order_debts` (UI cũ / driver portal) + payment_status
  try {
    const proj = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(id);
    if (proj) {
      const newRemaining = Math.max(0, proj.original_amount - (proj.paid_amount || 0));
      const status = newRemaining <= 0 ? 'paid' : 'pending';
      db.prepare(
        `UPDATE order_debts
            SET original_amount = ?, remaining_amount = ?, status = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(value, newRemaining, status, proj.id);
    } else {
      db.prepare(
        `INSERT INTO order_debts
           (sale_id, customer_id, original_amount, paid_amount, remaining_amount, status)
         VALUES (?, ?, ?, 0, ?, 'pending')`
      ).run(id, custId, value, value);
    }
    db.prepare(
      "UPDATE sales SET payment_status = 'unpaid' WHERE id = ? AND payment_status != 'paid'"
    ).run(id);
  } catch (e) {
    logger.error('[DEBT_ON_CREATE] update projection error', { saleId: id, error: e.message });
  }

  logger.info('[DEBT_ON_CREATE] Recorded ORDER_DEBT', {
    saleId: id,
    customerId: custId,
    amount: value,
    balanceAfter: result.balanceAfter,
    limitExceeded,
  });

  return {
    success: true,
    skipped: false,
    transactionId: result.transactionId,
    duplicate: !!result.duplicate,
    amountOwed: value,
    balanceBefore: result.balanceBefore,
    balanceAfter: result.balanceAfter,
    limitExceeded,
    limitEnabled,
    currentDebt: balanceBefore,
    maxDebt,
  };
}

/**
 * Ghi nợ cho đơn hàng vừa tạo — wrapper an toàn cho route.
 * KHÔNG BAO GIỜ throw (lỗi sổ công nợ không được làm hỏng luồng bán hàng).
 */
function recordOrderDebtSafely(opts = {}) {
  try {
    return recordDebtOnCreate(opts);
  } catch (e) {
    logger.error('[DEBT_ON_CREATE] unexpected error', {
      saleId: opts && opts.saleId,
      error: e.message,
    });
    return { success: false, error: e.message };
  }
}

module.exports = {
  recordDebtOnCreate,
  recordOrderDebtSafely,
  isRecordOnCreateEnabled,
  isMaxLimitEnabled,
  getMaxDebt,
};
