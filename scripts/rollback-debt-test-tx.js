/**
 * Rollback giao dịch thử nghiệm (đảo bút toán) — chỉ dùng khi cần hoàn tác dữ liệu test.
 * Dùng: node scripts/rollback-debt-test-tx.js [customerId]
 */
process.env.NODE_ENV = 'test';

const db = require('../database');
const DebtLedgerService = require('../src/services/debt/DebtLedgerService');
const DebtManualService = require('../src/services/debt/DebtManualService');

const customerId = parseInt(process.argv[2] || '7', 10);

const txs = db
  .prepare(
    `SELECT * FROM debt_transactions
      WHERE customer_id = ? AND transaction_type = 'PAYMENT'
      ORDER BY id DESC`
  )
  .all(customerId);

if (!txs.length) {
  console.log('Không có giao dịch PAYMENT để đảo.');
  process.exit(0);
}

for (const tx of txs) {
  const res = DebtManualService.reverseTransaction({
    transactionId: tx.id,
    user: { username: 'admin', role: 'ADMIN' },
    reason: 'Hoàn tác giao dịch thử nghiệm',
    source: 'RECONCILIATION',
  });
  console.log(`Đảo tx #${tx.id} (${tx.amount}đ) →`, JSON.stringify(res));
}

console.log(`Số dư hiện tại: ${DebtLedgerService.computeBalance(customerId)}đ`);
