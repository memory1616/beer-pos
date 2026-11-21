/**
 * PWA / iOS installability — regression tests
 * Bao phủ: manifest, icon vuong, meta iOS tren moi view, trang /install, SW app shell.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'manifest.json'), 'utf8'));
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const swJs = fs.readFileSync(path.join(ROOT, 'public', 'sw.v2.js'), 'utf8');

function walkViews(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkViews(p));
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const VIEWS = walkViews(path.join(ROOT, 'views'));

function readPngSize(file) {
  const buf = fs.readFileSync(file);
  // PNG IHDR: width/height tai byte 16..23 (big-endian)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('PWA manifest', () => {
  it('có các trường bắt buộc cho installability', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.scope).toBe('/');
    expect(manifest.theme_color).toBeTruthy();
    expect(manifest.background_color).toBeTruthy();
  });

  it('có icon 192 và 512 với purpose any', () => {
    const any = manifest.icons.filter((i) => i.purpose === 'any');
    const sizes = any.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  it('có ít nhất một icon maskable', () => {
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });
});

describe('Icon — phải VUÔNG (iOS cắt icon méo nếu ảnh ngang)', () => {
  const ICON_DIR = path.join(ROOT, 'public', 'icons');

  it('mọi icon đều là ảnh vuông', () => {
    const files = fs.readdirSync(ICON_DIR).filter((f) => f.endsWith('.png'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const { width, height } = readPngSize(path.join(ICON_DIR, f));
      expect(width).toBe(height);
    }
  });

  it('apple-touch-icon ở root tồn tại và là 180x180', () => {
    const p = path.join(ROOT, 'public', 'apple-touch-icon.png');
    expect(fs.existsSync(p)).toBe(true);
    const { width, height } = readPngSize(p);
    expect(width).toBe(180);
    expect(height).toBe(180);
  });

  it('icon nhẹ hơn 150KB (tránh tải nặng trên 3G)', () => {
    for (const f of ['icon-192.png', 'icon-512.png', 'apple-touch-icon-180.png']) {
      const size = fs.statSync(path.join(ROOT, 'public', 'icons', f)).size;
      expect(size).toBeLessThan(150 * 1024);
    }
  });
});

describe('Meta iOS trên MỌI view', () => {
  it('có apple-mobile-web-app-capable, apple-touch-icon, manifest, viewport-fit=cover', () => {
    const missing = [];
    for (const f of VIEWS) {
      const html = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f);
      if (!html.includes('apple-mobile-web-app-capable')) missing.push(rel + ': capable');
      if (!html.includes('apple-touch-icon')) missing.push(rel + ': icon');
      if (!html.includes('rel="manifest"')) missing.push(rel + ': manifest');
      if (!html.includes('viewport-fit=cover')) missing.push(rel + ': viewport-fit');
      if (!html.includes('apple-mobile-web-app-status-bar-style')) missing.push(rel + ': status-bar');
    }
    expect(missing).toEqual([]);
  });

  it('apple-touch-icon trỏ tới file 180px riêng (không phải icon nặng)', () => {
    for (const f of VIEWS) {
      const html = fs.readFileSync(f, 'utf8');
      const m = html.match(/<link rel="apple-touch-icon" href="([^"]+)"/);
      expect(m).toBeTruthy();
      expect(m[1]).toBe('/apple-touch-icon.png');
    }
  });
});

describe('Trang hướng dẫn cài app', () => {
  it('/install được đăng ký route public (trước guard auth)', () => {
    expect(serverJs).toMatch(/app\.get\('\/install'/);
    const installIdx = serverJs.indexOf("app.get('/install'");
    const guardIdx = serverJs.indexOf('adminPageGuard(req, res, next)');
    expect(installIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(guardIdx);
  });

  it('views/install.html tồn tại và có hướng dẫn iOS', () => {
    const p = path.join(ROOT, 'views', 'install.html');
    expect(fs.existsSync(p)).toBe(true);
    const html = fs.readFileSync(p, 'utf8');
    expect(html).toMatch(/Thêm vào Màn hình chính/i);
    expect(html).toMatch(/apple-touch-icon\.png/);
  });
});

describe('Service Worker app shell', () => {
  it('cache icon mới + apple-touch-icon', () => {
    expect(swJs).toContain('/apple-touch-icon.png');
    expect(swJs).toContain('/icons/icon-192.png');
  });
});

describe('Header safe-area (iPhone notch) — không bị lọt vào vùng notch', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'unified.css'), 'utf8');

  it('.topbar dùng padding-top = safe-area', () => {
    const block = css.match(/\.topbar\s*\{[^}]*\}/);
    expect(block).toBeTruthy();
    expect(block[0]).toMatch(/padding-top:\s*var\(--safe-area-top\)/);
    expect(block[0]).toMatch(/box-sizing:\s*border-box/);
  });

  it('.app-header (block layout) dùng padding-top = safe-area', () => {
    const blocks = css.match(/\.app-header\s*\{[^}]*\}/g) || [];
    // Chỉ block có layout (chứa position: fixed) mới cần padding-top safe-area.
    // Block theme override chỉ đổi background → không yêu cầu.
    const layoutBlocks = blocks.filter((b) => /position:\s*fixed/.test(b));
    expect(layoutBlocks.length).toBeGreaterThan(0);
    for (const b of layoutBlocks) {
      expect(b).toMatch(/padding-top:\s*var\(--safe-area-top\)/);
    }
  });

  it('KHÔNG dùng padding: 0 16px (sẽ xoá padding-top safe-area)', () => {
    expect(css).not.toMatch(/\.topbar\s*\{[^}]*padding:\s*0\s+16px/);
  });
});
