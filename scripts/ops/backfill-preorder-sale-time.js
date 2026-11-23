#!/usr/bin/env node
/**
 * Backfill: đặt `sale_time` = 00:00:00 cho đơn ĐẶT TRƯỚC
 * ─────────────────────────────────────────────────────────────────────────────
 * YÊU CẦU NGHIỆP VỤ (2026-11-23):
 *  "Thời gian của đơn đặt trước là 0h ngày đặt trước".
 *
 *  Đơn đặt trước tạo trước khi sửa có `sale_time` = giờ lập đơn thực tế
 *  (VD "19:34:40") → không nhất quán với đơn đặt trước mới (00:00:00).
 *  Script này đưa đơn cũ về 00:00:00 cho nhất quán.
 *
 *  ⚠️ CHỈ sửa đơn CÓ `preorder_status` (SCHEDULED / RELEASED).
 *     Đơn thường giữ nguyên giờ thực tế.
 *
 * CÁCH DÙNG:
 *   node scripts/ops/backfill-preorder-sale-time.js            # chạy
 *   node scripts/ops/backfill-preorder-sale-time.js --dry-run  # chỉ xem
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const path = require('path');
const Database = require(path.join(process.cwd(), 'node_modules', 'better-sqlite3'));

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'database.sqlite');

const dryRun = process.argv.includes('--dry-run');

const db = new Database(DB_PATH);

console.log(`[backfill-preorder-sale-time] DB: ${DB_PATH}`);
console.log(`[backfill-preorder-sale-time] mode: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);

const rows = db
  .prepare(
    `SELECT id, date, sale_time, preorder_date, preorder_status
       FROM sales
      WHERE preorder_status IS NOT NULL
        AND COALESCE(sale_time, '') != '00:00:00'
      ORDER BY id ASC`
  )
  .all();

if (!rows.length) {
  console.log('[backfill-preorder-sale-time] Khong co don nao can sua.');
  process.exit(0);
}

console.log(`[backfill-preorder-sale-time] Canh chinh ${rows.length} don:`);
rows.forEach((r) => {
  console.log(
    `  #${r.id}  ${r.preorder_status}  preorder_date=${r.preorder_date}  ` +
      `sale_time: ${r.sale_time || '(null)'} -> 00:00:00`
  );
});

if (dryRun) {
  console.log('[backfill-preorder-sale-time] DRY-RUN — khong ghi du lieu.');
  process.exit(0);
}

const upd = db.prepare(
  `UPDATE sales
      SET sale_time = '00:00:00',
          updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND preorder_status IS NOT NULL`
);

const run = db.transaction(() => {
  let n = 0;
  for (const r of rows) {
    const res = upd.run(r.id);
    n += res.changes;
  }
  return n;
});

const changed = run();
console.log(`[backfill-preorder-sale-time] Da sua ${changed} don.`);

// Verify
const left = db
  .prepare(
    `SELECT COUNT(*) AS c FROM sales
      WHERE preorder_status IS NOT NULL
        AND COALESCE(sale_time, '') != '00:00:00'`
  )
  .get().c;
console.log(`[backfill-preorder-sale-time] Con lai don chua dung chuan: ${left}`);

db.close();
process.exit(0);
