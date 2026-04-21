/**
 * BeerPOS - Debt System Migration & Rebuild Script
 *
 * Chạy: node migrate_debt.js
 *
 * Mục đích:
 * 1. Đảm bảo bảng debt_transactions và order_debts tồn tại
 * 2. Rebuild debt_transactions từ dữ liệu cũ (payments + sales)
 * 3. Rebuild order_debts từ dữ liệu cũ
 * 4. Verify customers.debt = SUM(remaining_amount) từ order_debts
 * 5. Report các bất thường (sai số)
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// Disable FK constraints during rebuild (safe vì đang tái tạo data)
db.pragma('foreign_keys = OFF');

const log = (msg, type = 'info') => {
  const prefix = {
    info: '[INFO]  ',
    warn: '[WARN]  ',
    error: '[ERROR] ',
    ok: '[OK]    ',
    step: '[STEP]  '
  };
  console.log(`${prefix[type] || '[INFO]  '}${msg}`);
};

const formatVND = (n) => new Intl.NumberFormat('vi-VN').format(Math.round(n || 0));

// ────────────────────────────────────────────────────────────────
// STEP 1: Tạo bảng nếu chưa có
// ────────────────────────────────────────────────────────────────
function ensureTables() {
  log('STEP 1: Kiểm tra bảng debt_transactions và order_debts...', 'step');

  db.exec(`
    CREATE TABLE IF NOT EXISTS debt_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_before REAL NOT NULL,
      balance_after REAL NOT NULL,
      sale_id INTEGER,
      payment_id INTEGER,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL,
      FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_debt_tx_customer ON debt_transactions(customer_id, created_at DESC)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS order_debts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      original_amount REAL NOT NULL,
      paid_amount REAL DEFAULT 0,
      remaining_amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      due_date TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_order_debt_customer ON order_debts(customer_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_order_debt_status ON order_debts(status)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_order_debt_sale ON order_debts(sale_id)`);

  log('  Bảng đã sẵn sàng', 'ok');
}

// ────────────────────────────────────────────────────────────────
// STEP 2: Rebuild order_debts từ sales
// ────────────────────────────────────────────────────────────────
function rebuildOrderDebts() {
  log('STEP 2: Rebuild order_debts từ sales...', 'step');

  // Lấy tất cả sales có customer_id (không phải khách lẻ)
  // và không phải returned/cancelled
  const sales = db.prepare(`
    SELECT s.id, s.customer_id, s.total, s.date, s.payment_status, s.type, s.archived
    FROM sales s
    WHERE s.customer_id IS NOT NULL
      AND s.type = 'sale'
      AND s.archived = 0
      AND s.status != 'returned'
    ORDER BY s.date ASC
  `).all();

  log(`  Tìm thấy ${sales.length} đơn hàng cần xử lý`);

  // Clear existing order_debts
  db.prepare('DELETE FROM order_debts').run();

  // Clear existing debt_transactions
  db.prepare('DELETE FROM debt_transactions').run();

  const insertOrderDebt = db.prepare(`
    INSERT INTO order_debts (sale_id, customer_id, original_amount, remaining_amount, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertDebtTx = db.prepare(`
    INSERT INTO debt_transactions (customer_id, type, amount, balance_before, balance_after, sale_id, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let processed = 0;

  for (const sale of sales) {
    // Tính paid_amount từ payments liên quan
    const paidSum = db.prepare(`
      SELECT COALESCE(SUM(p.amount), 0) as paid
      FROM payments p
      WHERE p.customer_id = ?
        AND (p.note LIKE '%#${sale.id}%' OR p.note LIKE '%đơn #${sale.id}%')
    `).get(sale.customer_id)?.paid || 0;

    // Hoặc tính từ debt_transactions nếu đã có (từ payment_id)
    const paidFromTx = db.prepare(`
      SELECT COALESCE(SUM(ABS(p.amount)), 0) as paid
      FROM payments p
      JOIN debt_transactions dt ON dt.payment_id = p.id
      WHERE dt.sale_id = ?
    `).get(sale.id)?.paid || 0;

    const actualPaid = Math.max(paidSum, paidFromTx);
    const remaining = Math.max(0, sale.total - actualPaid);

    // Xác định status
    let status = 'pending';
    if (actualPaid <= 0) status = 'pending';
    else if (remaining <= 0) status = 'paid';
    else status = 'partial';

    // Nếu payment_status là 'paid' từ trước
    if (sale.payment_status === 'paid' && remaining > 0) {
      // Đơn được đánh dấu paid nhưng còn nợ → có thể đã trả bằng tiền mặt không ghi nhận
      // Coi như đã trả đủ (trạng thái cũ)
      status = 'paid';
    }

    insertOrderDebt.run(sale.id, sale.customer_id, sale.total, remaining, status, sale.date);
    processed++;
  }

  log(`  Đã tạo ${processed} order_debt records`, 'ok');

  // Verify counts
  const count = db.prepare('SELECT COUNT(*) as c FROM order_debts').get();
  log(`  Tổng order_debts: ${count.c}`);
}

// ────────────────────────────────────────────────────────────────
// STEP 3: Rebuild debt_transactions audit log
// ────────────────────────────────────────────────────────────────
function rebuildDebtTransactions() {
  log('STEP 3: Rebuild debt_transactions audit log...', 'step');

  // Với mỗi customer, tính toán balance chạy dần
  const customers = db.prepare(`
    SELECT id FROM customers WHERE archived = 0 ORDER BY id
  `).all();

  const insertTx = db.prepare(`
    INSERT INTO debt_transactions (customer_id, type, amount, balance_before, balance_after, sale_id, payment_id, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalTxs = 0;

  for (const customer of customers) {
    const cid = customer.id;

    // 1. Tất cả order_debts (nợ thêm)
    const orderDebts = db.prepare(`
      SELECT od.id, od.original_amount, od.status, od.created_at, s.date, s.id as sale_id
      FROM order_debts od
      JOIN sales s ON s.id = od.sale_id
      WHERE od.customer_id = ?
      ORDER BY od.created_at ASC
    `).all(cid);

    // 2. Tất cả payments
    const payments = db.prepare(`
      SELECT p.id, p.amount, p.date, p.note
      FROM payments p
      WHERE p.customer_id = ?
      ORDER BY p.date ASC, p.id ASC
    `).all(cid);

    // Gộp theo thứ tự thời gian
    const events = [];

    for (const od of orderDebts) {
      events.push({ kind: 'order', date: od.date || od.created_at, data: od });
    }
    for (const p of payments) {
      events.push({ kind: 'payment', date: p.date, data: p });
    }

    // Sắp xếp theo thời gian
    events.sort((a, b) => {
      if (a.date === b.date) return 0;
      return a.date < b.date ? -1 : 1;
    });

    // Tính balance chạy dần
    let balance = 0;

    for (const ev of events) {
      const before = balance;

      if (ev.kind === 'order') {
        balance += ev.data.original_amount;
        insertTx.run(
          cid, 'increase', ev.data.original_amount,
          before, balance,
          ev.data.sale_id, null,
          `Nợ đơn hàng #${ev.data.sale_id}`,
          ev.date
        );
      } else if (ev.kind === 'payment') {
        const paid = ev.data.amount;
        balance = Math.max(0, balance - paid);
        insertTx.run(
          cid, 'decrease', -paid,
          before + paid, balance,
          null, ev.data.id,
          ev.data.note || 'Thanh toán',
          ev.date
        );
      }
    }

    totalTxs += events.length;
  }

  log(`  Đã tạo ${totalTxs} debt_transaction records`, 'ok');
}

// ────────────────────────────────────────────────────────────────
// STEP 4: Recalculate customers.debt từ order_debts
// ────────────────────────────────────────────────────────────────
function recalcCustomerDebts() {
  log('STEP 4: Recalculate customers.debt từ order_debts...', 'step');

  const customers = db.prepare('SELECT id, name, debt FROM customers WHERE archived = 0').all();
  const updateDebt = db.prepare('UPDATE customers SET debt = ? WHERE id = ?');

  let mismatches = 0;
  let corrected = 0;
  const issues = [];

  for (const c of customers) {
    const totalRemaining = db.prepare(`
      SELECT COALESCE(SUM(remaining_amount), 0) as total
      FROM order_debts
      WHERE customer_id = ? AND status != 'paid'
    `).get(c.id)?.total || 0;

    if (Math.abs((c.debt || 0) - totalRemaining) > 0.01) {
      mismatches++;
      issues.push({
        customerId: c.id,
        name: c.name,
        oldDebt: c.debt || 0,
        newDebt: totalRemaining,
        diff: (c.debt || 0) - totalRemaining
      });
    }

    updateDebt.run(totalRemaining, c.id);
    corrected++;
  }

  log(`  Đã recalc ${corrected} khách hàng`, 'ok');

  if (issues.length > 0) {
    log(`  PHÁT HIỆN ${issues.length} bất thường:`, 'warn');
    for (const issue of issues) {
      log(`    Khách #${issue.customerId} "${issue.name}": ${formatVND(issue.oldDebt)} → ${formatVND(issue.newDebt)} (chênh: ${formatVND(issue.diff)})`, 'warn');
    }
  } else {
    log('  Không có bất thường - tất cả đúng!', 'ok');
  }

  return issues;
}

// ────────────────────────────────────────────────────────────────
// STEP 5: Verify integrity
// ────────────────────────────────────────────────────────────────
function verifyIntegrity() {
  log('STEP 5: Verify integrity...', 'step');

  const checks = [];

  // Check 1: customers.debt = SUM(order_debts.remaining_amount)
  const debtMismatchRows = db.prepare(`
    SELECT c.id, c.name, c.debt as actual_debt,
           (SELECT COALESCE(SUM(remaining_amount), 0) FROM order_debts WHERE customer_id = c.id AND status != 'paid') as calc_debt
    FROM customers c
    WHERE c.archived = 0
  `).all();

  const debtMismatch = debtMismatchRows.filter(r => Math.abs((r.actual_debt || 0) - r.calc_debt) > 0.01);

  checks.push({
    name: 'customers.debt vs SUM(order_debts.remaining_amount)',
    passed: debtMismatch.length === 0,
    count: debtMismatch.length,
    details: debtMismatch
  });

  // Check 2: order_debts có sale_id trùng không
  const duplicateSales = db.prepare(`
    SELECT sale_id, COUNT(*) as c
    FROM order_debts
    GROUP BY sale_id
    HAVING c > 1
  `).all();

  checks.push({
    name: 'order_debts.sale_id không trùng',
    passed: duplicateSales.length === 0,
    count: duplicateSales.length,
    details: duplicateSales
  });

  // Check 3: customers.debt không âm
  const negativeDebts = db.prepare(`
    SELECT id, name, debt FROM customers WHERE debt < 0 AND archived = 0
  `).all();

  checks.push({
    name: 'customers.debt không âm',
    passed: negativeDebts.length === 0,
    count: negativeDebts.length,
    details: negativeDebts
  });

  // Check 4: order_debts.remaining_amount không âm
  const negativeRemaining = db.prepare(`
    SELECT id, sale_id, remaining_amount FROM order_debts WHERE remaining_amount < 0
  `).all();

  checks.push({
    name: 'order_debts.remaining_amount không âm',
    passed: negativeRemaining.length === 0,
    count: negativeRemaining.length,
    details: negativeRemaining
  });

  // Check 5: Tổng nợ
  const totalDebt = db.prepare('SELECT COALESCE(SUM(debt), 0) as t FROM customers WHERE archived = 0').get()?.t || 0;
  const totalRemaining = db.prepare("SELECT COALESCE(SUM(remaining_amount), 0) as t FROM order_debts WHERE status != 'paid'").get()?.t || 0;
  const totalTx = db.prepare('SELECT COUNT(*) as t FROM debt_transactions').get()?.t || 0;
  const totalPayments = db.prepare('SELECT COUNT(*) as t FROM payments').get()?.t || 0;

  log(`  Tổng công nợ: ${formatVND(totalDebt)}`, 'info');
  log(`  Tổng remaining (order_debts): ${formatVND(totalRemaining)}`, 'info');
  log(`  Tổng debt_transactions: ${totalTx}`, 'info');
  log(`  Tổng payments: ${totalPayments}`, 'info');

  // Summary
  let allPassed = true;
  for (const check of checks) {
    if (!check.passed) {
      allPassed = false;
      log(`  ❌ ${check.name}: FAILED (${check.count} issues)`, 'error');
    } else {
      log(`  ✅ ${check.name}: PASSED`, 'ok');
    }
  }

  return { allPassed, checks };
}

// ────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────
function main() {
  console.log('\n===========================================');
  console.log(' BeerPOS - Debt System Migration & Rebuild');
  console.log('===========================================\n');

  const startTime = Date.now();

  try {
    ensureTables();
    rebuildOrderDebts();
    rebuildDebtTransactions();
    const issues = recalcCustomerDebts();
    const verifyResult = verifyIntegrity();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n===========================================');
    if (verifyResult.allPassed && issues.length === 0) {
      console.log(' ✅ MIGRATION HOÀN TẤT - Tất cả checks PASSED!');
    } else {
      console.log(' ⚠️  MIGRATION HOÀN TẤT - Có vấn đề cần xem xét');
    }
    console.log(` Thời gian: ${elapsed}s`);
    console.log('===========================================\n');

    process.exit(0);
  } catch (err) {
    console.error('\n[FATAL ERROR]', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    db.pragma('foreign_keys = ON');
    db.close();
  }
}

main();
