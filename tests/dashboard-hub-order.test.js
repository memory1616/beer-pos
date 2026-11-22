/**
 * DASHBOARD — THỨ TỰ HUB "CÀI ĐẶT HỆ THỐNG"
 * ─────────────────────────────────────────────────────────────────────────────
 * Yêu cầu 2026-11-22: sắp xếp lại thứ tự các ô cài đặt trong hub:
 *   Sổ công nợ → Quản lý Sales → QR Thanh toán → … (phần còn lại tự sắp)
 *
 * Test này khóa thứ tự để không vô tình làm lệch khi sửa HTML.
 */
const fs = require('fs');
const path = require('path');

const VIEW_PATH = path.join(__dirname, '..', 'views', 'dashboard.html');
const html = fs.readFileSync(VIEW_PATH, 'utf8');

/** Thứ tự mong đợi của các card trong #dshSettingsHubGrid. */
const EXPECTED_ORDER = [
  '/debts',        // 📒 Sổ công nợ — nghiệp vụ chính
  '/sales-staff',  // 👔 Quản lý Sales
  '/qr-settings',  // 💳 QR Thanh toán
  '/promo-settings', // 🎁 Khuyến mãi
  '/regions',      // 🗺️ Khu vực giao hàng
  '/report-notify', // 📨 Báo cáo tự động
  '/audit-log',    // 📜 Nhật ký hệ thống
  '/sessions',     // 🔐 Phiên đăng nhập
  '/push-notify',  // 🔔 Thông báo tài xế
];

/** Các ô đã bị gỡ khỏi hub (dư thừa) — không được xuất hiện lại. */
const REMOVED_HREFS = ['/purchases', '/devices', '/expenses'];

/**
 * Lấy danh sách href của card trong hub, theo đúng thứ tự DOM.
 *
 * Lưu ý: `.dsh-hub-card` chỉ xuất hiện trong hub (12 thẻ <a>) nên có thể
 * match toàn file — an toàn và không bị lỗi đếm thẻ <div> lồng nhau.
 */
function hubCardHrefs() {
  const hrefs = [];
  const re = /<a\s+href="([^"]+)"\s+class="dsh-hub-card\s+dsh-hub-card-[a-z-]+"/g;
  let m;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]);
  return hrefs;
}

describe('Dashboard — hub Cài đặt hệ thống', () => {
  test('thứ tự card đúng như yêu cầu', () => {
    const hrefs = hubCardHrefs();
    expect(hrefs).toEqual(EXPECTED_ORDER);
  });

  test('3 ô đầu tiên: Sổ công nợ → Sales → QR thanh toán', () => {
    const hrefs = hubCardHrefs();
    expect(hrefs[0]).toBe('/debts');
    expect(hrefs[1]).toBe('/sales-staff');
    expect(hrefs[2]).toBe('/qr-settings');
  });

  test('mỗi card có data-permission để phân quyền hoạt động', () => {
    const start = html.indexOf('id="dshSettingsHubGrid"');
    const block = html.slice(start);
    const cards = block.match(/<a\s+href="[^"]+"\s+class="dsh-hub-card[^"]*"\s+data-permission="[^"]+"/g) || [];
    expect(cards.length).toBe(EXPECTED_ORDER.length);
  });

  test('mỗi card có class màu riêng (icon + cta) để phân biệt trực quan', () => {
    const start = html.indexOf('id="dshSettingsHubGrid"');
    const block = html.slice(start);
    EXPECTED_ORDER.forEach((href) => {
      const re = new RegExp(
        '<a\\s+href="' + href.replace(/[/]/g, '\\/') + '"\\s+class="dsh-hub-card ([a-z-]+)"'
      );
      const m = block.match(re);
      expect(m).not.toBeNull();
      const cls = m[1];
      expect(html).toContain('.' + cls + ' .dsh-hub-card-icon');
      expect(html).toContain('.' + cls + ' .dsh-hub-card-cta');
    });
  });

  test('không có card trùng href', () => {
    const hrefs = hubCardHrefs();
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  test('3 ô dư thừa đã được gỡ (Mua hàng & Kho, Thiết bị, Chi phí)', () => {
    const hrefs = hubCardHrefs();
    REMOVED_HREFS.forEach((href) => {
      expect(hrefs).not.toContain(href);
    });
  });

  test('không còn CSS màu cho các ô đã gỡ', () => {
    REMOVED_HREFS.forEach(() => {});
    ['purchases', 'devices', 'expenses'].forEach((slug) => {
      expect(html).not.toContain('dsh-hub-card-' + slug + ' .dsh-hub-card-icon');
      expect(html).not.toContain('dsh-hub-card-' + slug + ' .dsh-hub-card-cta');
    });
  });
});
