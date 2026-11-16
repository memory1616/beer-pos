/**
 * Tạo biến thể ảnh responsive (WebP) cho public/images/home/ và public/landing-assets/.
 *
 * - Ảnh minh họa SVG  → render lại ở nhiều bề rộng (Resvg)
 * - Ảnh thực WebP sẵn có → resize bằng ImageMagick (không vẽ lại)
 *
 * Tên file đầu ra: <base>-<w>.<hash8>.webp  (content-hash → cache immutable 1 năm)
 * Manifest ghi ra scripts/.responsive-manifest.json để cập nhật landing.html.
 *
 * Chạy: node scripts/gen-responsive-images.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.join(__dirname, '..');
const HOME_DIR = path.join(ROOT, 'public', 'images', 'home');
const ASSET_DIR = path.join(ROOT, 'public', 'landing-assets');

/** Ảnh minh họa (SVG) — render mới ở nhiều kích thước */
const SVG_JOBS = [
  { dir: HOME_DIR, base: 'hero-beer', svg: 'hero-beer', widths: [640, 960, 1600] },
  { dir: HOME_DIR, base: 'warehouse', svg: 'warehouse', widths: [480, 800, 1200] },
  { dir: HOME_DIR, base: 'beer-delivery', svg: 'beer-delivery', widths: [480, 800, 1200] },
  { dir: HOME_DIR, base: 'monthly-promotion', svg: 'monthly-promotion', widths: [480, 800, 1200] },
  { dir: HOME_DIR, base: 'illuminated-signage', svg: 'illuminated-signage', widths: [480, 800, 1200] },
];

/** Ảnh thực (WebP sẵn có) — chỉ resize, không vẽ lại */
const RESIZE_JOBS = [
  { dir: ASSET_DIR, base: 'hero-bottle-gold', src: 'hero-bottle-gold.6360f973.webp', widths: [320, 640] },
  { dir: ASSET_DIR, base: 'product-black', src: 'product-black.543165ce.webp', widths: [320, 640] },
  { dir: ASSET_DIR, base: 'setup-freezer', src: 'setup-freezer.cf839a91.webp', widths: [480, 800] },
  { dir: ASSET_DIR, base: 'banner-standee', src: 'banner-standee.dc0fdd61.webp', widths: [320, 640] },
];

function hash8(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

function magick(args) {
  execFileSync('magick', args, { stdio: 'ignore' });
}

/**
 * PNG buffer → WebP (ImageMagick)
 * @param {Buffer} png
 * @param {string} outPath
 */
function pngToWebp(png, outPath) {
  const tmp = outPath.replace(/\.webp$/, '.tmp.png');
  fs.writeFileSync(tmp, png);
  magick([tmp, '-quality', '80', '-define', 'webp:method=6', outPath]);
  fs.unlinkSync(tmp);
}

/**
 * Đổi tên file sang dạng content-hash và trả về tên mới.
 * @param {string} filePath
 */
function withHash(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const next = `${base}.${hash8(buf)}${ext}`;
  fs.renameSync(filePath, path.join(path.dirname(filePath), next));
  return next;
}

(async () => {
  const manifest = {};

  // ── 1. Ảnh minh họa SVG ─────────────────────────────────────────────
  for (const job of SVG_JOBS) {
    const srcPath = path.join(HOME_DIR, 'src', `${job.svg}.svg`);
    if (!fs.existsSync(srcPath)) {
      console.log(`[skip] ${job.base}: thiếu ${job.svg}.svg`);
      continue;
    }
    const svg = fs.readFileSync(srcPath, 'utf8');
    const variants = [];
    for (const w of job.widths) {
      const r = new Resvg(svg, {
        fitTo: { mode: 'width', value: w },
        background: 'rgba(0,0,0,0)',
      });
      const tmpOut = path.join(job.dir, `${job.base}-${w}.tmp.webp`);
      pngToWebp(r.render().asPng(), tmpOut);
      const name = withHash(tmpOut);
      const kb = fs.statSync(path.join(job.dir, name)).size / 1024;
      console.log(`[ok] ${name} — ${kb.toFixed(1)} KB`);
      variants.push({ w, file: name, kb: +kb.toFixed(1) });
    }
    manifest[job.base] = { dir: '/images/home/', variants };
  }

  // ── 2. Ảnh thực — resize ────────────────────────────────────────────
  for (const job of RESIZE_JOBS) {
    const srcPath = path.join(job.dir, job.src);
    if (!fs.existsSync(srcPath)) {
      console.log(`[skip] ${job.base}: thiếu ${job.src}`);
      continue;
    }
    const variants = [];
    for (const w of job.widths) {
      const tmpOut = path.join(job.dir, `${job.base}-${w}.tmp.webp`);
      magick([srcPath, '-resize', `${w}x`, '-quality', '80', '-define', 'webp:method=6', tmpOut]);
      const name = withHash(tmpOut);
      const kb = fs.statSync(path.join(job.dir, name)).size / 1024;
      console.log(`[ok] ${name} — ${kb.toFixed(1)} KB`);
      variants.push({ w, file: name, kb: +kb.toFixed(1) });
    }
    manifest[job.base] = { dir: '/landing-assets/', variants };
  }

  fs.writeFileSync(
    path.join(ROOT, 'scripts', '.responsive-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );
  console.log('\nManifest: scripts/.responsive-manifest.json');
})();
