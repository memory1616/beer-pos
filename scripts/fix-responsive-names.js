/**
 * Sửa tên file biến thể responsive về dạng chuẩn <base>-<w>.<hash8>.webp
 * (script gen trước đó tạo ra dạng <base>-<w>.tmp.<hash8>.webp).
 *
 * Chạy: node scripts/fix-responsive-names.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = [
  path.join(ROOT, 'public', 'images', 'home'),
  path.join(ROOT, 'public', 'landing-assets'),
];

let changed = 0;
for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^(.*-\d+)\.tmp\.([0-9a-f]{8})(\.webp)$/);
    if (!m) continue;
    const next = `${m[1]}.${m[2]}${m[3]}`;
    fs.renameSync(path.join(dir, f), path.join(dir, next));
    console.log(`[rename] ${f} → ${next}`);
    changed++;
  }
}
console.log(`\nĐã đổi tên ${changed} file.`);
