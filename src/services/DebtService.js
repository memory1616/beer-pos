/**
 * DebtService — Lớp tương thích ngược (legacy facade) cho sổ công nợ Gia Huy
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ LƯU Ý KIẾN TRÚC:
 *  Trước đây `DebtService` ghi thẳng vào bảng `debt_transactions` (schema cũ:
 *  `type`/`sale_id`/`payment_id`/`note`) và tự cập nhật `customers.debt`.
 *  Sau khi module Sổ Công nợ được triển khai, bảng `debt_transactions` đã được
 *  thay bằng SỔ CÁI mới (`transaction_type`/`direction`/`idempotency_key`/...).
 *
 *  `DebtService` giờ là FACADE mỏng: mọi ghi đều đi qua `DebtLedgerService`
 *  ⇒ **một nguồn sự thật duy nhất**, `customers.debt` chỉ là mirror được
 *  đồng bộ tự động bởi ledger.
 *
 *  Hợp đồng API (giữ nguyên 100% cho route/UI cũ):
 *    createDebt(customerId, amount, saleId, note)
 *    payDebt(customerId, amount, note, saleId)
 *    reverseDebtForSale(saleId)
 *    adjustDebt(customerId, amount, reason)
 *    recalcDebt(customerId)
 *    getAllDebts(filters) / getCustomerDebt(id) / getSalePayments(saleId)
 *
 *  Bảng `order_debts` được giữ lại làm BẢNG CHIẾU (projection) cho UI cũ
 *  (driver portal, customer-detail) — nhưng KHÔNG còn là nguồn sự thật.
 */

const db = require('../../database');
const logger = require('../utils/logger');
const DebtLedgerService = require('./debt/DebtLedgerService');
const {
  TRANSACTION_TYPES,
  SOURCES,
  REFERENCE_TYPES,
} = require('./debt/constants');

function formatCurrency(amount) {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(amount || 0);
}

// ─── Index bootstrap ───────────────────────────────────────────────────────────
// Idempotent — safe to call multiple times.
let _indexesEnsured = false;
function ensureIndexes() {
  if (_indexesEnsured) return;
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_order_debt_customer_status ON order_debts(customer_id, status)`
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_customers_debt_archived ON customers(archived, debt)`);
  } catch (e) {
    // best-effort
  }
  _indexesEnsured = true;
}

/**
 * Idempotency key chuẩn cho bút toán nợ của 1 đơn hàng.
 * Nhờ UNIQUE constraint → mỗi đơn CHỈ CÓ MỘT bút toán ORDER_DEBT.
 */
function orderDebtKey(saleId) {
  return saleId ? `order_debt:sale:${saleId}` : null;
}

/** Số tiền khách thực sự còn phải trả cho 1 đơn. */
function computeAmountOwed(saleId, customerId) {
  const sale = db
    .prepare('SELECT id, total, payment_status, status FROM sales WHERE id = ?')
    .get(saleId);
  if (!sale) return null;

  // Tiền đã thu gắn với đơn này (ledger PAYMENT reference ORDER + bảng payments cũ)
  const ledgerPaid =
    db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total
           FROM debt_transactions
          WHERE customer_id = ? AND reference_type = 'ORDER' AND reference_id = ?
            AND transaction_type = 'PAYMENT' AND direction = 'DECREASE'`
      )
      .get(customerId, String(saleId))?.total || 0;

  const legacyPaid =
    db
      .prepare(
        `SELECT COALESCE(od.paid_amount, 0) AS total
           FROM order_debts od
          WHERE od.sale_id = ? AND od.customer_id = ?`
      )
      .get(saleId, customerId)?.total || 0;

  const paid = Math.max(ledgerPaid, legacyPaid);
  const owed = Math.max(0, (sale.total || 0) - paid);
  return { sale, paid, owed };
}

class DebtService {
  /**
   * Ghi nợ cho 1 đơn hàng (ORDER_DEBT).
   * Idempotent theo saleId — gọi lại nhiều lần chỉ ghi 1 bút toán.
   */
  createDebt(customerId, amount, saleId, note) {
    if (!customerId || !amount || amount <= 0) {
      return { success: false, error: 'Dữ liệu không hợp lệ' };
    }

    try {
      const custId = parseInt(customerId, 10);
      const value = parseFloat(amount);

      const result = DebtLedgerService.recordTransaction({
        customerId: custId,
        transactionType: TRANSACTION_TYPES.ORDER_DEBT,
        amount: value,
        direction: DebtLedgerService.DIRECTION.INCREASE,
        referenceType: saleId ? REFERENCE_TYPES.ORDER : REFERENCE_TYPES.NONE,
        referenceId: saleId || null,
        description: note || `Nợ đơn hàng #${saleId}`,
        createdBy: 'system',
        source: SOURCES.POS,
        idempotencyKey: orderDebtKey(saleId),
      });

      if (!result.success) {
        return { success: false, error: result.error };
      }

      // Bảng chiếu `order_debts` (cho UI cũ) — không phải nguồn sự thật
      let orderDebtId = null;
      if (saleId) {
        const existing = db.prepare('SELECT id FROM order_debts WHERE sale_id = ?').get(saleId);
        if (!existing) {
          const odResult = db
            .prepare(
              `INSERT INTO order_debts (sale_id, customer_id, original_amount, remaining_amount, status)
               VALUES (?, ?, ?, ?, 'pending')`
            )
            .run(saleId, custId, value, value);
          orderDebtId = odResult.lastInsertRowid;
          db.prepare("UPDATE sales SET payment_status = 'partial' WHERE id = ? AND type = 'sale'").run(
            saleId
          );
        } else {
          orderDebtId = existing.id;
        }
      }

      return {
        success: true,
        debtTransactionId: result.transactionId,
        orderDebtId,
        newDebt: result.balanceAfter,
        duplicate: !!result.duplicate,
      };
    } catch (e) {
      logger.error('DebtService.createDebt error:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Ghi nhận thanh toán (PAYMENT).
   * Giữ hành vi legacy: số tiền áp dụng = min(amount, số dư nợ hiện tại)
   * (không để số dư âm). Phần vượt được trả lại cho người nhập.
   */
  payDebt(customerId, amount, note, saleId = null, opts = {}) {
    if (!customerId || !amount || amount <= 0) {
      return { success: false, error: 'Dữ liệu không hợp lệ' };
    }

    try {
      const custId = parseInt(customerId, 10);
      const requested = parseFloat(amount);
      const balanceBefore = DebtLedgerService.computeBalance(custId);

      if (balanceBefore <= 0) {
        return { success: false, error: 'Khách hàng không có công nợ' };
      }

      const appliedAmount = Math.min(requested, balanceBefore);

      // Toàn bộ thao tác (ledger + payments + bảng chiếu) nằm trong MỘT
      // transaction DB → atomic. Nếu server crash giữa chừng thì không còn
      // trạng thái nửa vời (đã trừ nợ nhưng chưa ghi lịch sử thu tiền).
      const tx = db.transaction(() => {
        const result = DebtLedgerService.recordTransaction({
          customerId: custId,
          transactionType: TRANSACTION_TYPES.PAYMENT,
          amount: appliedAmount,
          direction: DebtLedgerService.DIRECTION.DECREASE,
          referenceType: saleId ? REFERENCE_TYPES.ORDER : REFERENCE_TYPES.NONE,
          referenceId: saleId || null,
          description:
            note || `Thu tiền${saleId ? ` đơn #${saleId}` : ''}${opts.createdBy ? ` (${opts.createdBy})` : ''}`,
          createdBy: opts.createdBy || null,
          source: opts.source || SOURCES.MANUAL_UI,
          idempotencyKey: opts.idempotencyKey || null,
        });

        if (!result.success) {
          throw new Error(result.error || 'Không ghi được bút toán');
        }

        // Bảng `payments` (lịch sử thu tiền legacy) — giữ để không phá báo cáo cũ
        const paymentResult = db
          .prepare('INSERT INTO payments (customer_id, amount, date, note) VALUES (?, ?, ?, ?)')
          .run(
            custId,
            appliedAmount,
            db.getVietnamDateStr(),
            note || `Thu tiền${saleId ? ` đơn #${saleId}` : ''}`
          );
        const paymentId = paymentResult.lastInsertRowid;

        // Phân bổ vào `order_debts` (bảng chiếu)
        let appliedToSale = null;
        if (saleId) {
          const orderDebt = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleId);
          if (orderDebt) {
            const newPaid = orderDebt.paid_amount + appliedAmount;
            const newRemaining = Math.max(0, orderDebt.original_amount - newPaid);
            const status = newRemaining <= 0 ? 'paid' : 'partial';
            db.prepare(
              `UPDATE order_debts
                  SET paid_amount = ?, remaining_amount = ?, status = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`
            ).run(newPaid, newRemaining, status, orderDebt.id);
            db.prepare('UPDATE sales SET payment_status = ? WHERE id = ?').run(status, saleId);
            appliedToSale = { saleId, newRemaining, status };
          }
        } else {
          const unpaidOrders = db
            .prepare(
              `SELECT * FROM order_debts WHERE customer_id = ? AND status != 'paid' ORDER BY created_at ASC`
            )
            .all(custId);

          let remaining = appliedAmount;
          for (const od of unpaidOrders) {
            if (remaining <= 0) break;
            const toApply = Math.min(remaining, od.remaining_amount);
            const newPaid = od.paid_amount + toApply;
            const newRemaining = Math.max(0, od.original_amount - newPaid);
            const status = newRemaining <= 0 ? 'paid' : 'partial';
            db.prepare(
              `UPDATE order_debts
                  SET paid_amount = ?, remaining_amount = ?, status = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`
            ).run(newPaid, newRemaining, status, od.id);
            db.prepare('UPDATE sales SET payment_status = ? WHERE id = ?').run(status, od.sale_id);
            remaining -= toApply;
            appliedToSale = { saleId: od.sale_id, newRemaining, status };
          }
        }

        return {
          success: true,
          paymentId,
          debtTransactionId: result.transactionId,
          newDebt: result.balanceAfter,
          appliedAmount,
          excessAmount: Math.max(0, requested - appliedAmount),
          appliedToSale,
        };
      });

      return tx();
    } catch (e) {
      logger.error('DebtService.payDebt error:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Hoàn công nợ khi đơn hàng bị hủy/xoá.
   * KHÔNG xoá bút toán gốc — tạo bút toán REVERSAL đối ứng (có audit log).
   */
  reverseDebtForSale(saleId) {
    if (!saleId) {
      return { success: false, error: 'Thiếu saleId' };
    }

    try {
      const orderDebt = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleId);
      if (!orderDebt) {
        return { success: true, refundedAmount: 0 };
      }

      // Các bút toán cần đảo (chưa bị đảo)
      // ⚠️ Đảo TẤT CẢ (ORDER_DEBT + ADJUSTMENT + PAYMENT), không chỉ bút toán gốc.
      //    Bỏ qua PAYMENT → số dư âm (đã thu tiền khách nhưng vẫn giữ nợ).
      //    THỨ TỰ: đảo bút toán GIẢM (PAYMENT) trước để số dư không âm tạm thời.
      const txToReverse = db
        .prepare(
          `SELECT id, amount, transaction_type, direction FROM debt_transactions
            WHERE reference_type = 'ORDER' AND reference_id = ?
              AND transaction_type IN ('ORDER_DEBT', 'ADJUSTMENT', 'PAYMENT')
            ORDER BY CASE WHEN direction = 'DECREASE' THEN 0 ELSE 1 END, id ASC`
        )
        .all(String(saleId));

      let refundedAmount = 0;
      let reversedCount = 0;
      for (const tx of txToReverse) {
        const rev = DebtLedgerService.reverseTransaction(tx.id, {
          createdBy: 'system',
          source: SOURCES.POS,
          reason: `Huỷ đơn #${saleId}, hoàn ${formatCurrency(tx.amount)} (${tx.transaction_type})`,
        });
        if (!rev.success) {
          return { success: false, error: rev.error, refundedAmount };
        }
        refundedAmount += tx.amount;
        reversedCount += 1;
      }

      if (reversedCount === 0) {
        // Không có bút toán nào trong ledger (nợ nhập tay) → chỉ cập nhật bảng chiếu
        refundedAmount = orderDebt.remaining_amount || 0;
      }

      // Đánh dấu bảng chiếu (KHÔNG xoá vật lý — giữ dấu vết)
      db.prepare(
        "UPDATE order_debts SET status = 'cancelled', remaining_amount = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(orderDebt.id);
      db.prepare("UPDATE sales SET payment_status = 'cancelled' WHERE id = ?").run(saleId);

      return { success: true, refundedAmount, reversedCount };
    } catch (e) {
      logger.error('DebtService.reverseDebtForSale error:', e);
      return { success: false, error: e.message };
    }
  }

  /** Điều chỉnh công nợ (ADJUSTMENT) — luôn tạo bút toán mới. */
  adjustDebt(customerId, amount, reason) {
    if (!customerId) {
      return { success: false, error: 'Thiếu customerId' };
    }

    try {
      const result = DebtLedgerService.adjust(parseInt(customerId, 10), parseFloat(amount) || 0, {
        createdBy: 'system',
        source: SOURCES.MANUAL_UI,
        reason: reason || 'Điều chỉnh thủ công',
      });

      if (!result.success) {
        return { success: false, error: result.error };
      }
      return { success: true, newDebt: result.balanceAfter, debtTransactionId: result.transactionId };
    } catch (e) {
      logger.error('DebtService.adjustDebt error:', e);
      return { success: false, error: e.message };
    }
  }

  /** Đối soát nhanh: ledger vs bảng chiếu order_debts. */
  recalcDebt(customerId) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) return { success: false, error: 'Không tìm thấy khách' };

    const orderDebts = db
      .prepare('SELECT * FROM order_debts WHERE customer_id = ?')
      .all(customerId);
    const calculatedDebt = orderDebts.reduce((sum, od) => sum + (od.remaining_amount || 0), 0);
    const ledgerBalance = DebtLedgerService.computeBalance(customerId);
    const actualDebt = customer.debt || 0;

    return {
      success: true,
      calculatedDebt,
      actualDebt,
      ledgerBalance,
      diff: actualDebt - ledgerBalance,
      projectionDiff: actualDebt - calculatedDebt,
      orderDebts,
    };
  }

  getAllDebts(filters = {}) {
    ensureIndexes();

    let sql = `
      SELECT
        c.id, c.name, c.phone, c.tier,
        c.debt,
        COALESCE(c.deposit, 0) as deposit,
        c.last_order_date, c.created_at,
        COALESCE(od.unpaid_orders, 0) as unpaid_orders
      FROM customers c
      LEFT JOIN (
        SELECT customer_id, COUNT(*) AS unpaid_orders
        FROM order_debts
        WHERE status != 'paid'
        GROUP BY customer_id
      ) od ON od.customer_id = c.id
      WHERE c.archived = 0
    `;

    const params = [];
    if (filters.hasDebt) sql += ' AND c.debt > 0';
    if (filters.overdue) {
      sql += " AND c.debt > 0 AND (c.last_order_date IS NULL OR date(c.last_order_date) < date('now', '-30 days'))";
    }
    sql += ' ORDER BY c.debt DESC, c.name ASC';

    if (filters.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
      if (filters.offset) {
        sql += ' OFFSET ?';
        params.push(filters.offset);
      }
    }

    return db.prepare(sql).all(...params);
  }

  getCustomerDebt(customerId) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND archived = 0').get(customerId);
    if (!customer) return null;

    const orderDebts = db
      .prepare('SELECT * FROM order_debts WHERE customer_id = ? ORDER BY created_at DESC')
      .all(customerId);
    const payments = db
      .prepare('SELECT * FROM payments WHERE customer_id = ? ORDER BY date DESC LIMIT 50')
      .all(customerId);

    // Lịch sử từ ledger mới, map về shape legacy cho UI cũ (type/note/amount)
    const history = DebtLedgerService.listTransactions(customerId, 100).map((tx) => ({
      id: tx.id,
      customer_id: tx.customer_id,
      type: legacyTypeOf(tx),
      amount: legacyAmountOf(tx),
      balance_before: tx.balance_before,
      balance_after: tx.balance_after,
      sale_id: tx.reference_type === 'ORDER' ? tx.reference_id : null,
      note: tx.description,
      created_at: tx.created_at,
      transaction_type: tx.transaction_type,
      source: tx.source,
    }));

    return {
      customer,
      orderDebts,
      payments,
      history,
      totalDebt: customer.debt || 0,
      unpaidCount: orderDebts.filter((od) => od.status !== 'paid').length,
    };
  }

  getSalePayments(saleId) {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) return null;

    const orderDebt = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleId);

    // Khoản thu gắn với đơn này — lấy từ LEDGER (nguồn sự thật).
    const ledgerPayments = db
      .prepare(
        `SELECT * FROM debt_transactions
          WHERE reference_type = 'ORDER' AND reference_id = ?
            AND transaction_type = 'PAYMENT' AND direction = 'DECREASE'
          ORDER BY id DESC`
      )
      .all(String(saleId));

    // Lịch sử thu tiền legacy của khách (bảng `payments`) — giữ cho tương thích
    const payments = sale.customer_id
      ? db
          .prepare('SELECT * FROM payments WHERE customer_id = ? ORDER BY date DESC LIMIT 50')
          .all(sale.customer_id)
      : [];

    const totalPaid = ledgerPayments.reduce((s, t) => s + t.amount, 0);
    const remaining = orderDebt ? orderDebt.remaining_amount : Math.max(0, sale.total - totalPaid);

    return {
      sale,
      orderDebt,
      totalPaid,
      remaining,
      payments,
      customerDebt: sale.customer_id
        ? db.prepare('SELECT debt FROM customers WHERE id = ?').get(sale.customer_id)?.debt || 0
        : 0,
    };
  }
}

/** Map transaction_type mới → `type` legacy (cho UI cũ). */
function legacyTypeOf(tx) {
  switch (tx.transaction_type) {
    case TRANSACTION_TYPES.PAYMENT:
      return 'decrease';
    case TRANSACTION_TYPES.REVERSAL:
      return 'cancel';
    case TRANSACTION_TYPES.ADJUSTMENT:
      return 'adjust';
    case TRANSACTION_TYPES.OPENING_BALANCE:
      return 'opening';
    default:
      return 'increase';
  }
}

/** Map amount (luôn > 0 trong ledger) → amount có dấu kiểu legacy. */
function legacyAmountOf(tx) {
  return tx.direction === 'DECREASE' ? -tx.amount : tx.amount;
}

module.exports = DebtService;
module.exports.computeAmountOwed = computeAmountOwed;
module.exports.orderDebtKey = orderDebtKey;
