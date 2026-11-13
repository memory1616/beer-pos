/**
 * DebtLedgerService — SỔ CÁI CÔNG NỢ (nguồn sự thật duy nhất)
 * ─────────────────────────────────────────────────────────────────────────────
 * Nguyên tắc bất di bất dịch:
 *  1. Sổ cái là APPEND-ONLY. Không bao giờ UPDATE amount, không bao giờ
 *     DELETE một bút toán. Sai thì tạo ADJUSTMENT hoặc REVERSAL.
 *  2. Mọi lần ghi đều nằm trong MỘT `db.transaction()` → atomic.
 *  3. `idempotency_key` UNIQUE → chống ghi trùng khi webhook lặp / restart.
 *  4. `customers.debt` là MIRROR của ledger (đồng bộ 1 chiều: ledger → customers).
 *     Giữ mirror để UI cũ (customer-detail, driver portal) không bị phá.
 *
 * Công thức:
 *   Balance = Opening Balance + ORDER_DEBT + MANUAL_DEBT - PAYMENT + ADJUSTMENTS
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
const DebtAuditService = require('./DebtAuditService');

const DIRECTION = {
  INCREASE: 'INCREASE',
  DECREASE: 'DECREASE',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Lấy số dư hiện tại của tài khoản công nợ theo LEDGER (không đọc
 * `customers.debt` — đó chỉ là mirror).
 * @param {number} customerId
 * @returns {number}
 */
function computeBalance(customerId) {
  const row = db
    .prepare(
      `SELECT COALESCE(
                SUM(CASE WHEN direction = 'INCREASE' THEN amount ELSE -amount END),
                0
              ) AS balance
         FROM debt_transactions
        WHERE customer_id = ?`
    )
    .get(customerId);
  return roundMoney(row ? row.balance : 0);
}

/** Tạo tài khoản công nợ nếu chưa có (lazy, idempotent). */
function ensureAccount(customerId) {
  const existing = db
    .prepare('SELECT * FROM debt_accounts WHERE customer_id = ?')
    .get(customerId);
  if (existing) return existing;

  db.prepare(
    `INSERT OR IGNORE INTO debt_accounts (customer_id, opening_balance, status)
     VALUES (?, 0, ?)`
  ).run(customerId, ACCOUNT_STATUS.ACTIVE);

  return db
    .prepare('SELECT * FROM debt_accounts WHERE customer_id = ?')
    .get(customerId);
}

/**
 * Đồng bộ mirror `customers.debt` theo ledger.
 * Chỉ được gọi BÊN TRONG transaction của ledger.
 */
function syncMirror(customerId, balance) {
  db.prepare('UPDATE customers SET debt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(roundMoney(balance), customerId);
}

/**
 * Ghi một bút toán vào sổ cái.
 *
 * @param {object} opts
 * @param {number} opts.customerId
 * @param {string} opts.transactionType - TRANSACTION_TYPES.*
 * @param {number} opts.amount - luôn > 0
 * @param {string} opts.direction - 'INCREASE' | 'DECREASE'
 * @param {string} [opts.referenceType]
 * @param {string|number} [opts.referenceId]
 * @param {string} [opts.description]
 * @param {string} [opts.createdBy] - username nhân viên
 * @param {string} [opts.source] - SOURCES.*
 * @param {string} [opts.idempotencyKey] - UNIQUE, chống ghi trùng
 * @param {boolean} [opts.allowNegativeBalance] - cho phép âm (không dùng mặc định)
 * @param {boolean} [opts.allowArchivedCustomer] - cho phép ghi cho khách đã lưu trữ
 *   (CHỈ dùng cho migrate công nợ đầu kỳ — khách archive vẫn còn dư nợ)
 * @returns {{success:boolean, transactionId?:number, balanceBefore?:number, balanceAfter?:number, error?:string, duplicate?:boolean}}
 */
function recordTransaction(opts = {}) {
  const {
    customerId,
    transactionType,
    amount,
    direction,
    referenceType = REFERENCE_TYPES.NONE,
    referenceId = null,
    description = null,
    createdBy = null,
    source = SOURCES.POS,
    idempotencyKey = null,
    allowNegativeBalance = false,
    allowArchivedCustomer = false,
  } = opts;

  const custId = parseInt(customerId, 10);
  const value = roundMoney(amount);

  if (!custId || Number.isNaN(custId) || custId <= 0) {
    return { success: false, error: 'customerId không hợp lệ' };
  }
  if (!transactionType || !Object.values(TRANSACTION_TYPES).includes(transactionType)) {
    return { success: false, error: 'Loại bút toán không hợp lệ' };
  }
  if (!(value > 0)) {
    return { success: false, error: 'Số tiền phải lớn hơn 0' };
  }
  const dir = direction === DIRECTION.DECREASE ? DIRECTION.DECREASE : DIRECTION.INCREASE;

  const tx = db.transaction(() => {
    // 1. Khách hàng phải tồn tại và còn hoạt động
    const customer = db
      .prepare('SELECT id, name, archived FROM customers WHERE id = ?')
      .get(custId);
    if (!customer) throw new Error('Không tìm thấy khách hàng');
    if (customer.archived && !allowArchivedCustomer) {
      throw new Error('Khách hàng đã bị lưu trữ');
    }

    // 2. Idempotency — nếu key đã tồn tại thì KHÔNG ghi lại
    if (idempotencyKey) {
      const dup = db
        .prepare('SELECT * FROM debt_transactions WHERE idempotency_key = ?')
        .get(idempotencyKey);
      if (dup) {
        return {
          success: true,
          duplicate: true,
          transactionId: dup.id,
          balanceBefore: dup.balance_before,
          balanceAfter: dup.balance_after,
        };
      }
    }

    // 3. Tài khoản công nợ
    ensureAccount(custId);

    // 4. Tính số dư trước / sau
    const balanceBefore = computeBalance(custId);
    const delta = dir === DIRECTION.DECREASE ? -value : value;
    let balanceAfter = roundMoney(balanceBefore + delta);

    // 5. Chặn âm (quyết định đã chốt: KHÔNG cho trả vượt số dư nợ)
    if (balanceAfter < 0 && !allowNegativeBalance) {
      throw new Error(
        `Số tiền vượt quá công nợ hiện tại (${balanceBefore.toLocaleString('vi-VN')}đ)`
      );
    }
    if (balanceAfter < 0) balanceAfter = 0;

    // 6. Ghi bút toán
    const info = db
      .prepare(
        `INSERT INTO debt_transactions
           (customer_id, transaction_type, amount, direction,
            balance_before, balance_after, reference_type, reference_id,
            description, created_by, source, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        custId,
        transactionType,
        value,
        dir,
        balanceBefore,
        balanceAfter,
        referenceType,
        referenceId !== null && referenceId !== undefined ? String(referenceId) : null,
        description,
        createdBy,
        source,
        idempotencyKey
      );
    const transactionId = info.lastInsertRowid;

    // 7. Mirror `customers.debt`
    syncMirror(custId, balanceAfter);

  // 8. Audit log (cùng transaction)
  DebtAuditService.record({
    transactionId,
    action:
      transactionType === TRANSACTION_TYPES.ADJUSTMENT
        ? DebtAuditService.AUDIT_ACTIONS.ADJUST
        : DebtAuditService.AUDIT_ACTIONS.CREATE,
    actorId: createdBy,
    beforeData: { balance: balanceBefore, transactionType, amount: value },
    afterData: { balance: balanceAfter, transactionType, amount: value },
  });
    return {
      success: true,
      transactionId,
      balanceBefore,
      balanceAfter,
    };
  });

  try {
    return tx();
  } catch (err) {
    logger.error('[DEBT_LEDGER] recordTransaction error', {
      customerId: custId,
      transactionType,
      error: err.message,
    });
    return { success: false, error: err.message };
  }
}

/**
 * Ghi bút toán ĐẢO (reversal) cho 1 bút toán gốc.
 * Bút toán gốc KHÔNG bị xoá hay sửa.
 *
 * @param {number} originalTransactionId
 * @param {object} [opts] { createdBy, source, reason, idempotencyKey }
 */
function reverseTransaction(originalTransactionId, opts = {}) {
  const { createdBy = null, source = SOURCES.POS, reason = null } = opts;

  const original = db
    .prepare('SELECT * FROM debt_transactions WHERE id = ?')
    .get(originalTransactionId);
  if (!original) {
    return { success: false, error: 'Không tìm thấy bút toán gốc' };
  }

  // Đảo bút toán tăng → giảm; đảo bút toán giảm → tăng (trả lại tiền)
  const direction =
    original.direction === DIRECTION.DECREASE ? DIRECTION.INCREASE : DIRECTION.DECREASE;

  const idempotencyKey =
    opts.idempotencyKey || `reversal:${original.idempotency_key || original.id}`;

  const result = recordTransaction({
    customerId: original.customer_id,
    transactionType: TRANSACTION_TYPES.REVERSAL,
    amount: original.amount,
    direction,
    referenceType: original.reference_type || REFERENCE_TYPES.NONE,
    referenceId: original.reference_id,
    description:
      reason || `Đảo bút toán #${original.id} (${original.transaction_type})`,
    createdBy,
    source,
    idempotencyKey,
    allowNegativeBalance: false,
  });

  if (result.success && !result.duplicate) {
    DebtAuditService.record({
      transactionId: result.transactionId,
      action: DebtAuditService.AUDIT_ACTIONS.REVERSE,
      actorId: createdBy,
      beforeData: {
        originalTransactionId: original.id,
        originalType: original.transaction_type,
        originalAmount: original.amount,
      },
      afterData: {
        reversalTransactionId: result.transactionId,
        amount: original.amount,
        direction,
        balanceAfter: result.balanceAfter,
      },
    });
  }

  return result;
}

/**
 * Điều chỉnh công nợ (dương = tăng nợ, âm = giảm nợ).
 * Luôn tạo bút toán MỚI — không sửa bút toán cũ.
 */
function adjust(customerId, amount, opts = {}) {
  const {
    createdBy = null,
    source = SOURCES.MANUAL_UI,
    reason = 'Điều chỉnh công nợ',
    referenceType = REFERENCE_TYPES.NONE,
    referenceId = null,
    idempotencyKey = null,
  } = opts;

  const value = roundMoney(amount);
  if (!value) return { success: false, error: 'Số tiền điều chỉnh không hợp lệ' };

  const direction = value > 0 ? DIRECTION.INCREASE : DIRECTION.DECREASE;

  return recordTransaction({
    customerId,
    transactionType: TRANSACTION_TYPES.ADJUSTMENT,
    amount: Math.abs(value),
    direction,
    referenceType,
    referenceId,
    description: `${reason}${value > 0 ? ' (+' : ' ('}${Math.abs(value).toLocaleString('vi-VN')}đ)`,
    createdBy,
    source,
    idempotencyKey,
    allowNegativeBalance: false,
  });
}

/**
 * Ghi event đã xử lý — chống xử lý lại (webhook lặp, restart server).
 * @returns {boolean} true nếu event MỚI (được phép xử lý)
 */
function markEventProcessed(eventType, eventId) {
  try {
    const info = db
      .prepare(
        'INSERT OR IGNORE INTO debt_processed_events (event_type, event_id) VALUES (?, ?)'
      )
      .run(eventType, String(eventId));
    // changes = 0 ⇒ event đã tồn tại ⇒ KHÔNG xử lý lại
    return info.changes > 0;
  } catch (err) {
    logger.error('[DEBT_LEDGER] markEventProcessed error', { error: err.message });
    return false;
  }
}

/** Kiểm tra event đã được xử lý chưa. */
function isEventProcessed(eventType, eventId) {
  try {
    const row = db
      .prepare('SELECT id FROM debt_processed_events WHERE event_type = ? AND event_id = ?')
      .get(eventType, String(eventId));
    return !!row;
  } catch (_) {
    return false;
  }
}

// ── Truy vấn ─────────────────────────────────────────────────────────────────

/** Lịch sử giao dịch của 1 khách (mới nhất trước). */
function listTransactions(customerId, limit = 200) {
  return db
    .prepare(
      `SELECT * FROM debt_transactions
        WHERE customer_id = ?
        ORDER BY id DESC
        LIMIT ?`
    )
    .all(customerId, limit);
}

/** Tổng hợp công nợ theo từng loại bút toán của 1 khách. */
function getBalanceBreakdown(customerId) {
  const rows = db
    .prepare(
      `SELECT transaction_type,
              direction,
              COALESCE(SUM(amount), 0) AS total,
              COUNT(*) AS count
         FROM debt_transactions
        WHERE customer_id = ?
        GROUP BY transaction_type, direction`
    )
    .all(customerId);

  const breakdown = {
    openingBalance: 0,
    orderDebt: 0,
    manualDebt: 0,
    payment: 0,
    adjustment: 0,
    reversal: 0,
  };

  for (const r of rows) {
    const signed = r.direction === DIRECTION.DECREASE ? -r.total : r.total;
    switch (r.transaction_type) {
      case TRANSACTION_TYPES.OPENING_BALANCE:
        breakdown.openingBalance += signed;
        break;
      case TRANSACTION_TYPES.ORDER_DEBT:
        breakdown.orderDebt += signed;
        break;
      case TRANSACTION_TYPES.MANUAL_DEBT:
        breakdown.manualDebt += signed;
        break;
      case TRANSACTION_TYPES.PAYMENT:
        breakdown.payment += signed;
        break;
      case TRANSACTION_TYPES.ADJUSTMENT:
        breakdown.adjustment += signed;
        break;
      case TRANSACTION_TYPES.REVERSAL:
        breakdown.reversal += signed;
        break;
      default:
        break;
    }
  }

  return {
    ...breakdown,
    balance: roundMoney(
      breakdown.openingBalance +
        breakdown.orderDebt +
        breakdown.manualDebt +
        breakdown.payment +
        breakdown.adjustment +
        breakdown.reversal
    ),
  };
}

/** Thông tin tài khoản công nợ (tạo lazy nếu chưa có). */
function getAccount(customerId) {
  const account = ensureAccount(customerId);
  return {
    ...account,
    openingBalance: roundMoney(account.opening_balance),
    balance: computeBalance(customerId),
  };
}

/**
 * Danh sách tất cả khách kèm số dư công nợ (theo ledger).
 * @param {object} filters { hasDebt, limit, offset }
 */
function listAccounts(filters = {}) {
  const params = [];
  let where = 'c.archived = 0';

  if (filters.hasDebt) {
    where += `
      AND EXISTS (
        SELECT 1 FROM debt_transactions dt
         WHERE dt.customer_id = c.id
           AND dt.direction = 'INCREASE'
           AND dt.amount > 0
      )`;
  }

  const limit = Math.min(500, Math.max(1, parseInt(filters.limit) || 200));
  const offset = Math.max(0, parseInt(filters.offset) || 0);

  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.phone,
              c.debt AS mirror_debt,
              COALESCE(SUM(CASE WHEN dt.direction = 'INCREASE'
                               THEN dt.amount ELSE -dt.amount END), 0) AS ledger_balance,
              COUNT(dt.id) AS tx_count
         FROM customers c
         LEFT JOIN debt_transactions dt ON dt.customer_id = c.id
        WHERE ${where}
        GROUP BY c.id
        ORDER BY ledger_balance DESC, c.name ASC
        LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    balance: roundMoney(r.ledger_balance),
    mirrorDebt: roundMoney(r.mirror_debt || 0),
    transactionCount: r.tx_count,
    hasLedger: r.tx_count > 0,
  }));
}

module.exports = {
  DIRECTION,
  TRANSACTION_TYPES,
  EVENT_TYPES,
  SOURCES,
  REFERENCE_TYPES,
  recordTransaction,
  reverseTransaction,
  adjust,
  computeBalance,
  getBalanceBreakdown,
  listTransactions,
  listAccounts,
  getAccount,
  ensureAccount,
  markEventProcessed,
  isEventProcessed,
  syncMirror,
  roundMoney,
  getSetting,
};
