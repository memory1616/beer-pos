#!/usr/bin/env node
/**
 * Script migrate số dư công nợ cũ vào SỔ CÁI (GĐ1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Chuyển `customers.debt` (dữ liệu nhập tay) thành bút toán `OPENING_BALANCE`
 * trong `debt_transactions`, để sổ công nợ có nguồn sự thật truy vết được.
 *
 * AN TOÀN:
 *  - IDEMPOTENT: chạy lại nhiều lần không tạo bản ghi trùng.
 *  - KHÔNG sửa `customers.debt` (giữ nguyên giá trị → không mất tiền).
 *  - BỎ QUA khách đã có bút toán trong ledger.
 *  - Có `--dry-run` để xem trước khi ghi.
 *
 * Dùng:
 *   node scripts/migrate-debt-opening-balance.js --dry-run
 *   node scripts/migrate-debt-opening-balance.js
 */

process.env.TZ = 'Asia/Ho_Chi_Minh';

const db = require('../database');
const DebtAccountService = require('../src/services/debt/DebtAccountService');
const DebtLedgerService = require('../src/services/debt/DebtLedgerService');

const dryRun = process.argv.includes('--dry-run');

function money(n) {
  return Number(n || 0).toLocaleString('vi-VN') + 'đ';
}

function main() {
  console.log('════════════════════════════════════════════════════════════');
  console.log(' MIGRATE SỐ DƯ CÔNG NỢ CŨ → SỔ CÁI (debt_transactions)');
  console.log(` Chế độ: ${dryRun ? 'DRY-RUN (không ghi)' : 'GHI THẬT'}`);
  console.log('════════════════════════════════════════════════════════════\n');

  // Tổng quan trước khi migrate
  const before = {
    mirrorSum: db.prepare('SELECT COALESCE(SUM(debt),0) s FROM customers WHERE archived = 0').get().s,
    ledgerSum: DebtLedgerService.computeBalance
      ? db
          .prepare(
            "SELECT COALESCE(SUM(CASE WHEN direction='INCREASE' THEN amount ELSE -amount END),0) s FROM debt_transactions"
          )
          .get().s
      : 0,
    txCount: db.prepare('SELECT COUNT(*) c FROM debt_transactions').get().c,
  };

  console.log('── TRƯỚC ──');
  console.log(`  customers.debt tổng : ${money(before.mirrorSum)}`);
  console.log(`  ledger balance tổng : ${money(before.ledgerSum)}`);
  console.log(`  số bút toán ledger  : ${before.txCount}\n`);

  const result = DebtAccountService.migrateOpeningBalances({
    actorId: 'system:migrate-debt-opening-balance',
    dryRun,
  });

  console.log('── KẾT QUẢ ──');
  console.log(`  Tổng khách cần migrate : ${result.total}`);
  console.log(`  Đã migrate            : ${result.migrated}`);
  console.log(`  Bỏ qua (đã có ledger) : ${result.skipped}`);
  if (result.errors.length) {
    console.log(`  LỖI (${result.errors.length}):`);
    for (const e of result.errors) {
      console.log(`    - [${e.customerId}] ${e.name}: ${e.error}`);
    }
  }
  console.log('');

  const after = {
    mirrorSum: db.prepare('SELECT COALESCE(SUM(debt),0) s FROM customers WHERE archived = 0').get().s,
    ledgerSum: db
      .prepare(
        "SELECT COALESCE(SUM(CASE WHEN direction='INCREASE' THEN amount ELSE -amount END),0) s FROM debt_transactions"
      )
      .get().s,
    txCount: db.prepare('SELECT COUNT(*) c FROM debt_transactions').get().c,
  };

  console.log('── SAU ──');
  console.log(`  customers.debt tổng : ${money(after.mirrorSum)}`);
  console.log(`  ledger balance tổng : ${money(after.ledgerSum)}`);
  console.log(`  số bút toán ledger  : ${after.txCount}\n`);

  // Kiểm tra toàn vẹn: mirror phải khớp ledger cho từng khách có ledger
  const mismatches = db
    .prepare(
      `SELECT c.id, c.name, c.debt AS mirror,
              COALESCE(SUM(CASE WHEN dt.direction='INCREASE' THEN dt.amount ELSE -dt.amount END),0) AS ledger
         FROM customers c
         JOIN debt_transactions dt ON dt.customer_id = c.id
        WHERE c.archived = 0
        GROUP BY c.id
        HAVING ABS(c.debt - ledger) > 0.01`
    )
    .all();

  if (mismatches.length) {
    console.log('⚠️  LỆCH mirror vs ledger:');
    for (const m of mismatches) {
      console.log(`    - [${m.id}] ${m.name}: mirror=${money(m.mirror)} ledger=${money(m.ledger)}`);
    }
    process.exitCode = 1;
  } else {
    console.log('✅ Toàn vẹn OK — customers.debt khớp 100% với ledger.');
  }

  process.exit(process.exitCode || 0);
}

main();
