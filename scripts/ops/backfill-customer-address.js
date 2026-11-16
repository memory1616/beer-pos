#!/usr/bin/env node
/**
 * Backfill địa chỉ cho khách hàng ĐÃ CÓ tọa độ GPS nhưng CHƯA CÓ địa chỉ.
 * ─────────────────────────────────────────────────────────────────────────────
 * DÙNG:
 *   node scripts/ops/backfill-customer-address.js            # chạy thật
 *   node scripts/ops/backfill-customer-address.js --dry-run  # chỉ xem danh sách
 *   node scripts/ops/backfill-customer-address.js --ids=7,9,11
 *
 * GHI CHÚ:
 *   - Dùng `GeocodeService` (server-side) → có cache + dedupe + fallback Esri.
 *   - Xử lý TUẦN TỰ, nghỉ ~1.1s giữa mỗi lần gọi (tôn trọng giới hạn 1 req/s
 *     của Nominatim). Với ~25 khách → khoảng 30 giây.
 *   - KHÔNG ghi đè địa chỉ đã có (chỉ điền khi `address` rỗng).
 */
process.env.DISABLE_BACKGROUND_JOBS = '1';

const path = require('path');
const Database = require(path.join('/var/www/beer-pos', 'node_modules', 'better-sqlite3'));

const DB_PATH = '/var/www/beer-pos/database.sqlite';
const db = new Database(DB_PATH);

const GeocodeService = require(path.join('/var/www/beer-pos', 'src', 'services', 'GeocodeService'));

const DRY_RUN = process.argv.includes('--dry-run');
const idsArg = (process.argv.find((a) => a.startsWith('--ids=')) || '').replace('--ids=', '');

(async () => {
  const ids = idsArg
    ? idsArg.split(',').map((n) => parseInt(n, 10)).filter(Number.isFinite)
    : null;

  const rows = ids && ids.length
    ? db.prepare(
        `SELECT id, name, phone, lat, lng FROM customers
          WHERE id IN (${ids.map(() => '?').join(',')})
            AND lat IS NOT NULL AND lng IS NOT NULL
            AND (address IS NULL OR TRIM(address) = '')
            AND archived = 0 AND deleted = 0`
      ).all(...ids)
    : db.prepare(
        `SELECT id, name, phone, lat, lng FROM customers
          WHERE lat IS NOT NULL AND lng IS NOT NULL
            AND (address IS NULL OR TRIM(address) = '')
            AND archived = 0 AND deleted = 0`
      ).all();

  console.log(`Khách có GPS nhưng thiếu địa chỉ: ${rows.length}`);
  if (!rows.length) return;

  if (DRY_RUN) {
    rows.forEach((r) =>
      console.log(`  #${r.id} ${r.name} — ${Number(r.lat).toFixed(5)}, ${Number(r.lng).toFixed(5)}`)
    );
    console.log('\n(chạy lại không có --dry-run để ghi vào DB)');
    return;
  }

  const result = await GeocodeService.backfillAddresses(db, { ids, all: !ids, delayMs: 1100 });

  console.log(`\nXong: ${result.updated}/${result.total} khách đã có địa chỉ.`);
  result.results.forEach((r) => {
    if (r.error) console.log(`  ❌ #${r.id}: ${r.error}`);
    else console.log(`  ✅ #${r.id}: ${r.address}`);
  });

  const left = db
    .prepare(
      `SELECT COUNT(*) c FROM customers
        WHERE lat IS NOT NULL AND lng IS NOT NULL
          AND (address IS NULL OR TRIM(address) = '')
          AND archived = 0 AND deleted = 0`
    )
    .get();
  console.log(`\nCòn thiếu địa chỉ: ${left.c}`);
})()
  .catch((err) => {
    console.error('Lỗi:', err);
    process.exit(1);
  })
  .finally(() => {
    try { db.close(); } catch (_) {}
    process.exit(0);
  });
