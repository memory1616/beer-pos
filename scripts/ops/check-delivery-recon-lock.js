/**
 * Kiểm tra trạng thái khoá đối soát của các phiếu giao hiện có.
 * Script kiểm tra (read-only) — dùng để quyết định có cần backfill hay không.
 */
// [DB GUARD] Chống ghi nhầm vào DB vận hành (2026-11-27).
// [DB GUARD] Chạy trên bản sao: set DB_PATH=<file .sqlite sao>
// [DB GUARD] Ghi có chủ đích lên DB thật: node check-delivery-recon-lock.js --allow-prod-write
const guard = require('../../src/utils/dbWriteGuard');
guard.requireSafeDb({ context: 'chỉ đọc: check-delivery-recon-lock.js', allowWrite: false });
const db = require('../../database');

const rows = db
  .prepare(
    `SELECT status,
            COUNT(*) AS total,
            SUM(CASE WHEN confirmed_by IS NOT NULL AND confirmed_by <> '' THEN 1 ELSE 0 END) AS has_confirmed_by,
            SUM(CASE WHEN reconciled_at IS NOT NULL AND reconciled_at <> '' THEN 1 ELSE 0 END) AS has_reconciled_at,
            SUM(CASE WHEN collected_kegs > 0 OR delivered_liters > 0 THEN 1 ELSE 0 END) AS has_figures
       FROM delivery_records
      GROUP BY status
      ORDER BY status`
  )
  .all();

console.table(rows);

const pending = db
  .prepare(
    `SELECT COUNT(*) AS c
       FROM delivery_records
      WHERE (confirmed_by IS NULL OR confirmed_by = '')
        AND (reconciled_at IS NULL OR reconciled_at = '')
        AND (COALESCE(collected_kegs, 0) > 0 OR COALESCE(delivered_liters, 0) > 0)`
  )
  .get();

console.log(
  `Phiếu đã có số liệu nhưng CHƯA khoá (có thể sửa tự do): ${pending?.c || 0}`
);

process.exit(0);
