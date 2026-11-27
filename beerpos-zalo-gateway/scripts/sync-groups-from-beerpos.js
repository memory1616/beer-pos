#!/usr/bin/env node
/**
 * Script đồng bộ mapping khách ↔ nhóm từ BeerPOS sang Gateway.
 *
 * MỤC TIÊU:
 *  Giúp chuyển đổi an toàn sang Gateway mà KHÔNG phải nhập tay 100 khách hàng.
 *  Đọc bảng `debt_customer_groups` của BeerPOS (platform = 'zalo_personal',
 *  status = 'active') → ghi vào `gateway_groups` của Gateway qua REST API.
 *
 * ⚠️ AN TOÀN:
 *  - CHỈ ĐỌC từ BeerPOS → không sửa gì trong BeerPOS.
 *  - KHÔNG ghi đè mapping đang tồn tại ở Gateway (bỏ qua & báo cáo).
 *  - Có `--dry-run` để xem trước trước khi ghi.
 *
 * CÁCH DÙNG:
 *   node scripts/sync-groups-from-beerpos.js --dry-run
 *   node scripts/sync-groups-from-beerpos.js --yes
 *
 * Môi trường:
 *   GATEWAY_URL       (mặc định http://localhost:3100)
 *   GATEWAY_API_KEY   (bắt buộc — API key quản trị của Gateway)
 */

const fs = require('fs');
const path = require('path');

// ── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ASSUME_YES = args.includes('--yes');
const CSV_OUT = (() => {
  const i = args.indexOf('--csv');
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();

// ── Cấu hình ────────────────────────────────────────────────────────────────

const GATEWAY_URL = String(process.env.GATEWAY_URL || 'http://localhost:3100').replace(/\/+$/, '');
const GATEWAY_API_KEY = String(process.env.GATEWAY_API_KEY || '').trim();

if (!GATEWAY_API_KEY) {
  console.error('[SYNC] Thiếu GATEWAY_API_KEY (API key quản trị của Gateway).');
  process.exit(1);
}

// ── Đọc BeerPOS ─────────────────────────────────────────────────────────────

/**
 * Đọc mapping từ BeerPOS.
 * @returns {Array<{customerId:string, customerName:string, groupId:string, groupName:string}>}
 */
function readBeerPosGroups() {
  let db;
  try {
    // eslint-disable-next-line global-require
    db = require(path.join(__dirname, '..', '..', 'database'));
  } catch (e) {
    console.error('[SYNC] Không mở được database BeerPOS:', e.message);
    process.exit(1);
  }

  try {
    const rows = db
      .prepare(
        `SELECT g.customer_id, g.group_id, g.group_name, c.name AS customer_name
           FROM debt_customer_groups g
           LEFT JOIN customers c ON c.id = g.customer_id
          WHERE g.platform = 'zalo_personal'
            AND g.status = 'active'
            AND g.group_id IS NOT NULL
            AND TRIM(g.group_id) <> ''
          ORDER BY g.customer_id ASC`
      )
      .all();

    return rows.map((r) => ({
      customerId: String(r.customer_id),
      customerName: r.customer_name || `Khách #${r.customer_id}`,
      groupId: String(r.group_id).trim(),
      groupName: r.group_name || null,
    }));
  } finally {
    try {
      db.close();
    } catch (_) {
      /* ignore */
    }
  }
}

// ── Gọi Gateway ─────────────────────────────────────────────────────────────

async function gwFetch(method, urlPath, body, extraHeaders) {
  const headers = {
    Accept: 'application/json',
    'X-API-Key': GATEWAY_API_KEY,
    ...(extraHeaders || {}),
  };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(GATEWAY_URL + urlPath, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

// ── Chính ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('[SYNC] Nguồn: BeerPOS (debt_customer_groups)');
  console.log('[SYNC] Đích: Gateway', GATEWAY_URL);

  // 0. Kiểm tra Gateway còn sống.
  const health = await gwFetch('GET', '/health');
  if (!health.ok) {
    console.error('[SYNC] Không gọi được Gateway /health:', health.status);
    process.exit(1);
  }
  console.log('[SYNC] Gateway OK — provider:', health.data?.provider?.provider);

  // 1. Mapping hiện có ở Gateway.
  const existing = await gwFetch('GET', '/api/groups?limit=500');
  if (!existing.ok) {
    console.error('[SYNC] Không đọc được danh sách nhóm:', existing.status);
    process.exit(1);
  }
  const byCustomer = new Map();
  const byGroup = new Set();
  for (const item of existing.data.items || []) {
    byCustomer.set(String(item.customerId).toLowerCase(), item);
    byGroup.add(String(item.groupId));
  }

  // 2. Đọc nguồn.
  const source = readBeerPosGroups();
  console.log(`[SYNC] BeerPOS có ${source.length} liên kết active.`);

  const toCreate = [];
  const skipped = [];
  for (const row of source) {
    const key = row.customerId.toLowerCase();
    if (byCustomer.has(key)) {
      skipped.push({ ...row, reason: 'đã có trong Gateway' });
      continue;
    }
    if (byGroup.has(row.groupId)) {
      skipped.push({ ...row, reason: 'Group ID đã thuộc khách khác' });
      continue;
    }
    toCreate.push(row);
  }

  console.log(`[SYNC] Sẽ tạo ${toCreate.length}, bỏ qua ${skipped.length}.`);
  skipped.forEach((s) => console.log(`  - BỎ QUA ${s.customerId} (${s.groupId}): ${s.reason}`));

  // 3. Xuất CSV (tuỳ chọn) — hữu ích để xem trước & import thủ công.
  if (CSV_OUT) {
    const lines = ['customerId,customerName,groupId,groupName,note'];
    toCreate.forEach((r) => {
      lines.push(
        [r.customerId, r.customerName, r.groupId, r.groupName || '', 'đồng bộ từ BeerPOS'].join(',')
      );
    });
    fs.writeFileSync(CSV_OUT, lines.join('\n'), 'utf8');
    console.log(`[SYNC] Đã xuất CSV: ${CSV_OUT}`);
  }

  if (DRY_RUN) {
    console.log('[SYNC] DRY-RUN — chưa ghi gì vào Gateway.');
    return;
  }
  if (!ASSUME_YES) {
    console.log('[SYNC] Dừng lại. Dùng --yes để ghi thật, hoặc --dry-run để xem trước.');
    return;
  }

  // 4. Ghi từng dòng (bỏ qua dòng lỗi, KHÔNG rollback dòng đã ghi).
  let created = 0;
  let failed = 0;
  for (const row of toCreate) {
    const res = await gwFetch('POST', '/api/groups', {
      customerId: row.customerId,
      customerName: row.customerName,
      groupId: row.groupId,
      groupName: row.groupName || undefined,
      note: 'đồng bộ từ BeerPOS',
    });
    if (res.ok) {
      created += 1;
    } else {
      failed += 1;
      console.error(
        `  - LỖI ${row.customerId} (${row.groupId}):`,
        res.data?.error || res.status
      );
    }
  }

  console.log(`[SYNC] Xong: ${created} tạo mới, ${failed} lỗi, ${skipped.length} bỏ qua.`);
}

main().catch((e) => {
  console.error('[SYNC] THAT BAI:', e && e.message);
  process.exit(1);
});
