const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.join(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'public', 'icons');
const SRC_DIR = path.join(ICON_DIR, 'src');

// file nguon -> danh sach output
//   rounded : icon bo goc, dung cho manifest "any" + apple-touch-icon
//   maskable: nen phu day, dung cho manifest "maskable" (Android adaptive)
const JOBS = [
  { src: 'app-icon.svg', out: 'icon-180.png', size: 180, kind: 'rounded' },
  { src: 'app-icon.svg', out: 'apple-touch-icon-180.png', size: 180, kind: 'rounded' },
  { src: 'app-icon.svg', out: 'icon-192.png', size: 192, kind: 'rounded' },
  { src: 'app-icon.svg', out: 'icon-512.png', size: 512, kind: 'rounded' },
  { src: 'app-icon.svg', out: 'icon-1024.png', size: 1024, kind: 'rounded' },
  { src: 'app-icon.svg', out: 'icon-16.png', size: 16, kind: 'rounded' },
  { src: 'app-icon.svg', out: 'icon-32.png', size: 32, kind: 'rounded' },
  { src: 'app-icon-maskable.svg', out: 'icon-512-maskable.png', size: 512, kind: 'maskable' },
];

// Ban sao sang thu muc public/ (root) cho cac duong dan legacy /app-shell
const ROOT_COPIES = ['icon-192.png', 'icon-512.png'];

function magick(args) {
  execFileSync('magick', args, { stdio: 'ignore' });
}

function renderSvg(svgPath, size) {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  });
  return r.render().asPng();
}

const tmp = path.join(ICON_DIR, '.tmp-render.png');
for (const job of JOBS) {
  const svgPath = path.join(SRC_DIR, job.src);
  if (!fs.existsSync(svgPath)) {
    console.warn(`[icon] skip ${job.out}: thieu ${job.src}`);
    continue;
  }
  fs.writeFileSync(tmp, renderSvg(svgPath, job.size));
  const out = path.join(ICON_DIR, job.out);
  magick([
    tmp,
    '-strip',
    '-define', 'png:compression-level=9',
    '-define', 'png:compression-filter=5',
    out,
  ]);
  const kb = (fs.statSync(out).size / 1024).toFixed(1);
  console.log(`[icon] ${job.out.padEnd(26)} ${String(job.size).padStart(4)}px  ${kb.padStart(6)} KB  (${job.kind})`);
}
fs.unlinkSync(tmp);

for (const name of ROOT_COPIES) {
  const from = path.join(ICON_DIR, name);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, path.join(ROOT, 'public', name));
    console.log(`[icon] copy -> public/${name}`);
  }
}
console.log('[icon] Done.');
