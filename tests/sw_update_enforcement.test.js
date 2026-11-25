/**
 * Test: SW phải được cập nhật tự động, không cần Ctrl+F5.
 *
 * Chuỗi sự cố đã gặp (2026-11-25):
 *  1. SW cũ dùng Cache-First cho JS/CSS → cache `/css/unified.css` (không
 *     có `?v=`) → deploy file mới vẫn trả bản cũ từ cache.
 *  2. layout.js (bản cũ trong cache) chưa có logic đăng ký SW mới →
 *     SW mới không bao giờ được cài → vòng lặp.
 *  3. Server trả `sw.v2.js` với `immutable, max-age=1 năm` → browser không
 *     bao giờ tải lại script SW để so sánh byte → SW mới không được cài.
 *
 * Ba nhóm test dưới đây chốt lại 3 điểm đó.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const layoutSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'layout.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(ROOT, 'public', 'sw.v2.js'), 'utf8');

describe('SW script KHÔNG bị cache dài hạn', () => {
  test('server.js set no-store cho sw.js / sw.v2.js', () => {
    const idx = serverSrc.indexOf('sw(\\.v\\d+)?\\.js$/i.test(filePath)');
    expect(idx).toBeGreaterThan(-1);
    const block = serverSrc.slice(idx, idx + 500);
    expect(block).toContain('no-store');
    expect(block).toContain('max-age=0');
  });

  test('KHÔNG set immutable cho SW script (chỉ ở nhánh else)', () => {
    const idx = serverSrc.indexOf('sw(\\.v\\d+)?\\.js$/i.test(filePath)');
    expect(idx).toBeGreaterThan(-1);
    const block = serverSrc.slice(idx, idx + 700);
    const elseIdx = block.indexOf('} else {');
    expect(elseIdx).toBeGreaterThan(-1);
    expect(block.slice(0, elseIdx)).not.toContain('immutable');
  });

  test('KHÔNG redirect SW script (browser chặn SW đứng sau redirect)', () => {
    // Browser: "SecurityError: The script resource is behind a redirect,
    // which is disallowed." → SW mới không bao giờ được cài.
    const idx = serverSrc.indexOf("if (p === '/sw.js' || p === '/sw.v2.js') return next();");
    expect(idx).toBeGreaterThan(-1);
    // Đặt TRƯỚC logic redirect (dòng if (String(q) === current) return next())
    const redirectIdx = serverSrc.indexOf('if (String(q) === current) return next();');
    expect(redirectIdx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(redirectIdx);
  });
});

describe('SW update được ép trên MỌI trang', () => {
  test('server.js inject script đăng ký SW vào HTML', () => {
    expect(serverSrc).toContain('__beerSWUpdateInjected');
  });

  test('script inject dùng content-hash của sw.v2.js', () => {
    const idx = serverSrc.indexOf("assetVersion('/sw.v2.js')");
    expect(idx).toBeGreaterThan(-1);
    const block = serverSrc.slice(idx, idx + 3000);
    expect(block).toContain("register('/sw.v2.js?v=${swVer}'");
    expect(block).toContain("updateViaCache: 'none'");
    expect(block).toContain('reg.update()');
  });

  test('script inject xử lý reg.waiting → reload 1 lần (không lặp)', () => {
    const idx = serverSrc.indexOf('__beerSWUpdateInjected');
    const block = serverSrc.slice(idx, idx + 3000);
    expect(block).toContain('reg.waiting');
    expect(block).toContain('swReloadedForUpdate');
    expect(block).toContain('location.reload()');
  });

  test('script inject yêu cầu SKIP_WAITING (SW không tự activate)', () => {
    // SW mới KHÔNG tự skipWaiting()/clients.claim() → nếu client không yêu cầu
    // SKIP_WAITING thì SW mới kẹt ở trạng thái 'waiting' → user reload vô hạn.
    const idx = serverSrc.indexOf('__beerSWUpdateInjected');
    const block = serverSrc.slice(idx, idx + 3000);
    expect(block).toContain("type: 'SKIP_WAITING'");
  });

  test('cờ reload có hạn 30 phút (chống vòng lặp reload)', () => {
    const idx = serverSrc.indexOf('__beerSWUpdateInjected');
    const block = serverSrc.slice(idx, idx + 3000);
    expect(block).toContain('RELOAD_TTL');
    expect(block).toContain('Date.now()');
  });
});

describe('layout.js đăng ký SW (global, mọi trang)', () => {
  test('layout.js có logic đăng ký SW', () => {
    expect(layoutSrc).toContain('__beerSWRegistered');
    expect(layoutSrc).toContain('sw.v2.js?v=');
  });

  test('layout.js KHÔNG dùng guard !controller (tránh kẹt SW cũ)', () => {
    // Bỏ qua comment — chỉ kiểm tra code thực thi.
    const code = layoutSrc
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/if\s*\(\s*!navigator\.serviceWorker\.controller\s*\)/);
  });

  test('layout.js dùng updateViaCache none + reg.update()', () => {
    expect(layoutSrc).toContain("updateViaCache: 'none'");
    expect(layoutSrc).toContain('reg.update()');
  });
});

describe('sw.v2.js dọn cache cũ khi activate', () => {
  test('activate xoá entry JS/CSS không có ?v=', () => {
    const idx = swSrc.indexOf("addEventListener('activate'");
    expect(idx).toBeGreaterThan(-1);
    const block = swSrc.slice(idx, idx + 2000);
    expect(block).toContain('staleAssets');
    expect(block).toContain("searchParams.get('v') === null");
    expect(block).toContain('cache.delete(req)');
  });

  test('activate xoá cả entry logo/icon không có ?v=', () => {
    // Logo nằm trong URL của file JS → không phải lúc nào cũng có `?v=`.
    // Nếu SW cache URL không versioned → đổi logo user không thấy.
    const idx = swSrc.indexOf("addEventListener('activate'");
    const block = swSrc.slice(idx, idx + 2400);
    expect(block).toContain('isBrand');
    expect(block).toContain("p.startsWith('/brand/')");
    expect(block).toContain("p.startsWith('/icons/')");
    expect(block).toContain("/apple-touch-icon.png");
  });

  test('activate KHÔNG tự clients.claim() (tránh vòng lặp reload)', () => {
    // clients.claim() chiếm quyền control các tab đang mở → controller đổi
    // → client reload → SW URL đổi → SW mới lại → LẶP.
    // Client chủ động reload 1 lần qua activateAndReload() + SKIP_WAITING.
    const idx = swSrc.indexOf("addEventListener('activate'");
    const block = swSrc.slice(idx, idx + 3000);
    const code = block
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toContain('self.clients.claim()');
  });

  test('activate xoá entry JS/CSS không có ?v= TRƯỚC khi kết thúc', () => {
    const idx = swSrc.indexOf("addEventListener('activate'");
    const block = swSrc.slice(idx, idx + 3000);
    const staleIdx = block.indexOf('staleAssets');
    expect(staleIdx).toBeGreaterThan(-1);
    expect(block).toContain('cache.delete(req)');
  });
});

describe('sw.v2.js KHÔNG tự skipWaiting (chống reload loop)', () => {
  test('install KHÔNG gọi self.skipWaiting()', () => {
    const idx = swSrc.indexOf("addEventListener('install'");
    const block = swSrc.slice(idx, idx + 1500);
    const code = block
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toContain('self.skipWaiting()');
  });

  test('có handler message SKIP_WAITING để client kích hoạt SW có chủ đích', () => {
    expect(swSrc).toContain("'SKIP_WAITING'");
    const idx = swSrc.indexOf("'SKIP_WAITING'");
    const block = swSrc.slice(idx, idx + 300);
    expect(block).toContain('self.skipWaiting()');
  });
});

describe('Service Worker dùng 1 nguồn version ổn định (chống reload loop)', () => {
  test('server inject window.SW_VERSION (content-hash sw.v2.js)', () => {
    expect(serverSrc).toContain('window.SW_VERSION');
  });

  test('client KHÔNG dùng Date.now() cho URL script SW', () => {
    // `?v=Date.now()` → URL MỚI mỗi lần load → browser cài SW mới → reload lặp.
    const clients = ['layout.js', 'sw-register.js', 'login.js'];
    for (const f of clients) {
      const src = fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8');
      const code = src
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      expect(code).not.toMatch(/sw\.v2\.js\?v=['"]?\s*\+\s*Date\.now\(\)/);
      expect(code).not.toMatch(/swVer\s*=\s*Date\.now\(\)/);
    }
  });

  test('client dùng SW_VERSION (fallback APP_VERSION) cho URL script SW', () => {
    for (const f of ['layout.js', 'sw-register.js', 'login.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8');
      expect(src).toContain('SW_VERSION');
    }
  });

  test('client có cờ reload có hạn (RELOAD_TTL)', () => {
    for (const f of ['layout.js', 'sw-register.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8');
      expect(src).toContain('RELOAD_TTL');
    }
  });
});

describe('sw.v2.js KHÔNG cache-first logo/icon', () => {
  test('logo/icon dùng Network-First (không trả ảnh cũ từ cache)', () => {
    const idx = swSrc.indexOf("addEventListener('fetch'");
    expect(idx).toBeGreaterThan(-1);
    const block = swSrc.slice(idx, idx + 12000);
    const brandIdx = block.indexOf("parsed.pathname.startsWith('/brand/')");
    expect(brandIdx).toBeGreaterThan(-1);
    // Phải nằm trong nhánh respondWith(networkFirstAsset(...))
    const segment = block.slice(brandIdx, brandIdx + 600);
    expect(segment).toContain('networkFirstAsset');
    // Và phải TRƯỚC nhánh cacheFirst (để được ưu tiên)
    expect(segment.indexOf('networkFirstAsset')).toBeLessThan(
      block.indexOf('cacheFirst(event.request)')
    );
  });

  test('apple-touch-icon + favicon.ico cũng Network-First', () => {
    const idx = swSrc.indexOf("addEventListener('fetch'");
    const block = swSrc.slice(idx, idx + 12000);
    expect(block).toContain("parsed.pathname === '/apple-touch-icon.png'");
    expect(block).toContain("parsed.pathname === '/favicon.ico'");
  });
});
