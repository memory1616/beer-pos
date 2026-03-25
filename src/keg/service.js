// src/keg/service.js
// Single Source of Truth for customer keg balance updates.
// ALL code that changes customer keg_balance must go through updateCustomerKegBalanceTx().

const db = require('../../database');
const { kegLedgerEntry } = require('./ledger');
const { KEG_POOL } = require('../constants');

/**
 * Cập nhật keg_balance khách hàng + ghi ledger entry TRONG 1 TRANSACTION.
 *
 * Đây là cách DUY NHẤT để thay đổi keg_balance khách hàng từ sales/payments.
 * Đảm bảo atomicity: nếu ledger write fail thì balance cũng không đổi.
 *
 * @param {number} customerId
 * @param {number} deliverKegs - số vỏ giao cho khách (dương = tăng balance)
 * @param {number} returnKegs  - số vỏ thu về từ khách (dương = giảm balance)
 * @param {string} sourceType  - 'sale' | 'return_sale' | 'adjust'
 * @param {number|null} sourceId - sales.id nếu có, null nếu adjust thủ công
 * @returns {{ oldBalance, newBalance, delta } | null}
 */
function updateCustomerKegBalanceTx(customerId, deliverKegs = 0, returnKegs = 0, sourceType = 'sale', sourceId = null) {
  const custId = parseInt(customerId);
  if (!custId) return null;

  const tx = db.transaction(() => {
    const customer = db.prepare('SELECT keg_balance FROM customers WHERE id = ?').get(custId);
    if (!customer) return null;

    const oldBalance = customer.keg_balance || 0;
    const delta = deliverKegs - returnKegs;
    const newBalance = Math.max(0, oldBalance + delta);

    // 1. Update customer keg_balance
    db.prepare('UPDATE customers SET keg_balance = ? WHERE id = ?').run(newBalance, custId);

    // 2. Sync keg_stats.customer_holding (recalculate from all customers)
    const totalHolding = db.prepare('SELECT COALESCE(SUM(keg_balance), 0) as t FROM customers WHERE archived = 0').get();
    db.prepare('UPDATE keg_stats SET customer_holding = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(totalHolding.t);

    // 3. Ghi ledger entry cho thay đổi
    if (delta !== 0) {
      kegLedgerEntry({
        sourceType,
        sourceId:   sourceId || null,
        customerId: custId,
        quantity:   Math.abs(delta),
        poolFrom:   delta < 0 ? KEG_POOL.CUSTOMER : KEG_POOL.INVENTORY,
        poolTo:     delta < 0 ? KEG_POOL.EMPTY    : KEG_POOL.CUSTOMER,
        note:       `${sourceType}${sourceId ? ' #' + sourceId : ''}`
      });
    }

    return { oldBalance, newBalance, delta };
  });

  return tx();
}

module.exports = { updateCustomerKegBalanceTx };
