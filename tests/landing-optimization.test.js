/**
 * Landing page — regression tests
 * Bao phủ: brand identity, 10 section, hiệu năng asset, SEO, mobile UX.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'landing.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'landing.css'), 'utf8');
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const sitemap = fs.readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8');

const assetsDir = path.join(ROOT, 'public', 'landing-assets');
const homeImgDir = path.join(ROOT, 'public', 'images', 'home');

// ════════════════════════════════════════════════════════════════════
//  BRAND IDENTITY — quy định bắt buộc
// ════════════════════════════════════════════════════════════════════
describe('Brand identity — TÂY NINH BIA TƯƠI', () => {
  it('KHÔNG có bất kỳ biến thể nào của "Gia Huy" trong homepage', () => {
    const forbidden = /gia[\s_-]?huy/i;
    expect(html).not.toMatch(forbidden);
    expect(css).not.toMatch(forbidden);
    expect(sitemap).not.toMatch(forbidden);
  });

  it('dùng thương hiệu chính thức trong tiêu đề & nội dung', () => {
    expect(html).toMatch(/TÂY NINH BIA TƯƠI/);
    expect(html).toMatch(/Bia Tươi Tây Ninh/);
  });

  it('headline thương hiệu đúng theo quy định', () => {
    expect(html).toMatch(/NHÀ PHÂN PHỐI BIA TƯƠI TẠI TÂY NINH/i);
  });

  it('thông điệp cốt lõi: kho Tây Ninh · 50 lít · thưởng sản lượng · đồng hành', () => {
    expect(html).toMatch(/Kho hàng ngay tại Tây Ninh/);
    expect(html).toMatch(/Nhập từ <strong>50 lít<\/strong>/);
    expect(html).toMatch(/Thưởng sản lượng hàng tháng/);
    expect(html).toMatch(/Đồng hành cùng quán lâu dài/);
  });

  it('tên file ảnh không chứa tên thương hiệu bị cấm', () => {
    const files = fs.readdirSync(homeImgDir);
    expect(files.some((f) => /gia[\s_-]?huy/i.test(f))).toBe(false);
  });

  it('giữ nguyên hotline & URL Zalo', () => {
    expect(html).toMatch(/tel:0974012652/);
    expect(html).toMatch(/https:\/\/zalo\.me\/0974012652/);
    expect(html).toMatch(/0974 012 652/);
  });
});

// ════════════════════════════════════════════════════════════════════
//  CẤU TRÚC 10 SECTION
// ════════════════════════════════════════════════════════════════════
describe('Homepage — 10 section theo Master Prompt', () => {
  it('có đủ 10 section với id neo bắt buộc', () => {
    const ids = [...html.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]);
    ['loi-the', 'giao-hang', 'khuyen-mai', 'hop-den', 'san-pham', 'nang-luc', 'quy-trinh', 'khu-vuc', 'lien-he'].forEach(
      (id) => expect(ids).toContain(id)
    );
  });

  it('mọi liên kết neo nội bộ đều trỏ tới id có thật', () => {
    const ids = [...html.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]);
    const anchors = [...html.matchAll(/href="#([a-z0-9-]+)"/g)].map((m) => m[1]);
    const broken = anchors.filter((a) => !ids.includes(a));
    expect(broken).toEqual([]);
  });

  it('S1 Hero: headline, 3 lợi thế, CTA Zalo + gọi', () => {
    expect(html).toMatch(/BIA TƯƠI TẠI TÂY NINH/);
    expect(html).toMatch(/GIAO NHANH TẬN QUÁN/);
    expect(html).toMatch(/hero-pillar/);
    expect(html).toMatch(/Nhận báo giá qua Zalo/);
    expect(html).toMatch(/Gọi ngay 0974 012 652/);
  });

  it('S2 Ba lợi thế: kho 50L · thưởng hàng tháng · chăm sóc hộp đèn', () => {
    expect(html).toMatch(/KHO BIA NGAY TẠI TÂY NINH/);
    expect(html).toMatch(/Giao hàng từ 50 lít/);
    expect(html).toMatch(/Bán càng nhiều – nhận thưởng càng lớn/);
    expect(html).toMatch(/Thay mới khi phai màu theo chính sách hàng năm/);
    expect(html).toMatch(/Kiểm tra tình trạng hộp đèn hàng năm/);
  });

  it('S3 Giao hàng linh hoạt: số 50L nổi bật + 4 lợi ích', () => {
    expect(html).toMatch(/data-count="50"/);
    expect(html).toMatch(/Mức nhập tối thiểu cho mỗi lần giao hàng/);
    ['Nhập hàng linh hoạt', 'Tối ưu vốn kinh doanh', 'Hạn chế tồn kho', 'Chủ động bổ sung bia'].forEach((t) =>
      expect(html).toContain(t)
    );
  });

  it('S4 Thưởng sản lượng: quy trình 4 bước, không tự tạo mức thưởng', () => {
    expect(html).toMatch(/ĐỒNG HÀNH CẢ THÁNG — NHẬN THƯỞNG MỖI THÁNG/);
    expect(html).toMatch(/Mức thưởng cụ thể áp dụng theo chính sách/);
    expect(html).toMatch(/Xem chính sách khuyến mãi/);
    // Không được tự tạo mức thưởng / % mới
    expect(html).not.toMatch(/thưởng \d+\s*lít|thưởng \d+%/i);
  });

  it('S5 Hộp đèn: quy trình 3 bước, không biến thành cam kết miễn phí', () => {
    expect(html).toMatch(/KHÔNG CHỈ LẮP ĐẶT/);
    expect(html).toMatch(/Hỗ trợ nhận diện cửa hàng/);
    expect(html).toMatch(/Kiểm tra tình trạng hộp đèn/);
    expect(html).toMatch(/Hỗ trợ thay mới khi phai màu/);
    expect(html).not.toMatch(/thay mới miễn phí/i);
  });

  it('S6 Sản phẩm: bia vàng · bia đen · bom inox 1L · chai PET 900ml', () => {
    expect(html).toMatch(/BIA VÀNG · BIA ĐEN · BOM INOX 1L · CHAI PET 900ML/);
    expect(html).toMatch(/<h3>Bia vàng<\/h3>/);
    expect(html).toMatch(/<h3>Bia đen<\/h3>/);
    expect(html).toMatch(/<h3>Bom inox 1L<\/h3>/);
    expect(html).toMatch(/<h3>Chai PET 900ml<\/h3>/);
  });

  it('S7 Năng lực phân phối: kho · xuất hàng · xe giao hàng · nhân viên', () => {
    expect(html).toMatch(/CHỦ ĐỘNG NGUỒN HÀNG — SẴN SÀNG PHỤC VỤ ĐẠI LÝ/);
    ['Kho hàng tại Tây Ninh', 'Hoạt động xuất hàng', 'Xe giao hàng', 'Nhân viên giao hàng'].forEach((t) =>
      expect(html).toContain(t)
    );
  });

  it('S7 ghi rõ ảnh minh họa, không giả làm bằng chứng thực tế', () => {
    expect(html).toMatch(/là\s*<strong>hình minh họa<\/strong>/);
    expect(html).toMatch(/không phải ảnh chụp thực tế kho hàng hoặc đội xe/);
  });

  it('S8 Quy trình hợp tác: đủ 5 bước', () => {
    const steps = ['Liên hệ Tây Ninh Bia Tươi', 'Nhận tư vấn và báo giá', 'Thống nhất sản phẩm, số lượng', 'Giao hàng tận quán', 'Hưởng chính sách và hỗ trợ'];
    steps.forEach((s) => expect(html).toContain(s));
    expect((html.match(/class="p-num"/g) || []).length).toBe(5);
  });

  it('S9 Khu vực phục vụ: Tây Ninh là trọng tâm', () => {
    expect(html).toMatch(/Tây Ninh — thị trường trọng tâm/);
    expect(html).toMatch(/Bình Dương/);
    expect(html).toMatch(/TP\. Hồ Chí Minh/);
  });

  it('S10 CTA cuối trang: hotline + Zalo', () => {
    expect(html).toMatch(/ĐANG KINH DOANH QUÁN NHẬU TẠI TÂY NINH\?/);
    expect(html).toMatch(/Gọi 0974 012 652/);
    expect(html).toMatch(/Nhắn Zalo ngay/);
  });
});

// ════════════════════════════════════════════════════════════════════
//  HÌNH ẢNH
// ════════════════════════════════════════════════════════════════════
describe('Landing page — hệ thống hình ảnh', () => {
  it('thư mục public/images/home/ tồn tại với 5 ảnh WebP', () => {
    expect(fs.existsSync(homeImgDir)).toBe(true);
    const webp = fs.readdirSync(homeImgDir).filter((f) => f.endsWith('.webp'));
    expect(webp.length).toBeGreaterThanOrEqual(5);
  });

  it('mọi ảnh homepage đều có content-hash (cache immutable an toàn)', () => {
    const refs = [...html.matchAll(/\/images\/home\/[\w.-]+\.webp/g)].map((m) => m[0]);
    expect(refs.length).toBeGreaterThanOrEqual(5);
    const unhashed = refs.filter((r) => !/\.[0-9a-f]{8}\.webp$/.test(r));
    expect(unhashed).toEqual([]);
  });

  it('mọi file ảnh trong /images/home/ đều tồn tại thật', () => {
    const refs = [...new Set([...html.matchAll(/\/images\/home\/[\w.-]+\.webp/g)].map((m) => m[0]))];
    refs.forEach((r) => expect(fs.existsSync(path.join(ROOT, 'public', r.replace(/^\//, '')))).toBe(true));
  });

  it('ảnh dưới màn hình đầu dùng lazy loading', () => {
    const imgs = [...html.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
    // Bỏ logo navbar (nằm trên cùng, cần tải ngay) và ảnh hero (LCP).
    const below = imgs.filter((t) => !t.includes('hero-beer') && !t.includes('nav-logo-img'));
    expect(below.length).toBeGreaterThan(0);
    below.forEach((t) => expect(t).toMatch(/loading="lazy"/));
  });

  it('ảnh hero được preload + fetchpriority=high', () => {
    expect(html).toMatch(/<link rel="preload" as="image"[^>]*hero-beer\.[0-9a-f]{8}\.webp/);
    expect(html).toMatch(/fetchpriority="high"/);
  });

  it('mọi ảnh đều có alt text', () => {
    const imgs = [...html.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
    imgs.forEach((t) => expect(t).toMatch(/alt="/));
  });

  it('ảnh minh họa được ghi rõ trong alt/caption', () => {
    expect(html).toMatch(/alt="[^"]*hình minh họa[^"]*"/i);
    expect(html).toMatch(/Hình minh họa/);
  });

  it('tổng dung lượng /images/home/ rất nhẹ (< 200KB)', () => {
    const total = fs
      .readdirSync(homeImgDir)
      .filter((f) => f.endsWith('.webp'))
      .reduce((s, f) => s + fs.statSync(path.join(homeImgDir, f)).size, 0);
    expect(total).toBeLessThan(200 * 1024);
  });

  it('không còn tham chiếu ảnh PNG nặng', () => {
    const pngRefs = [...html.matchAll(/landing-assets\/[\w-]+\.png/g)].map((m) => m[0]);
    expect(pngRefs).toEqual([]);
  });

  it('video dùng file nén 720p + preload="none"', () => {
    expect(html).toMatch(/landing-assets\/beer-mobile-720\.[0-9a-f]{8}\.mp4/);
    expect(html).toMatch(/preload="none"/);
  });

  it('landing.css không @import Google Fonts (tránh request chặn render)', () => {
    expect(css).not.toMatch(/@import\s+url\(['"]?https:\/\/fonts\.googleapis\.com/);
  });
});

// ════════════════════════════════════════════════════════════════════
//  SEO
// ════════════════════════════════════════════════════════════════════
describe('Landing page — SEO', () => {
  it('title + meta description có từ khóa mục tiêu và brand', () => {
    expect(html).toMatch(/<title>Tây Ninh Bia Tươi/);
    expect(html).toMatch(/nhà phân phối bia tươi tại Tây Ninh/i);
    expect(html).toMatch(/50 lít/);
  });

  it('có Open Graph + Twitter Card', () => {
    expect(html).toMatch(/property="og:title"/);
    expect(html).toMatch(/property="og:image"/);
    expect(html).toMatch(/name="twitter:card"/);
  });

  it('có canonical + robots meta + geo Tây Ninh', () => {
    expect(html).toMatch(/<link rel="canonical"/);
    expect(html).toMatch(/name="robots"/);
    expect(html).toMatch(/geo\.placename" content="Tây Ninh"/);
  });

  it('JSON-LD LocalBusiness hợp lệ, không chứa brand bị cấm', () => {
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(m).toBeTruthy();
    const json = JSON.parse(m[1]);
    expect(json['@type']).toBe('LocalBusiness');
    expect(json.name).toBe('Tây Ninh Bia Tươi');
    expect(json.telephone).toBeTruthy();
    expect(json.areaServed.length).toBeGreaterThan(0);
    expect(JSON.stringify(json)).not.toMatch(/gia[\s_-]?huy/i);
  });

  it('sitemap.xml liệt kê ảnh mới và không chứa brand bị cấm', () => {
    expect(sitemap).toMatch(/images\/home\/hero-beer\.[0-9a-f]{8}\.webp/);
    expect(sitemap).not.toMatch(/gia[\s_-]?huy/i);
  });

  it('có robots.txt + sitemap.xml trong public/', () => {
    expect(fs.existsSync(path.join(ROOT, 'public', 'robots.txt'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'public', 'sitemap.xml'))).toBe(true);
    expect(fs.readFileSync(path.join(ROOT, 'public', 'robots.txt'), 'utf8')).toMatch(/Sitemap:/);
  });

  it('đúng 1 thẻ H1', () => {
    expect((html.match(/<h1/g) || []).length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════
//  MOBILE / UX / A11Y
// ════════════════════════════════════════════════════════════════════
describe('Landing page — UX mobile & accessibility', () => {
  it('chatbot KHÔNG tự mở sau 5s (tránh che nội dung)', () => {
    expect(html).toMatch(/KHÔNG tự mở chatbot/);
    expect(html).toMatch(/window\.beerChatAutoOpened = false/);
  });

  it('sticky CTA mobile thành thanh ngang, không chồng chatbot', () => {
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?\.sticky-cta[\s\S]*?flex-direction: row/);
    expect(css).toMatch(/\.chat-fab \{[\s\S]*?bottom: 76px/);
  });

  it('mobile chừa chỗ cho thanh CTA cố định (không che nội dung)', () => {
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?body \{ padding-bottom: 78px/);
  });

  it('bảng so sánh cuộn ngang được trên màn hình hẹp', () => {
    expect(html).toMatch(/class="compare-wrap/);
    expect(css).toMatch(/@media \(max-width: 700px\)[\s\S]*?overflow-x: auto/);
  });

  it('có nút "lên đầu trang"', () => {
    expect(html).toMatch(/id="toTopBtn"/);
    expect(css).toMatch(/\.to-top-btn/);
  });

  it('nền tối & accent vàng bia theo phong cách premium', () => {
    expect(css).toMatch(/--gold:\s*#ffcc00/);
    expect(css).toMatch(/--black:\s*#0b0e11/);
    expect(css).toMatch(/body \{[\s\S]*?background: var\(--black\)/);
  });

  it('ảnh sản phẩm dùng object-fit contain (không cắt sai chủ thể)', () => {
    expect(css).toMatch(/\.prod-visual img \{[\s\S]*?object-fit: contain/);
  });

  it('counter animation cho 50L', () => {
    expect(html).toMatch(/data-count="50"/);
    expect(html).toMatch(/easeOutExpo/);
  });

  it('tôn trọng prefers-reduced-motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it('reveal chỉ ẩn khi JS bật + có safeguard scroll', () => {
    expect(html).toMatch(/classList\.add\('js'\)/);
    expect(css).toMatch(/\.js \.reveal \{ opacity: 0/);
    expect(html).toMatch(/checkReveals/);
  });

  it('touch target ≥ 48px trên thiết bị cảm ứng', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)/);
    expect(css).toMatch(/min-height: 48px/);
  });
});

// ════════════════════════════════════════════════════════════════════
//  SERVER
// ════════════════════════════════════════════════════════════════════
describe('server.js — cache header cho asset', () => {
  it('bật cache immutable cho asset có content-hash (áp dụng cả /images/home/)', () => {
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
