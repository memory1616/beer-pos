/**
 * Render SVG illustrations (public/images/home/src/*.svg) → WebP (public/images/home/*.webp).
 * Dùng @resvg/resvg-js (không phụ thuộc system binary) + sharp nếu có, fallback ImageMagick.
 * Chạy: node scripts/render-home-images.js
 */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'images', 'home', 'src');
const OUT = path.join(ROOT, 'public', 'images', 'home');

const TARGETS = [
  { file: 'hero-beer', width: 1600 },
  { file: 'warehouse', width: 1200 },
  { file: 'beer-delivery', width: 1200 },
  { file: 'monthly-promotion', width: 1200 },
  { file: 'illuminated-signage', width: 1200 },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let sharp = null;
  try {
    sharp = require('sharp');
  } catch (e) {
    console.log('[warn] sharp không có — sẽ dùng ImageMagick fallback');
  }

  for (const t of TARGETS) {
    const srcPath = path.join(SRC, `${t.file}.svg`);
    if (!fs.existsSync(srcPath)) {
      console.log(`[skip] ${t.file}.svg không tồn tại`);
      continue;
    }
    const svg = fs.readFileSync(srcPath, 'utf8');
    const r = new Resvg(svg, {
      fitTo: { mode: 'width', value: t.width },
      background: 'rgba(0,0,0,0)',
    });
    const png = r.render().asPng();
    const outPath = path.join(OUT, `${t.file}.png`);

    if (sharp) {
      await sharp(png).webp({ quality: 82, effort: 6 }).toFile(outPath.replace(/\.png$/, '.webp'));
      fs.unlinkSync(outPath);
    } else {
      fs.writeFileSync(outPath, png);
    }

    const webpPath = outPath.replace(/\.png$/, '.webp');
    if (fs.existsSync(webpPath)) {
      const kb = fs.statSync(webpPath).size / 1024;
      console.log(`[ok] ${t.file}.webp — ${kb.toFixed(1)} KB`);
    } else {
      const kb = fs.statSync(outPath).size / 1024;
      console.log(`[ok] ${t.file}.png — ${kb.toFixed(1)} KB (chưa có webp)`);
    }
  }
})();
