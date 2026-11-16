/**
 * Landing page optimization — regression tests
 * Bảo vệ các tối ưu hiệu năng/UX/SEO đã áp dụng cho public/landing.html.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'landing.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'landing.css'), 'utf8');
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const assetsDir = path.join(ROOT, 'public', 'landing-assets');

describe('Landing page — hiệu năng asset', () => {
  it('không còn tham chiếu ảnh PNG nặng (đã chuyển sang WebP)', () => {
    const pngRefs = [...html.matchAll(/landing-assets\/[\w-]+\.png/g)].map((m) => m[0]);
    expect(pngRefs).toEqual([]);
  });

  it('mọi asset landing-assets dùng .webp hoặc .mp4 (không còn file PNG lớn)', () => {
    const files = fs.readdirSync(assetsDir);
    const heavy = files.filter((f) => f.endsWith('.png') && fs.statSync(path.join(assetsDir, f)).size > 100 * 1024);
    expect(heavy).toEqual([]);
  });

  it('tổng dung lượng landing-assets < 4MB', () => {
    const total = fs.readdirSync(assetsDir).reduce((s, f) => s + fs.statSync(path.join(assetsDir, f)).size, 0);
    expect(total).toBeLessThan(4 * 1024 * 1024);
  });

  it('video dùng file nén 720p (không còn bản 16MB)', () => {
    expect(html).toMatch(/landing-assets\/beer-mobile-720\.[0-9a-f]{8}\.mp4/);
    expect(fs.existsSync(path.join(assetsDir, 'beer-mobile.mp4'))).toBe(false);
  });

  it('video dùng preload="none" để không tải vô ích', () => {
    expect(html).toMatch(/preload="none"/);
  });

  it('ảnh hero có preload + fetchpriority=high (tăng tốc LCP)', () => {
    expect(html).toMatch(/<link rel="preload" as="image"[^>]*hero-freezer/);
    expect(html).toMatch(/fetchpriority="high"/);
  });

  it('mọi asset nhúng có content-hash để cache immutable an toàn', () => {
    const refs = [...html.matchAll(/\/landing-assets\/[\w.-]+\.(webp|mp4|svg)/g)].map((m) => m[0]);
    expect(refs.length).toBeGreaterThan(5);
    const hashed = refs.filter((r) => /\.[0-9a-f]{8}\.(webp|mp4)$/.test(r) || r.endsWith('.svg'));
    expect(hashed.length).toBe(refs.length);
  });

  it('landing.css không @import Google Fonts (tránh request chặn render)', () => {
    expect(css).not.toMatch(/@import\s+url\(['"]?https:\/\/fonts\.googleapis\.com/);
  });
});

describe('Landing page — SEO', () => {
  it('có Open Graph + Twitter Card', () => {
    expect(html).toMatch(/property="og:title"/);
    expect(html).toMatch(/property="og:image"/);
    expect(html).toMatch(/name="twitter:card"/);
  });

  it('có canonical + robots meta', () => {
    expect(html).toMatch(/<link rel="canonical"/);
    expect(html).toMatch(/name="robots"/);
  });

  it('có JSON-LD LocalBusiness hợp lệ', () => {
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(m).toBeTruthy();
    const json = JSON.parse(m[1]);
    expect(json['@type']).toBe('LocalBusiness');
    expect(json.telephone).toBeTruthy();
    expect(json.areaServed.length).toBeGreaterThan(0);
  });

  it('có robots.txt + sitemap.xml trong public/', () => {
    expect(fs.existsSync(path.join(ROOT, 'public', 'robots.txt'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'public', 'sitemap.xml'))).toBe(true);
    expect(fs.readFileSync(path.join(ROOT, 'public', 'robots.txt'), 'utf8')).toMatch(/Sitemap:/);
  });
});

describe('Landing page — UX mobile & accessibility', () => {
  it('chatbot KHÔNG tự mở sau 5s (tránh che nội dung)', () => {
    expect(html).not.toMatch(/setTimeout\(function\(\)\s*\{\s*var fab = document\.getElementById\('chatFab'\)/);
    expect(html).toMatch(/KHÔNG tự mở chatbot/);
  });

  it('có nút "lên đầu trang"', () => {
    expect(html).toMatch(/id="toTopBtn"/);
    expect(css).toMatch(/\.to-top-btn/);
  });

  it('sticky CTA trên mobile thành thanh ngang, không chồng chatbot', () => {
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?\.sticky-cta[\s\S]*?flex-direction: row/);
    expect(css).toMatch(/\.chat-fab \{ bottom: 84px/);
  });

  it('bảng so sánh cuộn ngang được trên màn hình hẹp', () => {
    expect(html).toMatch(/class="compare-wrap/);
    expect(html).toMatch(/class="compare-table"/);
    expect(css).toMatch(/@media \(max-width: 700px\)[\s\S]*?overflow-x: auto/);
  });

  it('có dark mode cho landing (theo data-theme)', () => {
    expect(html).toMatch(/data-theme/);
    expect(css).toMatch(/\[data-theme="dark"\] body/);
  });

  it('tôn trọng prefers-reduced-motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it('reveal chỉ ẩn khi JS bật (fallback nội dung luôn hiện nếu JS lỗi)', () => {
    expect(html).toMatch(/classList\.add\('js'\)/);
    expect(css).toMatch(/\.js \.reveal \{ opacity: 0/);
  });

  it('touch target ≥ 44px trên thiết bị cảm ứng', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)/);
    expect(css).toMatch(/min-height: 48px/);
  });

  it('không dùng iframe Google Maps chặn render (giữ lazy)', () => {
    expect(html).toMatch(/google\.com\/maps\/embed[\s\S]{0,300}loading="lazy"/);
  });
});

describe('server.js — cache header cho asset', () => {
  it('bật cache immutable cho asset có content-hash', () => {
    expect(serverJs).toMatch(/max-age=31536000, immutable/);
    expect(serverJs).toMatch(/\[0-9a-f\]\{8\}/);
  });

  it('giữ route /version.json động đăng ký trước express.static', () => {
    const staticIdx = serverJs.indexOf('app.use(express.static');
    const versionIdx = serverJs.indexOf("app.get('/version.json'");
    expect(versionIdx).toBeGreaterThan(-1);
    expect(staticIdx).toBeGreaterThan(-1);
    expect(versionIdx).toBeLessThan(staticIdx);
  });
});
