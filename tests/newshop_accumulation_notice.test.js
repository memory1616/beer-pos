/**
 * Thông báo tích luỹ + dự kiến thưởng cho KHÁCH MỚI MỞ QUÁN trong tháng.
 * ─────────────────────────────────────────────────────────────────────────────
 * BỐI CẢNH:
 *  Yêu cầu: khi xem HOÁ ĐƠN của khách mới mở quán, phải thấy thông báo
 *  cập nhật số lít bia đã tích luỹ và dự kiến thưởng khi sang tháng sau.
 *
 *  Vị trí hiển thị: NGAY DƯỚI header modal hóa đơn (`#invNewShopNote`),
 *  tức là dưới `.inv-pos-header` (div chứa "× HÓA ĐƠN").
 *
 *  KHÔNG hiển thị ở form bán hàng (thông báo cũ `#newShopActiveNotice`).
 *
 * Test này kiểm tra SOURCE CODE frontend vì UI thuần không chạy được
 * trong môi trường test Node.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SALES_JS = path.join(ROOT, 'public', 'js', 'sales.js');
const CSS = path.join(ROOT, 'public', 'css', 'unified.css');

describe('Modal hóa đơn — thông báo tích luỹ & dự kiến thưởng (khách mới mở quán)', () => {
  let src;
  let css;

  beforeAll(() => {
    src = fs.readFileSync(SALES_JS, 'utf8');
    css = fs.readFileSync(CSS, 'utf8');
  });

  test('view admin + driver có element #invNewShopNote NGAY DƯỚI .inv-pos-header', () => {
    for (const f of ['views/sales.html', 'views/driver/sale.html']) {
      const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(html).toContain('id="invNewShopNote"');
      // Thứ tự: header → note → body
      const headerIdx = html.indexOf('class="inv-pos-header"');
      const noteIdx = html.indexOf('id="invNewShopNote"');
      const bodyIdx = html.indexOf('class="inv-pos-body"');
      expect(headerIdx).toBeGreaterThan(-1);
      expect(noteIdx).toBeGreaterThan(headerIdx);
      expect(bodyIdx).toBeGreaterThan(noteIdx);
    }
  });

  test('renderInvoiceNewShopNote() gọi API monthly-summary', () => {
    expect(src).toContain('function renderInvoiceNewShopNote(');
    expect(src).toMatch(
      /api\/promotions\/new-shop\/monthly-summary\/' \+ customerId/
    );
    expect(src).toMatch(/cache:\s*'no-store'/);
  });

  test('được gọi khi render nội dung modal hóa đơn', () => {
    expect(src).toContain('renderInvoiceNewShopNote(invoice);');
  });

  test('hiển thị số lít đã tích luỹ + dự kiến thưởng', () => {
    expect(src).toContain('Đã tích luỹ:');
    expect(src).toContain('Dự kiến thưởng tháng này:');
    expect(src).toMatch(/<strong>' \+ reward \+ 'L bia vàng<\/strong>/);
  });

  test('hiển thị số lít còn thiếu khi chưa đủ mốc thưởng', () => {
    expect(src).toContain('cần thêm');
    expect(src).toMatch(/litersToNext/);
  });

  test('giữ thông báo "gắn vào đơn đầu tiên của tháng sau"', () => {
    expect(src).toContain('đơn đầu tiên của tháng sau');
  });

  test('ẩn note khi đóng modal hóa đơn', () => {
    const fnStart = src.indexOf('function closeInvoice()');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, fnStart + 900);
    expect(fnBody).toContain("getElementById('invNewShopNote')");
    expect(fnBody).toMatch(/nsNote\.classList\.add\('hidden'\)/);
  });

  test('xóa cache khi sửa đơn (để số liệu mới)', () => {
    const fnStart = src.indexOf('function updateSale()');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('_newShopSummaryCache = {};');
  });

  test('CSS có style cho .inv-newshop-note', () => {
    expect(css).toMatch(/\.inv-newshop-note\s*\{[^}]*\}/);
    expect(css).toMatch(/\.inv-newshop-note\.hidden\s*\{[^}]*display:\s*none\s*!important/);
    expect(css).toContain('.inv-newshop-note__title');
    expect(css).toContain('.inv-newshop-note__row');
  });

  test('KHÔNG hiển thị thông báo tích luỹ ở form bán hàng', () => {
    // showNewShopActiveNotice() phải quay lại bản text tĩnh (không gọi API)
    const fnStart = src.indexOf('function showNewShopActiveNotice(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, fnStart + 1500);
    expect(fnBody).not.toContain('new-shop/monthly-summary');
    expect(fnBody).not.toContain('Đã tích luỹ');
  });
});
