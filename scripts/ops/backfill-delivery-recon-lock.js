/**
 * Backfill khoá đối soát cho các phiếu giao ĐÃ có số liệu (production).
 * ─────────────────────────────────────────────────────────────────────────────
 * BỐI CẢNH:
 *  Migration 068 thêm `reconciled_at` / `reconciled_by` / `confirmed_by`.
 *  Phiếu giao đã có số liệu TRƯỚC khi có migration (đã giao, đã thu vỏ)
 *  → `confirmed_by`/`reconciled_at` NULL → chưa bị khoá → tài xế có thể sửa.
 *
 *  Script này đánh dấu các phiếu đó là ĐÃ XÁC NHẬN / ĐÃ ĐỐI SOÁT, dựa trên:
 *   - `status IN ('DELIVERED','DISCREPANCY')` và có số liệu thực tế
 *     (`collected_kegs > 0` HOẶC `delivered_liters > 0` HOẶC có item đã giao)
 *   - hoặc đã có event `CONFIRMED` trong `delivery_events`.
 *
 * AN TOÀN: idempotent (chỉ cập nhật dòng có giá trị NULL).
 * Dùng `--dry-run` (mặc định) để xem trước, `--apply` để ghi thật.
 *
 * Usage:
 *   node scripts/ops/backfill-delivery-recon-lock.js --dry-run
 *   node scripts/ops/backfill-delivery-recon-lock.js --apply
 */

const db = require('../../database');

const APPLY = process.argv.includes('--apply');

// ── 1. Tìm phiếu đã có số liệu nhưng chưa khoá ────────────────────────────
const candidates = db
  .prepare(
    `SELECT dr.id, dr.sale_id, dr.customer_id, dr.driver_username, dr.status,
            dr.delivered_liters, dr.collected_kegs, dr.completed_at,
            (SELECT COUNT(*) FROM delivery_record_items i
              WHERE i.delivery_id = dr.id AND i.delivered_quantity > 0) AS items_delivered,
            (SELECT COUNT(*) FROM delivery_events e
              WHERE e.delivery_id = dr.id AND e.event_type = 'CONFIRMED') AS confirm_events
       FROM delivery_records dr
      WHERE (dr.confirmed_by IS NULL OR dr.confirmed_by = '')
        AND (dr.reconciled_at IS NULL OR dr.reconciled_at = '')
        AND (
              dr.status IN ('DELIVERED', 'DISCREPANCY')
           OR COALESCE(dr.collected_kegs, 0) > 0
           OR COALESCE(dr.delivered_liters, 0) > 0
           OR EXISTS (SELECT 1 FROM delivery_record_items i
                       WHERE i.delivery_id = dr.id AND i.delivered_quantity > 0)
        )`
  )
  .all();

console.log(`[BACKFILL] Số phiếu cần khoá: ${candidates.length}`);

if (!candidates.length) {
  console.log('[BACKFILL] Không có phiếu nào cần khoá — hoàn tất.');
  process.exit(0);
}

// In tóm tắt theo trạng thái
const byStatus = {};
for (const r of candidates) {
  byStatus[r.status] = (byStatus[r.status] || 0) + 1;
}
console.log('[BACKFILL] Theo trạng thái:', byStatus);

if (!APPLY) {
  console.log('[BACKFILL] DRY-RUN — chưa ghi gì. Thêm --apply để thực thi.');
  console.table(
    candidates.slice(0, 20).map((r) => ({
      id: r.id,
      sale_id: r.sale_id,
      status: r.status,
      driver: r.driver_username,
      liters: r.delivered_liters,
      kegs: r.collected_kegs,
      items_delivered: r.items_delivered,
      confirm_events: r.confirm_events,
    }))
  );
  process.exit(0);
}

// ── 2. Ghi khoá (idempotent) ──────────────────────────────────────────────
const update = db.prepare(
  `UPDATE delivery_records
      SET confirmed_by   = COALESCE(NULLIF(confirmed_by, ''), ?),
          reconciled_at  = COALESCE(NULLIF(reconciled_at, ''), ?),
          reconciled_by  = COALESCE(NULLIF(reconciled_by, ''), ?)
    WHERE id = ?`
);

const now = db.getVietnamDateStr() + ' ' + db.getVietnamTimeStr();
let updated = 0;

const tx = db.transaction((rows) => {
  for (const r of rows) {
    // Người xác nhận: tài xế đã giao (ưu tiên) → 'system' nếu không rõ.
    const actor = r.driver_username || 'system';
    const info = update.run(actor, now, actor, r.id);
    updated += info.changes;
  }
});
tx(candidates);

console.log(`[BACKFILL] Đã khoá ${updated} phiếu giao (thời điểm: ${now})`);
process.exit(0);
