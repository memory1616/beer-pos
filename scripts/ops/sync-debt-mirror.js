/**
 * Đồng bộ SỔ CÔNG NỢ (ledger) ↔ mirror `customers.debt` — AN TOÀN, CÓ BACKUP.
 *
 * ⚠️ THỨ TỰ BẮT BUỘC (sai thứ tự = MẤT TIỀN):
 *   Bước 1: Migrate OPENING_BALANCE cho khách CHƯA có bút toán nào.
 *            (Khách archive cũng phải migrate — commit 618a3b6 đã sửa lọc archived.)
 *            → Nếu BỎ QUA bước này, đồng bộ mirror ở bước 2 sẽ set mirror=0
 *              cho khách đang có công nợ thật → XOÁ MẤT TIỀN.
 *   Bước 2: Đồng bộ mirror theo ledger cho khách còn lệch.
 *            (Ledger là SSOT — bút toán đã bị xoá khi dọn test là rác, mirror
 *             giữ số cũ → mirror phải được sửa về ledger.)
 *
 * Dùng: node scripts/ops/sync-debt-mirror.js [--apply]
 */
process.env.DISABLE_BACKGROUND_JOBS = '1';

const path = require('path');
const fs = require('fs');
const Database = require(path.join(process.cwd(), 'node_modules', 'better-sqlite3'));

const DB_PATH = path.join(process.cwd(), 'database.sqlite');
const APPLY = process.argv.includes('--apply');

const db = new Database(DB_PATH);

function ledgerBalance(customerId) {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction='INCREASE' THEN amount ELSE -amount END),0) b
         FROM debt_transactions WHERE customer_id = ?`
    )
    .get(customerId);
  return Math.round((r.b || 0) * 100) / 100;
}

function txCount(customerId) {
  return db
    .prepare('SELECT COUNT(*) c FROM debt_transactions WHERE customer_id = ?')
    .get(customerId).c;
}

const allCustomers = db
  .prepare(
    `SELECT id, name, archived, debt FROM customers
      WHERE COALESCE(debt,0) != 0
         OR EXISTS (SELECT 1 FROM debt_transactions dt WHERE dt.customer_id = customers.id)
      ORDER BY id`
  )
  .all();

const plan = [];
for (const c of allCustomers) {
  const n = txCount(c.id);
  const ledger = ledgerBalance(c.id);
  const mirror = Math.round((c.debt || 0) * 100) / 100;
  const diff = Math.round((mirror - ledger) * 100) / 100;

  let action = null;
  if (n === 0 && Math.abs(diff) > 0.5) {
    action = 'MIGRATE_OPENING_BALANCE'; // chưa có bút toán → tạo OPENING_BALANCE
  } else if (Math.abs(diff) > 0.5) {
    action = 'SYNC_MIRROR'; // đã có bút toán → mirror theo ledger
  }
  if (action) {
    plan.push({ ...c, mirror, ledger, diff, txCount: n, action });
  }
}

console.log('\n=== KẾ HOẠCH ĐỒNG BỘ SỔ CÔNG NỢ ===');
console.log(
  'id  | tên                    | arch | mirror      | ledger      | lệch      | hành động'
);
for (const p of plan) {
  console.log(
    `${String(p.id).padEnd(3)} | ${String(p.name).slice(0, 22).padEnd(22)} | ` +
      `${p.archived}    | ${String(p.mirror).padEnd(11)} | ${String(p.ledger).padEnd(11)} | ` +
      `${String(p.diff).padEnd(9)} | ${p.action}`
  );
}
console.log(`\nTổng cần xử lý: ${plan.length} khách.`);

if (!APPLY) {
  console.log('\n(Dry-run) Thêm --apply để thực hiện.');
  process.exit(0);
}

// ── BACKUP ──────────────────────────────────────────────────────────────────
const TS = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const BACKUP = path.join(process.cwd(), 'backups', `database.sqlite.pre-debt-sync.${TS}.bak`);
fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
// ⚠️ VACUUM INTO (không copyFile) — DB ở chế độ WAL nên copy thô sẽ thiếu
// các transaction chưa checkpoint (mất đơn hàng mới nhất trong backup).
db.exec(`VACUUM INTO '${BACKUP.replace(/'/g, "''")}'`);
console.log('\n✅ Backup:', BACKUP);

const DebtAccountService = require('../../src/services/debt/DebtAccountService');
const DebtAuditService = require('../../src/services/debt/DebtAuditService');

// ── BƯỚC 1: MIGRATE OPENING BALANCE ─────────────────────────────────────────
console.log('\n=== BƯỚC 1: MIGRATE OPENING BALANCE (khách chưa có bút toán) ===');
for (const p of plan.filter((x) => x.action === 'MIGRATE_OPENING_BALANCE')) {
  const r = DebtAccountService.setOpeningBalance(p.id, p.mirror, {
    createdBy: 'system:sync-debt-mirror',
    source: 'MIGRATION',
    description: `Migrate số dư công nợ hiện có (${p.mirror.toLocaleString('vi-VN')}đ) vào sổ công nợ`,
    idempotencyKey: `opening_balance:${p.id}`,
    allowArchivedCustomer: true,
  });
  console.log(
    `  [#${p.id}] ${p.name}: ${p.mirror.toLocaleString('vi-VN')}đ → ` +
      `${r.success ? 'OK' : 'LỖI: ' + r.error}` +
      (r.duplicate ? ' (đã tồn tại - idempotent)' : '')
  );
}

// ── BƯỚC 2: ĐỒNG BỘ MIRROR THEO LEDGER ─────────────────────────────────────
console.log('\n=== BƯỚC 2: ĐỒNG BỘ MIRROR THEO LEDGER ===');
for (const p of plan.filter((x) => x.action === 'SYNC_MIRROR')) {
  const bal = ledgerBalance(p.id);
  db.prepare('UPDATE customers SET debt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(bal, p.id);
  DebtAuditService.record({
    action: 'RECONCILE_FIX',
    actorId: 'system:sync-debt-mirror',
    beforeData: { customerId: p.id, mirrorDebt: p.mirror, syncSource: 'debt_ledger' },
    afterData: { customerId: p.id, mirrorDebt: bal, synced: true },
  });
  console.log(
    `  [#${p.id}] ${p.name}: ${p.mirror.toLocaleString('vi-VN')}đ → ` +
      `${bal.toLocaleString('vi-VN')}đ`
  );
}

// ── VERIFY ──────────────────────────────────────────────────────────────────
console.log('\n=== KIỂM TRA LẠI (tất cả khách, kể cả archive) ===');
const check = db
  .prepare(
    `SELECT c.id, c.name, c.archived, c.debt AS mirror,
            (SELECT COALESCE(SUM(CASE WHEN dt.direction='INCREASE' THEN dt.amount ELSE -dt.amount END),0)
               FROM debt_transactions dt WHERE dt.customer_id=c.id) AS ledger
       FROM customers c
      WHERE COALESCE(c.debt,0) != 0
         OR EXISTS (SELECT 1 FROM debt_transactions dt WHERE dt.customer_id=c.id)
      ORDER BY c.id`
  )
  .all();

const bad = check.filter((r) => Math.abs((r.mirror || 0) - r.ledger) > 0.5);
console.log(`Tổng khách có công nợ: ${check.length} | Còn lệch: ${bad.length}`);
console.table(check);
if (bad.length) {
  console.log('⚠️  VẪN CÒN LỆCH:');
  console.table(bad);
} else {
  console.log('✅ Mirror khớp 100% với sổ công nợ.');
}

const totals = db
  .prepare(
    `SELECT (SELECT COALESCE(SUM(debt),0) FROM customers) AS mirror_total,
            (SELECT COALESCE(SUM(CASE WHEN direction='INCREASE' THEN amount ELSE -amount END),0)
               FROM debt_transactions) AS ledger_total,
            (SELECT COUNT(*) FROM debt_transactions) AS tx_count`
  )
  .get();
console.log(
  `\nTổng công nợ: mirror=${totals.mirror_total.toLocaleString('vi-VN')}đ ` +
    `| ledger=${totals.ledger_total.toLocaleString('vi-VN')}đ ` +
    `| ${totals.tx_count} bút toán`
);

db.close();
process.exit(0);
