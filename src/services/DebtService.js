/**
 * DebtService - Core business logic cho cong no (v2)
 * Dam bao: transaction, audit trail, khong am, idempotent
 */
const db = require('../../database');
const logger = require('../utils/logger');

function formatCurrency(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(amount || 0);
}

// ─── Index bootstrap ───────────────────────────────────────────────────────────
// Idempotent — safe to call multiple times. Ensures the composite index needed
// by getAllDebts' GROUP BY exists; it covers the (customer_id, status) prefix.
let _indexesEnsured = false;
function ensureIndexes() {
  if (_indexesEnsured) return;
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_order_debt_customer_status ON order_debts(customer_id, status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_customers_debt_archived ON customers(archived, debt)`);
  } catch (e) {
    // best-effort
  }
  _indexesEnsured = true;
}

class DebtService {
  createDebt(customerId, amount, saleId, note) {
    if (!customerId || !amount || amount <= 0) {
      return { success: false, error: 'Dữ liệu không hợp lệ' };
    }

    const tx = db.transaction(() => {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND archived = 0').get(customerId);
      if (!customer) {
        throw new Error('Không tìm thấy khách hàng');
      }

      const balanceBefore = customer.debt || 0;
      const balanceAfter = balanceBefore + amount;

      const debtTxResult = db.prepare(`
        INSERT INTO debt_transactions (customer_id, type, amount, balance_before, balance_after, sale_id, note)
        VALUES (?, 'increase', ?, ?, ?, ?, ?)
      `).run(customerId, amount, balanceBefore, balanceAfter, saleId || null, note || `Nợ đơn hàng #${saleId}`);

      db.prepare('UPDATE customers SET debt = ? WHERE id = ?').run(balanceAfter, customerId);

      let orderDebtId = null;
      if (saleId) {
        const existing = db.prepare('SELECT id FROM order_debts WHERE sale_id = ?').get(saleId);
        if (!existing) {
          const odResult = db.prepare(`
            INSERT INTO order_debts (sale_id, customer_id, original_amount, remaining_amount, status)
            VALUES (?, ?, ?, ?, 'pending')
          `).run(saleId, customerId, amount, amount);
          orderDebtId = odResult.lastInsertRowid;
          db.prepare("UPDATE sales SET payment_status = 'partial' WHERE id = ? AND type = 'sale'").run(saleId);
        } else {
          orderDebtId = existing.id;
        }
      }

      return { debtTransactionId: debtTxResult.lastInsertRowid, orderDebtId, newDebt: balanceAfter };
    });

    try {
      const result = tx();
      return { success: true, ...result };
    } catch (e) {
      logger.error('DebtService.createDebt error:', e);
      return { success: false, error: e.message };
    }
  }

  payDebt(customerId, amount, note, saleId = null) {
    if (!customerId || !amount || amount <= 0) {
      return { success: false, error: 'Dữ liệu không hợp lệ' };
    }

    const tx = db.transaction(() => {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND archived = 0').get(customerId);
      if (!customer) {
        throw new Error('Không tìm thấy khách hàng');
      }

      const balanceBefore = customer.debt || 0;
      const appliedAmount = Math.min(amount, balanceBefore);
      const balanceAfter = Math.max(0, balanceBefore - appliedAmount);

      const paymentResult = db.prepare(`
        INSERT INTO payments (customer_id, amount, date, note)
        VALUES (?, ?, ?, ?)
      `).run(customerId, appliedAmount, db.getVietnamDateStr(), note || `Thu tiền${saleId ? ` đơn #${saleId}` : ''}`);
      const paymentId = paymentResult.lastInsertRowid;

      const debtTxResult = db.prepare(`
        INSERT INTO debt_transactions (customer_id, type, amount, balance_before, balance_after, sale_id, payment_id, note)
        VALUES (?, 'decrease', ?, ?, ?, ?, ?, ?)
      `).run(customerId, -appliedAmount, balanceBefore, balanceAfter, saleId || null, paymentId, note || `Thu tiền${saleId ? ` đơn #${saleId}` : ''}`);
      const debtTransactionId = debtTxResult.lastInsertRowid;

      db.prepare('UPDATE customers SET debt = ? WHERE id = ?').run(balanceAfter, customerId);

      let appliedToSale = null;
      if (saleId) {
        const orderDebt = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleId);
        if (orderDebt) {
          const newPaid = orderDebt.paid_amount + appliedAmount;
          const newRemaining = Math.max(0, orderDebt.original_amount - newPaid);
          const status = newRemaining <= 0 ? 'paid' : 'partial';
          db.prepare('UPDATE order_debts SET paid_amount = ?, remaining_amount = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(newPaid, newRemaining, status, orderDebt.id);
          db.prepare("UPDATE sales SET payment_status = ? WHERE id = ?").run(status, saleId);
          appliedToSale = { saleId, newRemaining, status };
        }
      } else {
        const unpaidOrders = db.prepare(`
          SELECT * FROM order_debts WHERE customer_id = ? AND status != 'paid' ORDER BY created_at ASC
        `).all(customerId);

        let remaining = appliedAmount;
        for (const od of unpaidOrders) {
          if (remaining <= 0) break;
          const toApply = Math.min(remaining, od.remaining_amount);
          const newPaid = od.paid_amount + toApply;
          const newRemaining = Math.max(0, od.original_amount - newPaid);
          const status = newRemaining <= 0 ? 'paid' : 'partial';
          db.prepare('UPDATE order_debts SET paid_amount = ?, remaining_amount = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(newPaid, newRemaining, status, od.id);
          db.prepare("UPDATE sales SET payment_status = ? WHERE id = ?").run(status, od.sale_id);
          remaining -= toApply;
          appliedToSale = { saleId: od.sale_id, newRemaining, status };
        }
      }

      return { paymentId, debtTransactionId, newDebt: balanceAfter, appliedAmount, appliedToSale };
    });

    try {
      const result = tx();
      return { success: true, ...result };
    } catch (e) {
      logger.error('DebtService.payDebt error:', e);
      return { success: false, error: e.message };
    }
  }

  reverseDebtForSale(saleId) {
    if (!saleId) {
      return { success: false, error: 'Thiếu saleId' };
    }

    const tx = db.transaction(() => {
      const orderDebt = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleId);
      if (!orderDebt) {
        return { success: true, refundedAmount: 0 };
      }

      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(orderDebt.customer_id);
      if (!customer) {
        throw new Error('Không tìm thấy khách hàng');
      }

      const refundAmount = orderDebt.remaining_amount;
      const balanceBefore = customer.debt || 0;
      const balanceAfter = Math.max(0, balanceBefore - refundAmount);

      db.prepare(`
        INSERT INTO debt_transactions (customer_id, type, amount, balance_before, balance_after, sale_id, note)
        VALUES (?, 'cancel', ?, ?, ?, ?, ?)
      `).run(orderDebt.customer_id, -refundAmount, balanceBefore, balanceAfter, saleId, `Huỷ đơn #${saleId}, hoàn ${formatCurrency(refundAmount)}`);

      db.prepare('UPDATE customers SET debt = ? WHERE id = ?').run(balanceAfter, orderDebt.customer_id);
      db.prepare('DELETE FROM order_debts WHERE sale_id = ?').run(saleId);
      db.prepare("UPDATE sales SET payment_status = 'cancelled' WHERE id = ?").run(saleId);

      return { refundedAmount: refundAmount };
    });

    try {
      const result = tx();
      return { success: true, ...result };
    } catch (e) {
      logger.error('DebtService.reverseDebtForSale error:', e);
      return { success: false, error: e.message };
    }
  }

  adjustDebt(customerId, amount, reason) {
    if (!customerId) {
      return { success: false, error: 'Thiếu customerId' };
    }

    const tx = db.transaction(() => {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND archived = 0').get(customerId);
      if (!customer) {
        throw new Error('Không tìm thấy khách hàng');
      }

      const balanceBefore = customer.debt || 0;
      let balanceAfter = balanceBefore + amount;
      if (balanceAfter < 0) balanceAfter = 0;

      db.prepare(`
        INSERT INTO debt_transactions (customer_id, type, amount, balance_before, balance_after, note)
        VALUES (?, 'adjust', ?, ?, ?, ?)
      `).run(customerId, amount < 0 ? amount : -Math.abs(amount), balanceBefore, balanceAfter, reason || 'Điều chỉnh thủ công');

      db.prepare('UPDATE customers SET debt = ? WHERE id = ?').run(balanceAfter, customerId);
      return { newDebt: balanceAfter };
    });

    try {
      const result = tx();
      return { success: true, ...result };
    } catch (e) {
      logger.error('DebtService.adjustDebt error:', e);
      return { success: false, error: e.message };
    }
  }

  recalcDebt(customerId) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) return { success: false, error: 'Không tìm thấy khách' };

    const orderDebts = db.prepare('SELECT * FROM order_debts WHERE customer_id = ?').all(customerId);
    const calculatedDebt = orderDebts.reduce((sum, od) => sum + (od.remaining_amount || 0), 0);
    const actualDebt = customer.debt || 0;
    const diff = actualDebt - calculatedDebt;

    return { success: true, calculatedDebt, actualDebt, diff, orderDebts };
  }

  getAllDebts(filters = {}) {
    // Make sure the supporting composite index exists
    ensureIndexes();

    // Replaced correlated subquery with LEFT JOIN + GROUP BY.
    // Correlated subquery runs once per outer row (O(N) executions).
    // The new form lets SQLite use a single scan + group, which is O(N)
    // and — thanks to idx_order_debt_customer_status — an index-only aggregation.
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
      if (filters.offset) { sql += ' OFFSET ?'; params.push(filters.offset); }
    }

    return db.prepare(sql).all(...params);
  }

  getCustomerDebt(customerId) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND archived = 0').get(customerId);
    if (!customer) return null;

    const orderDebts = db.prepare('SELECT * FROM order_debts WHERE customer_id = ? ORDER BY created_at DESC').all(customerId);
    const payments = db.prepare('SELECT * FROM payments WHERE customer_id = ? ORDER BY date DESC LIMIT 50').all(customerId);
    const history = db.prepare(`
      SELECT * FROM debt_transactions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(customerId);

    return {
      customer,
      orderDebts,
      payments,
      history,
      totalDebt: customer.debt || 0,
      unpaidCount: orderDebts.filter(od => od.status !== 'paid').length
    };
  }

  getSalePayments(saleId) {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) return null;

    const orderDebt = db.prepare('SELECT * FROM order_debts WHERE sale_id = ?').get(saleId);
    const payments = db.prepare(`
      SELECT p.* FROM payments p
      JOIN debt_transactions dt ON dt.payment_id = p.id
      WHERE dt.sale_id = ?
      ORDER BY p.date DESC
    `).all(saleId);

    const totalPaid = orderDebt ? orderDebt.paid_amount : 0;
    const remaining = orderDebt ? orderDebt.remaining_amount : sale.total;

    return {
      sale,
      orderDebt,
      totalPaid,
      remaining,
      payments,
      customerDebt: sale.customer_id
        ? (db.prepare('SELECT debt FROM customers WHERE id = ?').get(sale.customer_id)?.debt || 0)
        : 0
    };
  }
}

module.exports = DebtService;
