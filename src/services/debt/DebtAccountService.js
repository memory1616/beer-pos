/**
 * DebtAccountService — Tài khoản công nợ & công nợ đầu kỳ
 * ─────────────────────────────────────────────────────────────────────────────
 * Trách nhiệm:
 *  1. Tạo/lấy tài khoản công nợ của khách hàng (1 account / khách).
 *  2. Thiết lập công nợ đầu kỳ (`OPENING_BALANCE`) — có audit log.
 *  3. Migrate số dư công nợ cũ (`customers.debt`) vào ledger — IDEMPOTENT,
 *     giữ nguyên giá trị `customers.debt` để không mất tiền và không phá UI.
 */

const db = require('../../../database');
const logger = require('../../utils/logger');
const {
  TRANSACTION_TYPES,
  SOURCES,
  REFERENCE_TYPES,
  EVENT_TYPES,
  ACCOUNT_STATUS,
} = require('./constants');
const DebtLedgerService = require('./DebtLedgerService');
const DebtAuditService = require('./DebtAuditService');

/**
 * Thiết lập công nợ đầu kỳ cho 1 khách.
 * Nếu đã có bút toán OPENING_BALANCE → không ghi lại (idempotent).
 *
 * @param {number} customerId
 * @param {number} openingBalance
 * @param {object} [opts] { createdBy, source, description, idempotencyKey }
 */
function setOpeningBalance(customerId, openingBalance, opts = {}) {
  const custId = parseInt(customerId, 10);
  const amount = DebtLedgerService.roundMoney(openingBalance);
  if (!custId || Number.isNaN(custId)) {
    return { success: false, error: 'customerId không hợp lệ' };
  }

  const customer = db.prepare('SELECT id, archived FROM customers WHERE id = ?').get(custId);
  if (!customer) return { success: false, error: 'Không tìm thấy khách hàng' };
  if (customer.archived) return { success: false, error: 'Khách hàng đã bị lưu trữ' };

  const key = opts.idempotencyKey || `opening_balance:${custId}`;

  const result = DebtLedgerService.recordTransaction({
    customerId: custId,
    transactionType: TRANSACTION_TYPES.OPENING_BALANCE,
    amount: Math.abs(amount),
    direction:
      amount < 0 ? DebtLedgerService.DIRECTION.DECREASE : DebtLedgerService.DIRECTION.INCREASE,
    referenceType: REFERENCE_TYPES.NONE,
    referenceId: null,
    description:
      opts.description ||
      `Công nợ đầu kỳ: ${Math.abs(amount).toLocaleString('vi-VN')}đ`,
    createdBy: opts.createdBy || 'system',
    source: opts.source || SOURCES.MANUAL_UI,
    idempotencyKey: key,
    allowNegativeBalance: true,
  });

  if (result.success && !result.duplicate) {
    DebtAuditService.record({
      transactionId: result.transactionId,
      action: DebtAuditService.AUDIT_ACTIONS.OPENING_BALANCE_MIGRATE,
      actorId: opts.createdBy || 'system',
      beforeData: { openingBalance: 0 },
      afterData: { openingBalance: amount, balance: result.balanceAfter },
    });
  }

  return result;
}

/**
 * Tổng hợp công nợ toàn hệ thống (theo ledger).
 */
function getTotals() {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'INCREASE' THEN amount ELSE -amount END), 0) AS total_balance,
         COUNT(DISTINCT customer_id) AS customers_with_ledger,
         COUNT(*) AS tx_count
       FROM debt_transactions`
    )
    .get();

  const debtCustomers = db
    .prepare(
      `SELECT COUNT(DISTINCT customer_id) AS c
         FROM debt_transactions
        WHERE direction = 'INCREASE' AND amount > 0`
    )
    .get();

  return {
    totalBalance: DebtLedgerService.roundMoney(row.total_balance),
    customersWithLedger: row.customers_with_ledger,
    transactionCount: row.tx_count,
    customersWithDebt: debtCustomers.c,
  };
}

/**
 * MIGRATE dữ liệu cũ: chuyển `customers.debt` hiện có vào ledger dưới dạng
 * `OPENING_BALANCE`.
 *
 * - IDEMPOTENT: chạy lại không tạo bản ghi trùng (idempotency_key theo khách).
 * - KHÔNG thay đổi `customers.debt` (giá trị mirror được giữ nguyên → không mất
 *   tiền, không phá UI cũ).
 * - BỎ QUA khách đã có bút toán nào trong ledger (đã dùng hệ thống mới).
 *
 * @param {object} [opts] { actorId, dryRun }
 * @returns {{ok:boolean, migrated:number, skipped:number, total:number, errors:Array}}
 */
function migrateOpeningBalances(opts = {}) {
  const actorId = opts.actorId || 'system';
  const dryRun = !!opts.dryRun;

  // Chỉ migrate khách CHƯA có bất kỳ bút toán nào trong ledger mới.
  //
  // ⚠️ KHÔNG lọc `archived = 0`:
  //   Khách đã archive vẫn có thể còn dư nợ (tiền chưa thu). Bỏ qua họ sẽ
  //   tạo lệch giữa mirror (`customers.debt`) và ledger → đối soát báo sai.
  //   Ledger là bản ghi lịch sử: khách archive vẫn phải có bút toán mở đầu.
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.debt
         FROM customers c
        WHERE COALESCE(c.debt, 0) != 0
          AND NOT EXISTS (
            SELECT 1 FROM debt_transactions dt WHERE dt.customer_id = c.id
          )
        ORDER BY c.id`
    )
    .all();

  const summary = { ok: true, migrated: 0, skipped: 0, total: rows.length, errors: [] };

  for (const row of rows) {
    if (dryRun) {
      summary.migrated += 1;
      continue;
    }

    try {
      const result = setOpeningBalance(row.id, row.debt, {
        createdBy: actorId,
        source: SOURCES.MIGRATION,
        description: `Migrate số dư công nợ hiện có (${DebtLedgerService.roundMoney(
          row.debt
        ).toLocaleString('vi-VN')}đ) vào sổ công nợ`,
        idempotencyKey: `opening_balance:${row.id}`,
      });

      if (result.success) {
        if (result.duplicate) {
          summary.skipped += 1;
        } else {
          summary.migrated += 1;
        }
      } else {
        summary.errors.push({ customerId: row.id, name: row.name, error: result.error });
      }
    } catch (err) {
      summary.errors.push({ customerId: row.id, name: row.name, error: err.message });
    }
  }

  logger.info('[DEBT_ACCOUNT] Opening balance migration', summary);
  return summary;
}

/**
 * Đóng/mở tài khoản công nợ.
 */
function setStatus(customerId, status, actorId = null) {
  const custId = parseInt(customerId, 10);
  const valid = Object.values(ACCOUNT_STATUS);
  if (!custId || !valid.includes(status)) {
    return { success: false, error: 'Tham số không hợp lệ' };
  }
  const account = DebtLedgerService.ensureAccount(custId);
  const before = { status: account.status };
  db.prepare(
    'UPDATE debt_accounts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?'
  ).run(status, custId);
  DebtAuditService.record({
    action: 'ACCOUNT_STATUS_CHANGE',
    actorId,
    beforeData: before,
    afterData: { status },
  });
  return { success: true, customerId: custId, status };
}

/** Danh sách khách hàng chưa có tài khoản công nợ (dùng cho màn cấu hình). */
function listWithoutAccount(limit = 200) {
  return db
    .prepare(
      `SELECT c.id, c.name, c.debt
         FROM customers c
        WHERE c.archived = 0
          AND NOT EXISTS (
            SELECT 1 FROM debt_accounts da WHERE da.customer_id = c.id
          )
        ORDER BY c.name ASC
        LIMIT ?`
    )
    .all(limit);
}

module.exports = {
  setOpeningBalance,
  getTotals,
  migrateOpeningBalances,
  setStatus,
  listWithoutAccount,
};
