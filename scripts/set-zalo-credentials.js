/**
 * Script cấu hình Zalo OA credentials (không hardcode secret trong code).
 *
 * Dùng:
 *   node scripts/set-zalo-credentials.js zalo_oa_app_id=4282852045406812491 zalo_oa_secret_key=XXXX
 *
 * Giá trị được truyền qua argv nên KHÔNG nằm trong source/git.
 * Script in ra giá trị đã lưu (secret được che 1 phần).
 */

require('dotenv').config({ path: __dirname + '/../.env' });
const db = require('../database');

const ALLOWED = new Set([
  'zalo_oa_app_id',
  'zalo_oa_secret_key',
  'zalo_oa_access_token',
  'zalo_oa_refresh_token',
  'zalo_report_user_id',
]);

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node scripts/set-zalo-credentials.js key=value [key=value ...]');
  console.error('Allowed keys:', [...ALLOWED].join(', '));
  process.exit(1);
}

const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
let count = 0;

for (const arg of args) {
  const idx = arg.indexOf('=');
  if (idx < 1) {
    console.error('✗ Bỏ qua (không đúng định dạng key=value):', arg);
    continue;
  }
  const key = arg.slice(0, idx).trim();
  const value = arg.slice(idx + 1).trim();

  if (!ALLOWED.has(key)) {
    console.error('✗ Key không được phép:', key);
    continue;
  }
  if (!value) {
    console.error('✗ Giá trị rỗng, bỏ qua:', key);
    continue;
  }

  stmt.run(key, value);
  const shown = key.includes('secret') || key.includes('token')
    ? value.slice(0, 4) + '...(' + value.length + ' ký tự)'
    : value;
  console.log('✓ SET', key, '=', shown);
  count++;
}

console.log(`\nĐã cập nhật ${count} setting.`);
process.exit(0);
