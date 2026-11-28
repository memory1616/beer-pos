/**
 * Backfill `delivery_records.scheduled_date` cho đơn ĐẶT TRƯỚC (production).
 * ─────────────────────────────────────────────────────────────────────────────
 * BỐI CẢNH (lỗi phát hiện 2026-11-28):
 *  `DeliveryService.ensureRecord()` gán `scheduled_date = sale.created_on`
 *  (ngày LẬP đơn) cho MỌI đơn — kể cả đơn ĐẶT TRƯỚC.
 *
 *  Đơn đặt trước có ngày giao = `preorder_date` (đặt hôm nay, giao ngày mai)
 *  → phiếu giao bị ghi sai ngày, lệch TRƯỚC 1 ngày so với ngày giao thực.
 *
 *  Hệ quả:
 *   - Tài xế không thấy đơn ở màn "Giao hàng" của ĐÚNG ngày giao.
 *   - Khoá sửa theo ngày giao (EDIT_LOCKED_PAST_DAY) lệch 1 ngày.
 *
 *  ĐÃ SỬA trong code: `DeliveryService.getScheduledDateForSale()` — đơn đặt
 *  trước dùng `preorder_date`. Script này sửa DỮ LIỆU CŨ đã ghi sai.
 *
 * AN TOÀN:
 *   - Idempotent (chỉ cập nhật dòng lệch).
 *   - `--dry-run` (mặc định) để xem trước, `--apply` để ghi thật.
 *   - CHỈ sửa phiếu của đơn đặt trước ĐÃ RELEASED.
 *   - KHÔNG đụng phiếu chưa giao (status PENDING/IN_PROGRESS/FAILED) —
 *     những phiếu đó sẽ tự đúng sau khi deploy (phiếu mới tạo đúng ngày).
 *
 * Usage:
 *   node scripts/ops/backfill-preorder-delivery-date.js --dry-run
 *   node scripts/ops/backfill-preorder-delivery-date.js --apply
 */

// [DB GUARD] Chống ghi nhầm vào DB vận hành (2026-11-27).
// [DB GUARD] Chạy trên bản sao: set DB_PATH=<file .sqlite sao>
// [DB GUARD] Ghi có chủ đích lên DB thật: node backfill-preorder-delivery-date.js --allow-prod-write
const guard = require('../../src/utils/dbWriteGuard');
guard.requireSafeDb({ context: 'ghi dữ liệu: backfill-preorder-delivery-date.js', allowWrite: true });
const db = require('../../database');

const APPLY = process.argv.includes('--apply');

// ── 1. Tìm phiếu lệch ngày ────────────────────────────────────────────────
const candidates = db
  .prepare(
    `SELECT dr.id AS delivery_id,
            dr.sale_id,
            dr.driver_username,
            dr.status,
            dr.scheduled_date AS ngay_ghi_hien_tai,
            s.preorder_date AS ngay_giao_dung,
            dr.completed_at,
            dr.reconciled_at,
            c.name AS customer_name
       FROM delivery_records dr
       JOIN sales s ON s.id = dr.sale_id
       LEFT JOIN customers c ON c.id = dr.customer_id
      WHERE s.preorder_status = 'RELEASED'
        AND s.preorder_date IS NOT NULL
        AND dr.scheduled_date IS NOT NULL
        AND dr.scheduled_date != s.preorder_date
      ORDER BY dr.id`
  )
  .all();

console.log(`\n=== Phiếu giao của đơn đặt trước bị lệch ngày: ${candidates.length} ===`);
if (!candidates.length) {
  console.log('Không có phiếu nào cần sửa. OK.');
  process.exit(0);
}

console.table(
  candidates.map((c) => ({
    dr_id: c.delivery_id,
    sale_id: c.sale_id,
    khach: c.customer_name,
    status: c.status,
    ngay_giao_dung: c.ngay_giao_dung,
    ngay_ghi_hien_tai: c.ngay_ghi_hien_tai,
    completed_at: c.completed_at || '',
  }))
);

// ── 2. Phân loại: đã giao (an toàn sửa) vs chưa giao (để nguyên) ───────────
const delivered = candidates.filter((c) => c.completed_at);
const notDelivered = candidates.filter((c) => !c.completed_at);

if (notDelivered.length) {
  console.log(`\n⚠️  ${notDelivered.length} phiếu CHƯA giao (completed_at rỗng) → BỎ QUA.`);
  console.log('   Phiếu mới tạo sau khi deploy sẽ tự dùng đúng ngày giao.');
  console.table(
    notDelivered.map((c) => ({
      dr_id: c.delivery_id,
      sale_id: c.sale_id,
      khach: c.customer_name,
      status: c.status,
      ngay_giao_dung: c.ngay_giao_dung,
      ngay_ghi_hien_tai: c.ngay_ghi_hien_tai,
    }))
  );
}

if (!delivered.length) {
  console.log('\nKhông có phiếu đã giao nào cần sửa.');
  process.exit(0);
}

// ── 3. Ghi ─────────────────────────────────────────────────────────────────
const update = db.prepare(
  `UPDATE delivery_records
      SET scheduled_date = ?, updated_at = datetime('now')
    WHERE id = ? AND scheduled_date = ?`
);

const applyChanges = db.transaction(() => {
  let changed = 0;
  for (const c of delivered) {
    const res = update.run(c.ngay_giao_dung, c.delivery_id, c.ngay_ghi_hien_tai);
    if (res.changes > 0) changed++;
  }
  return changed;
});

if (!APPLY) {
  console.log(`\n🔍 DRY-RUN: sẽ sửa ${delivered.length} phiếu (đã giao) sang ngày giao đúng.`);
  console.log('   Chạy lại với --apply để ghi thật.');
  process.exit(0);
}

const changed = applyChanges();
console.log(`\n✅ Đã sửa ${changed}/${delivered.length} phiếu giao.`);

// ── 4. Verify ─────────────────────────────────────────────────────────────
const remaining = db
  .prepare(
    `SELECT COUNT(*) AS c
       FROM delivery_records dr
       JOIN sales s ON s.id = dr.sale_id
      WHERE s.preorder_status = 'RELEASED'
        AND s.preorder_date IS NOT NULL
        AND dr.scheduled_date IS NOT NULL
        AND dr.scheduled_date != s.preorder_date`
  )
  .get();

console.log(`Còn lại phiếu lệch (chưa giao): ${remaining.c}`);
console.log('Hoàn tất.');
