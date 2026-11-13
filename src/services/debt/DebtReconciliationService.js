/**
 * DebtReconciliationService — Đối soát Sổ công nợ với đơn hàng
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu (theo yêu cầu nghiệp vụ mục 8E):
 *  1. Đối chiếu đơn hàng DELIVERED với bút toán ORDER_DEBT.
 *  2. Phát hiện đơn THIẾU bút toán.
 *  3. Phát hiện giao dịch TRÙNG (cùng idempotency key / cùng đơn).
 *  4. Phát hiện số dư KHÔNG KHỚP (ledger vs `customers.debt` mirror vs
 *     `order_debts` projection).
 *  5. Cho phép xử lý (ghi bút toán bù / đồng bộ) — LUÔN kèm audit log.
 *
 * Nguyên tắc:
 *  - KHÔNG xoá dữ liệu. Mọi "sửa" đều là bút toán MỚI (append-only).
 *  - Mỗi lần xử lý đều ghi vào `debt_audit_logs` với action RECONCILE_FIX.
 *  - Hàm `run()` mặc định CHỈ ĐỌC (dry-run) → an toàn để gọi tự động.
 */

const db = require('../../../database');
const logger = require('../../utils/logger');
const DebtLedgerService = require('./DebtLedgerService');
const DebtAuditService = require('./DebtAuditService');
const DebtOrderIntegration = require('./DebtOrderIntegration');
const { SOURCES, AUDIT_ACTIONS } = require('./constants');

// ── Loại lỗi đối soát ────────────────────────────────────────────────────────
const ISSUE_TYPES = {
  MISSING_ORDER_DEBT: 'MISSING_ORDER_DEBT', // Đơn DELIVERED nhưng thiếu bút toán
  DUPLICATE_ORDER_DEBT: 'DUPLICATE_ORDER_DEBT', // 1 đơn có >1 ORDER_DEBT hiệu lực
  MISMATCH_MIRROR: 'MISMATCH_MIRROR', // `customers.debt` lệch với ledger
  MISMATCH_ORDER_PROJECTION: 'MISMATCH_ORDER_PROJECTION', // `order_debts` lệch
  DUPLICATE_IDEMPOTENCY: 'DUPLICATE_IDEMPOTENCY', // vi phạm unique (không xảy ra vì UNIQUE index)
  ORPHAN_TRANSACTION: 'ORPHAN_TRANSACTION', // bút toán trỏ tới khách không tồn tại
};

const ISSUE_SEVERITY = {
  [ISSUE_TYPES.MISSING_ORDER_DEBT]: 'warning',
  [ISSUE_TYPES.DUPLICATE_ORDER_DEBT]: 'critical',
  [ISSUE_TYPES.MISMATCH_MIRROR]: 'warning',
  [ISSUE_TYPES.MISMATCH_ORDER_PROJECTION]: 'info',
  [ISSUE_TYPES.DUPLICATE_IDEMPOTENCY]: 'critical',
  [ISSUE_TYPES.ORPHAN_TRANSACTION]: 'critical',
};

/**
 * 1. Đơn DELIVERED nhưng CHƯA có bút toán ORDER_DEBT.
 */
function findMissingOrderDebts(limit = 200) {
  try {
    const rows = DebtOrderIntegration.listDeliveredWithoutDebt(limit);
    return rows.map((r) => ({
      type: ISSUE_TYPES.MISSING_ORDER_DEBT,
      severity: ISSUE_SEVERITY[ISSUE_TYPES.MISSING_ORDER_DEBT],
      saleId: r.sale_id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      amount: r.total,
      message: `Đơn #${r.sale_id} đã giao (DELIVERED) nhưng chưa có bút toán ORDER_DEBT`,
    }));
  } catch (e) {
    logger.error('[DEBT_RECON] findMissingOrderDebts error', { error: e.message });
    return [];
  }
}

/**
 * 2. Đơn có NHIỀU HƠN 1 bút toán ORDER_DEBT đang hiệu lực (vi phạm ràng buộc).
 */
function findDuplicateOrderDebts() {
  try {
    const rows = db
      .prepare(
        `SELECT reference_id AS sale_id,
                customer_id,
                COUNT(*) AS cnt,
                SUM(amount) AS total_amount
           FROM debt_transactions
          WHERE transaction_type = 'ORDER_DEBT'
            AND reference_type = 'ORDER'
            AND direction = 'INCREASE'
          GROUP BY reference_id, customer_id
         HAVING cnt > 1`
      )
      .all();

    return rows.map((r) => ({
      type: ISSUE_TYPES.DUPLICATE_ORDER_DEBT,
      severity: ISSUE_SEVERITY[ISSUE_TYPES.DUPLICATE_ORDER_DEBT],
      saleId: parseInt(r.sale_id, 10),
      customerId: r.customer_id,
      amount: r.total_amount,
      message: `Đơn #${r.sale_id} có ${r.cnt} bút toán ORDER_DEBT (vi phạm ràng buộc 1 đơn = 1 bút toán)`,
    }));
  } catch (e) {
    logger.error('[DEBT_RECON] findDuplicateOrderDebts error', { error: e.message });
    return [];
  }
}

/**
 * 3. Số dư `customers.debt` (mirror) lệch với ledger.
 */
function findMirrorMismatches(limit = 500) {
  try {
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.debt AS mirror_debt,
                COALESCE(SUM(CASE WHEN dt.direction = 'INCREASE'
                                 THEN dt.amount ELSE -dt.amount END), 0) AS ledger_balance
           FROM customers c
           LEFT JOIN debt_transactions dt ON dt.customer_id = c.id
          WHERE c.archived = 0
          GROUP BY c.id
         HAVING ABS(COALESCE(c.debt, 0) - ledger_balance) > 0.5
          LIMIT ?`
      )
      .all(limit);

    return rows.map((r) => ({
      type: ISSUE_TYPES.MISMATCH_MIRROR,
      severity: ISSUE_SEVERITY[ISSUE_TYPES.MISMATCH_MIRROR],
      customerId: r.id,
      customerName: r.name,
      mirrorDebt: DebtLedgerService.roundMoney(r.mirror_debt || 0),
      ledgerBalance: DebtLedgerService.roundMoney(r.ledger_balance),
      diff: DebtLedgerService.roundMoney((r.mirror_debt || 0) - r.ledger_balance),
      message: `Số dư khách #${r.id} lệch ${DebtLedgerService.roundMoney(
        (r.mirror_debt || 0) - r.ledger_balance
      ).toLocaleString('vi-VN')}đ giữa sổ công nợ và dữ liệu POS`,
    }));
  } catch (e) {
    logger.error('[DEBT_RECON] findMirrorMismatches error', { error: e.message });
    return [];
  }
}

/**
 * 4. Bảng chiếu `order_debts` lệch với ledger (số dư còn phải thu của 1 đơn).
 */
function findOrderProjectionMismatches(limit = 200) {
  try {
    const rows = db
      .prepare(
        `SELECT od.id, od.sale_id, od.customer_id, od.original_amount,
                od.remaining_amount, od.status,
                c.name AS customer_name,
                COALESCE((SELECT SUM(amount) FROM debt_transactions dt
                           WHERE dt.reference_type = 'ORDER'
                             AND dt.reference_id = CAST(od.sale_id AS TEXT)
                             AND dt.transaction_type = 'ORDER_DEBT'
                             AND dt.direction = 'INCREASE'), 0) AS ledger_debt,
                COALESCE((SELECT SUM(amount) FROM debt_transactions dt
                           WHERE dt.reference_type = 'ORDER'
                             AND dt.reference_id = CAST(od.sale_id AS TEXT)
                             AND dt.transaction_type = 'PAYMENT'
                             AND dt.direction = 'DECREASE'), 0) AS ledger_paid
           FROM order_debts od
           LEFT JOIN customers c ON c.id = od.customer_id
          WHERE ABS(od.original_amount - ledger_debt) > 0.5
          LIMIT ?`
      )
      .all(limit);

    return rows.map((r) => ({
      type: ISSUE_TYPES.MISMATCH_ORDER_PROJECTION,
      severity: ISSUE_SEVERITY[ISSUE_TYPES.MISMATCH_ORDER_PROJECTION],
      customerId: r.customer_id,
      customerName: r.customer_name,
      saleId: r.sale_id,
      amount: r.original_amount,
      ledgerAmount: DebtLedgerService.roundMoney(r.ledger_debt),
      message: `Đơn #${r.sale_id} ghi nhận nợ ${r.original_amount?.toLocaleString(
        'vi-VN'
      )}đ trong bảng chiếu nhưng sổ công nợ ghi ${DebtLedgerService.roundMoney(
        r.ledger_debt
      ).toLocaleString('vi-VN')}đ`,
    }));
  } catch (e) {
    logger.error('[DEBT_RECON] findOrderProjectionMismatches error', { error: e.message });
    return [];
  }
}

/**
 * 5. Bút toán trỏ tới khách hàng không tồn tại (orphaned).
 */
function findOrphanTransactions() {
  try {
    const rows = db
      .prepare(
        `SELECT dt.id, dt.customer_id, dt.transaction_type, dt.amount
           FROM debt_transactions dt
           LEFT JOIN customers c ON c.id = dt.customer_id
          WHERE c.id IS NULL`
      )
      .all();

    return rows.map((r) => ({
      type: ISSUE_TYPES.ORPHAN_TRANSACTION,
      severity: ISSUE_SEVERITY[ISSUE_TYPES.ORPHAN_TRANSACTION],
      transactionId: r.id,
      customerId: r.customer_id,
      amount: r.amount,
      message: `Bút toán #${r.id} trỏ tới khách hàng #${r.customer_id} không tồn tại`,
    }));
  } catch (e) {
    logger.error('[DEBT_RECON] findOrphanTransactions error', { error: e.message });
    return [];
  }
}

/**
 * Chạy toàn bộ kiểm tra đối soát.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.apply] - true ⇒ tự động xử lý lỗi an toàn (ghi bút toán bù).
 * @param {string}  [opts.actor]  - username người thực hiện
 * @returns {{ok:boolean, summary:object, issues:Array, fixed:Array}}
 */
function run(opts = {}) {
  const apply = !!opts.apply;
  const actor = opts.actor || 'system';

  const issues = []
    .concat(findMissingOrderDebts())
    .concat(findDuplicateOrderDebts())
    .concat(findMirrorMismatches())
    .concat(findOrderProjectionMismatches())
    .concat(findOrphanTransactions());

  const fixed = [];

  if (apply) {
    for (const issue of issues) {
      if (issue.type !== ISSUE_TYPES.MISSING_ORDER_DEBT) continue;

      // Chỉ ghi bù khi đơn thực sự còn nợ (không thanh toán đủ)
      const result = DebtOrderIntegration.recordOrderDebtOnDelivered(issue.saleId, {
        actor,
        source: SOURCES.RECONCILIATION,
        force: true,
      });

      if (result.success && !result.skipped) {
        fixed.push({ issue, transactionId: result.transactionId });
        DebtAuditService.record({
          transactionId: result.transactionId,
          action: AUDIT_ACTIONS.RECONCILE_FIX,
          actorId: actor,
          beforeData: { saleId: issue.saleId, hadOrderDebt: false },
          afterData: {
            saleId: issue.saleId,
            amount: result.amountOwed,
            balanceAfter: result.balanceAfter,
          },
        });
      }
    }

    // Đồng bộ mirror `customers.debt` theo ledger (KHÔNG ghi bút toán — chỉ sửa mirror)
    for (const issue of issues) {
      if (issue.type !== ISSUE_TYPES.MISMATCH_MIRROR) continue;
      const balance = DebtLedgerService.computeBalance(issue.customerId);
      db.prepare('UPDATE customers SET debt = ? WHERE id = ?').run(balance, issue.customerId);
      DebtAuditService.record({
        action: AUDIT_ACTIONS.RECONCILE_FIX,
        actorId: actor,
        beforeData: { customerId: issue.customerId, mirrorDebt: issue.mirrorDebt },
        afterData: { customerId: issue.customerId, mirrorDebt: balance, synced: true },
      });
      fixed.push({ issue, action: 'sync_mirror' });
    }
  }

  const summary = {
    total: issues.length,
    critical: issues.filter((i) => i.severity === 'critical').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
    info: issues.filter((i) => i.severity === 'info').length,
    missingOrderDebt: issues.filter((i) => i.type === ISSUE_TYPES.MISSING_ORDER_DEBT).length,
    duplicateOrderDebt: issues.filter((i) => i.type === ISSUE_TYPES.DUPLICATE_ORDER_DEBT).length,
    mismatchMirror: issues.filter((i) => i.type === ISSUE_TYPES.MISMATCH_MIRROR).length,
    mismatchProjection: issues.filter((i) => i.type === ISSUE_TYPES.MISMATCH_ORDER_PROJECTION).length,
    orphan: issues.filter((i) => i.type === ISSUE_TYPES.ORPHAN_TRANSACTION).length,
    fixed: fixed.length,
    applied: apply,
  };

  logger.info('[DEBT_RECON] Reconcile run', summary);
  return { ok: true, summary, issues, fixed };
}

/**
 * Đối chiếu TỪNG khách: ledger vs mirror vs tổng chiếu `order_debts`.
 * @param {number} customerId
 */
function reconcileCustomer(customerId) {
  const custId = parseInt(customerId, 10);
  if (!custId || Number.isNaN(custId)) {
    return { success: false, error: 'customerId không hợp lệ' };
  }

  const customer = db.prepare('SELECT id, name, debt FROM customers WHERE id = ?').get(custId);
  if (!customer) return { success: false, error: 'Không tìm thấy khách hàng' };

  const breakdown = DebtLedgerService.getBalanceBreakdown(custId);
  const projection = db
    .prepare(
      `SELECT COALESCE(SUM(original_amount), 0) AS total_debt,
              COALESCE(SUM(paid_amount), 0) AS total_paid,
              COALESCE(SUM(remaining_amount), 0) AS total_remaining,
              COUNT(*) AS cnt
         FROM order_debts WHERE customer_id = ?`
    )
    .get(custId);

  const rows = {
    customer: { id: customer.id, name: customer.name, mirrorDebt: customer.debt || 0 },
    ledger: breakdown,
    projection,
    checks: {
      mirrorMatches: Math.abs((customer.debt || 0) - breakdown.balance) <= 0.5,
      projectionMatches:
        Math.abs((projection.total_debt || 0) - (breakdown.orderDebt || 0)) <= 0.5,
    },
  };

  return { success: true, data: rows };
}

module.exports = {
  ISSUE_TYPES,
  ISSUE_SEVERITY,
  run,
  reconcileCustomer,
  findMissingOrderDebts,
  findDuplicateOrderDebts,
  findMirrorMismatches,
  findOrderProjectionMismatches,
  findOrphanTransactions,
};
