/**
 * Đổi tên file ảnh trong public/images/home/ sang dạng content-hash
 * (tên-<hash8>.webp) để server serve với Cache-Control immutable an toàn.
 * Cập nhật các tham chiếu trong public/landing.html và public/sitemap.xml.
 *
 * Chạy: node scripts/hash-home-images.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'public', 'images', 'home');

if (!fs.existsSync(IMG_DIR)) {
  console.log('[skip] public/images/home/ không tồn tại');
  process.exit(0);
}

const files = fs.readdirSync(IMG_DIR).filter((f) => f.endsWith('.webp'));
const renameMap = {};

for (const f of files) {
  const ext = path.extname(f);
  const base = path.basename(f, ext);
  if (/\.[0-9a-f]{8}$/.test(base)) continue; // đã hash rồi
  const buf = fs.readFileSync(path.join(IMG_DIR, f));
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
  const next = `${base}.${hash}${ext}`;
  fs.renameSync(path.join(IMG_DIR, f), path.join(IMG_DIR, next));
  renameMap[`/images/home/${f}`] = `/images/home/${next}`;
  console.log(`[hash] ${f} → ${next}`);
}

// Cập nhật tham chiếu trong landing.html + sitemap.xml
const targets = [
  path.join(ROOT, 'public', 'landing.html'),
  path.join(ROOT, 'public', 'sitemap.xml'),
];
for (const t of targets) {
  if (!fs.existsSync(t)) continue;
  let content = fs.readFileSync(t, 'utf8');
  let changed = false;
  for (const [from, to] of Object.entries(renameMap)) {
    if (content.includes(from)) {
      content = content.split(from).join(to);
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(t, content, 'utf8');
    console.log(`[update] ${path.basename(t)}`);
  }
}
