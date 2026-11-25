/**
 * Test: Logo thương hiệu / app icon phải tự cập nhật khi đổi file.
 *
 * Bối cảnh (2026-11-25): đổi icon bia → logo Gia Huy. Ảnh logo nằm trong
 * URL của file JS/HTML (`<img src="/brand/logo-96.png">`) — URL này KHÔNG
 * do server inject `?v=` (nó nằm trong chuỗi JS), nên nếu URL không có
 * hash mà proxy cache 30 ngày (`immutable`) → browser vẫn hiện ảnh cũ
 * → phải Ctrl+F5 (đúng triệu chứng user muốn tránh).
 *
 * Cách sửa: middleware riêng cho `/brand/` + `/icons/` LUÔN redirect (302)
 * sang URL có content-hash, kể cả khi request không kèm `?v=`.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const layoutSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'layout.js'), 'utf8');

describe('Logo thương hiệu tự cập nhật (không Ctrl+F5)', () => {
  test('có middleware riêng redirect /brand/ và /icons/', () => {
    expect(serverSrc).toContain("p.startsWith('/brand/') || p.startsWith('/icons/')");
  });

  test('middleware brand redirect dùng content-hash của file', () => {
    const idx = serverSrc.indexOf("p.startsWith('/brand/') || p.startsWith('/icons/')");
    expect(idx).toBeGreaterThan(-1);
    const block = serverSrc.slice(idx, idx + 900);
    expect(block).toContain('assetVersion(p)');
    expect(block).toContain('no-store');
    expect(block).toContain('res.redirect(302, newUrl)');
  });

  test('middleware brand ĐẶT SAU middleware JS/CSS (không xung đột)', () => {
    const brandIdx = serverSrc.indexOf("p.startsWith('/brand/') || p.startsWith('/icons/')");
    const codeIdx = serverSrc.indexOf("p.startsWith('/js/')");
    expect(brandIdx).toBeGreaterThan(-1);
    expect(codeIdx).toBeGreaterThan(-1);
    expect(brandIdx).toBeGreaterThan(codeIdx);
  });

  test('middleware JS/CSS KHÔNG chứa /brand/ hay /icons/ (tránh redirect kép)', () => {
    const idx = serverSrc.indexOf("p.startsWith('/js/')");
    const block = serverSrc.slice(idx, idx + 400);
    expect(block).not.toContain('/brand/');
    expect(block).not.toContain('/icons/');
  });
});

describe('Logo dùng content-hash làm cache-buster', () => {
  test('/version.json trả field brand = hash logo', () => {
    expect(serverSrc).toContain('meta.brand = assetVersion(');
  });

  test('server inject window.BRAND_VERSION vào HTML (đồng bộ, không race)', () => {
    expect(serverSrc).toContain('window.BRAND_VERSION');
    const idx = serverSrc.indexOf('window.BRAND_VERSION');
    const block = serverSrc.slice(idx - 300, idx + 100);
    expect(block).toContain("assetVersion('/brand/logo-96.png')");
  });

  test('BRAND_VERSION phải inject TRƯỚC mọi <script src> (tránh race)', () => {
    // Nếu inject cuối </head> mà layout.js nằm trong <head> → layout.js đọc
    // BRAND_VERSION lúc init → rỗng → logo không có ?v= → cache ảnh cũ.
    const idx = serverSrc.indexOf('window.BRAND_VERSION');
    const block = serverSrc.slice(idx, idx + 700);
    expect(block).toContain("html.replace(/<head(\\s[^>]*)?>/i");
    expect(block).not.toContain("html.replace('</head>', ctxScript + '</head>')");
  });

  test('layout.js đọc brand từ window.BRAND_VERSION', () => {
    expect(layoutSrc).toContain('window.BRAND_VERSION');
    expect(layoutSrc).toContain('brandVersion = data.brand');
  });

  test('header logo có kèm ?v= brandVersion (khi có giá trị)', () => {
    expect(layoutSrc).toContain('/brand/logo-96.png${brandVersion');
    expect(layoutSrc).toContain("'?v=' + brandVersion");
  });
});

describe('Asset logo tồn tại và đúng kích thước', () => {
  const brandDir = path.join(ROOT, 'public', 'brand');
  const iconsDir = path.join(ROOT, 'public', 'icons');

  test('public/brand có logo.png + các bản nhỏ', () => {
    for (const f of ['logo.png', 'logo-64.png', 'logo-96.png', 'logo-192.png', 'logo-512.png', 'logo-maskable.png']) {
      const p = path.join(brandDir, f);
      expect(fs.existsSync(p)).toBe(true);
    }
  });

  test('logo.png có nền trong suốt (không phải ảnh trắng đặc)', () => {
    const buf = fs.readFileSync(path.join(brandDir, 'logo.png'));
    // PNG color type 6 = RGBA
    expect(buf[25]).toBe(6);
  });

  test('mọi app icon có kích thước vuông', () => {
    for (const f of ['icon-16.png', 'icon-32.png', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-1024.png', 'icon-512-maskable.png', 'favicon-32.png']) {
      const buf = fs.readFileSync(path.join(iconsDir, f));
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      expect(w).toBe(h);
    }
  });

  test('app icon nhẹ hơn 150KB (tránh tải nặng trên 3G)', () => {
    for (const f of ['icon-192.png', 'icon-512.png', 'icon-1024.png']) {
      const size = fs.statSync(path.join(iconsDir, f)).size;
      expect(size).toBeLessThan(150 * 1024);
    }
  });
});

describe('Không còn emoji logo ở vị trí thương hiệu', () => {
  test('layout.js header dùng <img> chứ không phải emoji', () => {
    const idx = layoutSrc.indexOf('header-logo-icon');
    expect(idx).toBeGreaterThan(-1);
    // <img ... class="header-logo-icon" src="/brand/logo-96.png?...">
    const start = layoutSrc.lastIndexOf('<img', idx);
    expect(start).toBeGreaterThan(-1);
    const block = layoutSrc.slice(start, idx + 120);
    expect(block).toContain('/brand/');
    expect(block).not.toContain('🍺');
  });

  test('login.html dùng <img> logo', () => {
    const html = fs.readFileSync(path.join(ROOT, 'views', 'login.html'), 'utf8');
    expect(html).toContain('class="login-logo" src="/brand/logo-192.png');
  });

  test('driver login dùng <img> logo', () => {
    const html = fs.readFileSync(path.join(ROOT, 'views', 'driver', 'login.html'), 'utf8');
    expect(html).toContain('class="ds-auth__brand-logo" src="/brand/logo-192.png');
  });

  test('driver shell + receipt dùng <img> logo', () => {
    const shell = fs.readFileSync(path.join(ROOT, 'public', 'js', 'driver', 'shell.js'), 'utf8');
    const receipt = fs.readFileSync(path.join(ROOT, 'public', 'js', 'driver', 'receipt-view.js'), 'utf8');
    expect(shell).toContain('class="ds-side__logo" src="/brand/logo-64.png');
    expect(receipt).toContain('class="rp-brand__logo" src="/brand/logo-64.png');
  });
});
