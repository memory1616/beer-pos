/**
 * Tải & self-host font Be Vietnam Pro (subset latin + vietnamese) vào public/fonts/.
 *
 * Lý do: CSP của server chỉ cho phép font-src 'self' → Google Fonts bị chặn,
 * gây console error + render-blocking request tới bên thứ ba.
 * Self-hosting vừa sửa CSP vừa nhanh hơn.
 *
 * Chạy: node scripts/fetch-fonts.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'fonts');

const CSS_URL =
  'https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700;800;900&display=swap';

// UA hiện đại → Google trả về woff2
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': UA, ...headers } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(get(res.headers.location, headers));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`${res.statusCode} ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Đang tải CSS từ Google Fonts...');
  const cssBuf = await get(CSS_URL);
  let css = cssBuf.toString('utf8');

  // Chỉ giữ subset latin + vietnamese (bỏ latin-ext, cyrillic, greek...)
  const blocks = css.split('/*').slice(1);
  const keep = [];
  for (const b of blocks) {
    const subset = b.slice(0, b.indexOf('*/')).trim();
    if (subset === 'latin' || subset === 'vietnamese') {
      keep.push('/*' + b);
    }
  }
  if (!keep.length) {
    console.error('[err] Không tìm thấy subset latin/vietnamese trong CSS');
    process.exit(1);
  }
  css = keep.join('\n');

  // Tải file woff2 và thay URL
  const urls = [...new Set([...css.matchAll(/url\((https:\/\/[^)]+\.woff2)\)/g)].map((m) => m[1]))];
  console.log(`Tìm thấy ${urls.length} file woff2`);

  for (const u of urls) {
    const name = u.split('/').slice(-2).join('-').replace(/[^\w.-]/g, '_');
    const dest = path.join(OUT_DIR, name);
    const buf = await get(u);
    fs.writeFileSync(dest, buf);
    console.log(`[ok] ${name} — ${(buf.length / 1024).toFixed(1)} KB`);
    css = css.split(u).join(`/fonts/${name}`);
  }

  const cssOut = path.join(OUT_DIR, 'be-vietnam-pro.css');
  fs.writeFileSync(cssOut, css, 'utf8');
  console.log(`\nĐã tạo public/fonts/be-vietnam-pro.css (${(css.length / 1024).toFixed(1)} KB)`);
})();
