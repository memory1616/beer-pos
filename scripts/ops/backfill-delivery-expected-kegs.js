/**
 * Backfill đồng bộ `expected_quantity` / `expected_kegs` cho phiếu giao ĐÃ GIAO.
 * ─────────────────────────────────────────────────────────────────────────────
 * BỐI CẢNH:
 *  `DeliveryService.syncRecordWithSaleItems()` trước đây CHỈ đồng bộ phiếu
 *  `PENDING | IN_PROGRESS | DISCREPANCY` → bỏ qua `DELIVERED`.
 *  Hệ quả: khi Admin sửa đơn ĐÃ GIAO (đổi số lượng), `sales.deliver_kegs`
 *  được cập nhật nhưng `delivery_records.expected_kegs` và
 *  `delivery_record_items.expected_quantity` vẫn giữ số CŨ →
 *  trang Giao hàng của tài xế hiển thị sai "Cần giao: N".
 *
 *  Script này quét lại toàn bộ đơn và đồng bộ các phiếu lệch.
 *  ⚠️ KHÔNG đụng `delivered_quantity` (giữ nguyên lịch sử giao thực tế).
 *
 * AN TOÀN: idempotent (chỉ cập nhật dòng có giá trị khác).
 * Dùng `--dry-run` (mặc định) để xem trước, `--apply` để ghi thật.
 *
 * Usage:
 *   node scripts/ops/backfill-delivery-expected-kegs.js --dry-run
 *   node scripts/ops/backfill-delivery-expected-kegs.js --apply
 */

// [DB GUARD] Chống ghi nhầm vào DB vận hành (2026-11-27).
// [DB GUARD] Chạy trên bản sao: set DB_PATH=<file .sqlite sao>
// [DB GUARD] Ghi có chủ đích lên DB thật: node backfill-delivery-expected-kegs.js --allow-prod-write
const guard = require('../../src/utils/dbWriteGuard');
guard.requireSafeDb({ context: 'chỉ đọc: backfill-delivery-expected-kegs.js', allowWrite: false });
const db = require('../../database');
const DeliveryService = require('../../src/services/DeliveryService');

const APPLY = process.argv.includes('--apply');

// ── 1. Tìm các phiếu có khả năng lệch ────────────────────────────────────
const candidates = db
  .prepare(
    `SELECT dr.id, dr.sale_id, dr.status, dr.expected_kegs,
            (SELECT COUNT(*) FROM delivery_record_items i
              WHERE i.delivery_id = dr.id) AS item_count
       FROM delivery_records dr
      WHERE dr.sale_id IS NOT NULL
        AND dr.status IN ('PENDING', 'IN_PROGRESS', 'DISCREPANCY', 'DELIVERED')`
  )
  .all();

console.log(`[BACKFILL] Tổng số phiếu cần kiểm tra: ${candidates.length}`);
if (!candidates.length) {
  console.log('[BACKFILL] Không có phiếu nào — hoàn tất.');
  process.exit(0);
}

// ── 2. Tính lại expected từ sale_items hiện tại ───────────────────────────
const getExpected = db.prepare(
  `SELECT si.product_id, si.product_slug,
          COALESCE(p.name, si.product_slug, '') AS product_name,
          COALESCE(si.quantity, 0) AS quantity,
          COALESCE(p.type, '') AS product_type
     FROM sale_items si
     LEFT JOIN products p ON p.id = si.product_id
    WHERE si.sale_id = ?`
);

let changedRecords = 0;
let changedRows = 0;
const details = [];

for (const rec of candidates) {
  const items = getExpected.all(rec.sale_id);
  if (!items.length) continue;

  const expectedKegs = items
    .filter((i) => i.product_type !== 'pet')
    .reduce((sum, i) => sum + (i.quantity || 0), 0);

  const before = db
    .prepare('SELECT * FROM delivery_record_items WHERE delivery_id = ? ORDER BY id')
    .all(rec.id);
  const beforeRec = db
    .prepare('SELECT expected_kegs FROM delivery_records WHERE id = ?')
    .get(rec.id);

  const byProduct = new Map();
  for (const it of items) {
    const key = it.product_id != null ? `id:${it.product_id}` : `name:${it.product_name || ''}`;
    const prev = byProduct.get(key);
    if (prev) prev.quantity += it.quantity || 0;
    else {
      byProduct.set(key, {
        product_id: it.product_id,
        product_name: it.product_name || '',
        quantity: it.quantity || 0,
        product_type: it.product_type || '',
      });
    }
  }

  // So sánh expected_quantity của từng dòng
  const diffs = [];
  const seen = new Set();
  for (const ex of before) {
    const key = ex.product_id != null ? `id:${ex.product_id}` : `name:${ex.product_name || ''}`;
    const match = byProduct.get(key);
    if (match) {
      seen.add(key);
      if ((ex.expected_quantity || 0) !== match.quantity) {
        diffs.push({ id: ex.id, from: ex.expected_quantity || 0, to: match.quantity });
      }
    } else if ((ex.expected_quantity || 0) !== 0) {
      diffs.push({ id: ex.id, from: ex.expected_quantity || 0, to: 0 });
    }
  }
  // Sản phẩm mới trong đơn (chưa có dòng)
  for (const [key, m] of byProduct.entries()) {
    if (seen.has(key)) continue;
    const alreadyByName = before.some(
      (ex) => ex.product_id == null && ex.product_name === m.product_name
    );
    if (alreadyByName) continue;
    diffs.push({ id: null, name: m.product_name, from: 0, to: m.quantity, isNew: true });
  }

  const kegsChanged = (beforeRec.expected_kegs || 0) !== expectedKegs;
  if (!diffs.length && !kegsChanged) continue;

  changedRecords++;
  changedRows += diffs.length;
  details.push({
    delivery_id: rec.id,
    sale_id: rec.sale_id,
    status: rec.status,
    expected_kegs: `${beforeRec.expected_kegs || 0} → ${expectedKegs}`,
    diffs,
  });
}

console.log(`[BACKFILL] Phiếu có thay đổi: ${changedRecords}`);
console.log(`[BACKFILL] Tổng dòng item cần cập nhật: ${changedRows}`);

if (!APPLY) {
  console.log('[BACKFILL] DRY-RUN — chưa ghi. Dùng --apply để thực thi.');
  for (const d of details.slice(0, 30)) {
    console.log(
      `  - delivery#${d.delivery_id} sale#${d.sale_id} [${d.status}] kegs ${d.expected_kegs}` +
        ` | ${d.diffs.map((x) => `${x.isNew ? 'NEW' : `#${x.id}`} ${x.from}→${x.to}`).join(', ')}`
    );
  }
  if (details.length > 30) console.log(`  ... và ${details.length - 30} phiếu nữa`);
  process.exit(0);
}

// ── 3. Ghi thật (dùng lại logic của DeliveryService để nhất quán) ─────────
for (const d of details) {
  const res = DeliveryService.syncRecordWithSaleItems(d.sale_id);
  if (!res.success) {
    console.log(`  [ERR] sale#${d.sale_id}: ${res.error}`);
  }
}

// ── 4. Verify ────────────────────────────────────────────────────────────
const verify = db
  .prepare(
    `SELECT dr.id, dr.expected_kegs,
            (SELECT COALESCE(SUM(i.expected_quantity), 0) FROM delivery_record_items i
              WHERE i.delivery_id = dr.id) AS sum_expected
       FROM delivery_records dr
      WHERE dr.sale_id = ?`
  )
  .all(details[0]?.sale_id || 0);
console.log('[BACKFILL] Verify mẫu:', JSON.stringify(verify.slice(0, 3)));
console.log('[BACKFILL] HOÀN TẤT.');
