/**
 * Test Service Worker không bao giờ trả bản JS/CSS CŨ từ cache.
 *
 * Bối cảnh (2026-11-25):
 *   Server version URL asset theo CONTENT-HASH (`/css/unified.css?v=<hash>`)
 *   → file đổi → URL đổi → browser tải bản mới.
 *
 *   Nhưng nếu SW dùng Cache-First cho JS/CSS, SW cache sẽ giữ bản cũ và
 *   trả lại → user phải Ctrl+F5. Vì vậy JS/CSS phải Network-First.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.v2.js'), 'utf8');

describe('Service Worker — JS/CSS dùng Network-First', () => {
  test('APP_SHELL KHÔNG chứa JS/CSS (tránh cache bản không versioned)', () => {
    const m = sw.match(/const APP_SHELL\s*=\s*\[([\s\S]*?)\];/);
    expect(m).toBeTruthy();
    const list = m[1];
    expect(list).not.toMatch(/\.css\b/);
    expect(list).not.toMatch(/\.js\b/);
  });

  test('có hàm networkFirstAsset cho JS/CSS', () => {
    expect(sw).toContain('async function networkFirstAsset(');
  });

  test('fetch handler route JS/CSS qua networkFirstAsset', () => {
    const idx = sw.indexOf('networkFirstAsset(event.request)');
    expect(idx).toBeGreaterThan(-1);
    const block = sw.slice(Math.max(0, idx - 500), idx + 40);
    expect(block).toMatch(/js\|css/);
  });

  test('networkFirstAsset cache vào SW cache (offline vẫn dùng được)', () => {
    const m = sw.match(/async function networkFirstAsset\([\s\S]*?\n}/);
    expect(m).toBeTruthy();
    expect(m[0]).toContain('cachePut(');
    expect(m[0]).toContain('caches.match(request)');
  });

  test('networkFirstAsset KHÔNG dùng cache:no-store (giữ HTTP cache browser)', () => {
    const m = sw.match(/async function networkFirstAsset\([\s\S]*?\n}/);
    expect(m).toBeTruthy();
    expect(m[0]).not.toContain("cache: 'no-store'");
  });

  test('navigation vẫn dùng networkFirst với cache:no-store', () => {
    // Navigation phải luôn lấy bản mới từ server.
    const m = sw.match(/async function networkFirst\(request\)[\s\S]*?\n}/);
    expect(m).toBeTruthy();
    expect(m[0]).toContain("cache: 'no-store'");
  });
});
