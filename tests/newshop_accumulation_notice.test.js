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

  test('view admin + driver có element #invNewShopNote CẠNH Card khuyến mãi sản lượng', () => {
    for (const f of ['views/sales.html', 'views/driver/sale.html']) {
      const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(html).toContain('id="invNewShopNote"');
      // Thứ tự: Card khuyến mãi sản lượng (#invPromoNote) → Card thưởng quán mới
      const promoIdx = html.indexOf('id="invPromoNote"');
      const noteIdx = html.indexOf('id="invNewShopNote"');
      expect(promoIdx).toBeGreaterThan(-1);
      expect(noteIdx).toBeGreaterThan(promoIdx);
      // Card thưởng quán mới nằm trong khối có class invoice-promo-note
      expect(html).toContain('invoice-promo-note--newshop');
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

  test('render thành Card riêng "🏆 Thưởng quán mới" (KHÔNG gộp vào Card sản lượng)', () => {
    expect(src).toContain('promo-note--newshop');
    expect(src).toContain('Thưởng quán mới');
    // Dùng class promo-note__title giống Card sản lượng
    expect(src).toContain('promo-note__title');
    // KHÔNG dùng lại .bottle-row (đã bỏ dạng dòng rời rạc)
    expect(src).not.toMatch(/inv-newshop-note[^{]*\.bottle-row/);
  });

  test('Card có 3 nội dung: tích lũy, thưởng, thời gian trả thưởng', () => {
    expect(src).toContain('Tích lũy:');
    expect(src).toContain('Thưởng:');
    expect(src).toContain('Trả thưởng:');
    // Tích lũy hiển thị tổng + chi tiết vàng/đen
    expect(src).toContain('Vàng <strong>');
    expect(src).toContain('Đen <strong>');
    expect(src).toContain('(Tổng ');
  });

  test('thưởng hiển thị số lượng + loại bia được thưởng', () => {
    expect(src).toContain('L Bia Vàng');
    expect(src).toContain('L Bia Đen');
  });

  test('thời gian trả thưởng = đơn đầu tiên tháng kế tiếp (tính từ tháng mở quán)', () => {
    expect(src).toContain('Đơn đầu tiên tháng');
    expect(src).toContain('payMonth');
    expect(src).toContain('payYear');
    // Dòng thời gian dùng chung class promo-note__row (nowrap + ellipsis)
    expect(src).toContain('promo-note__row');
  });

  test('hiển thị số lít còn thiếu khi chưa đủ mốc thưởng', () => {
    expect(src).toContain('cần thêm');
    expect(src).toMatch(/litersToNext/);
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

  test('CSS có style cho Card thưởng quán mới', () => {
    expect(css).toMatch(/\.promo-note--volume\s*\{[^}]*\}/);
    expect(css).toMatch(
      /\.invoice-promo-note--newshop\.hidden\s*\{[^}]*display:\s*none\s*!important/
    );
    // Card dùng CHUNG hệ style với Card khuyến mãi sản lượng
    expect(css).toMatch(/\.promo-note--volume\.is-newshop\s*\{/);
    // Chống tràn chữ ngang
    expect(css).toMatch(/\.promo-note--volume\s*\{[^}]*overflow-wrap/);
    // Mỗi dòng là 1 flex row không xuống dòng
    expect(css).toMatch(/\.promo-note--volume \.promo-note__row\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.promo-note--volume \.promo-note__row\s*\{[^}]*display:\s*flex/);
  });

  test('Card khuyến mãi sản lượng dùng class, KHÔNG còn inline style font-size:11px', () => {
    // Không còn inline style cứng (dễ vỡ responsive)
    expect(src).not.toMatch(/class="promo-note" style="[^"]*font-size:11px/);
    expect(src).toContain('promo-note promo-note--volume is-reward');
    expect(src).toContain('promo-note promo-note--volume is-pending');
  });

  test('Card khuyến mãi sản lượng: chữ lớn + màu tươi sáng, có clamp()', () => {
    // Font co giãn theo màn hình (clamp) → không tràn
    const volRule = css.match(/\.promo-note--volume\s*\{[^}]*\}/)[0];
    expect(volRule).toMatch(/font-size:\s*clamp\(/);
    // Tiêu đề đậm + lớn hơn
    expect(css).toMatch(/\.promo-note--volume \.promo-note__title\s*\{[^}]*font-weight:\s*800/);
    expect(css).toMatch(/\.promo-note--volume \.promo-note__title\s*\{[^}]*font-size:\s*clamp\(/);
    // Màu phải đi qua THEME TOKEN (không hardcode) → tự đổi theo Dark/Light
    expect(css).toMatch(/\.promo-note--volume \.promo-note__title\s*\{[^}]*color:\s*var\(--promo-title\)/);
    expect(css).toMatch(/\.promo-note--volume\.is-pending \.promo-note__title\s*\{[^}]*color:\s*var\(--promo-pending-title\)/);
    expect(css).toMatch(/\.promo-note--volume\.is-newshop \.promo-note__title\s*\{[^}]*color:\s*var\(--promo-newshop-title\)/);
    // Token PHẢI được định nghĩa cho cả 2 theme trong tokens.css
    const tokens = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'tokens.css'), 'utf8');
    ['--promo-title', '--promo-pending-title', '--promo-newshop-title'].forEach((tk) => {
      expect(tokens).toMatch(new RegExp(tk + '\\s*:'));
    });
  });

  test('dòng bị cắt (ellipsis) vẫn có tooltip để xem đầy đủ', () => {
    expect(src).toMatch(/promo-note__row" title="/);
    expect(css).toMatch(/\.promo-note--volume \.promo-note__row > span:last-child\s*\{[^}]*text-overflow:\s*ellipsis/);
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

describe('Driver portal — Card thưởng quán mới', () => {
  let shim;
  let driverRoute;

  beforeAll(() => {
    shim = fs.readFileSync(path.join(ROOT, 'public', 'js', 'driver', 'api-shim.js'), 'utf8');
    driverRoute = fs.readFileSync(path.join(ROOT, 'routes', 'api', 'driverSale.js'), 'utf8');
  });

  test('api-shim rewrite /api/promotions/new-shop/monthly-summary/ → route driver', () => {
    expect(shim).toContain("'/api/promotions/new-shop/monthly-summary/'");
    expect(shim).toMatch(
      /PREFIX_MAP[\s\S]*?\/api\/promotions\/new-shop\/monthly-summary\/[^\n]*\/promotions\/new-shop\/monthly-summary\//
    );
  });

  test('driverSale có route monthly-summary (shape giống admin)', () => {
    expect(driverRoute).toContain("router.get('/promotions/new-shop/monthly-summary/:customerId'");
    // Dùng lại đúng service của admin (không nhân bản công thức)
    expect(driverRoute).toContain('PromotionService.calculateNewShopMonthlyReward(');
    // Trả đủ field mà frontend cần
    expect(driverRoute).toContain('yellowVolume');
    expect(driverRoute).toContain('blackVolume');
    expect(driverRoute).toContain('yellowReward');
    expect(driverRoute).toContain('blackReward');
    expect(driverRoute).toContain('totalReward');
    expect(driverRoute).toContain('openYear');
    expect(driverRoute).toContain('openMonth');
    expect(driverRoute).toContain('eligible');
  });
});

describe('Modal hóa đơn — ổn định khi cuộn / co giãn màn hình', () => {
  let src;
  let css;

  beforeAll(() => {
    src = fs.readFileSync(SALES_JS, 'utf8');
    css = fs.readFileSync(CSS, 'utf8');
  });

  test('CHỈ 1 container scroll (không lồng nhau)', () => {
    // .inv-pos-body = vùng cuộn; .inv-pos-inner = chỉ bố trí
    const bodyRule = css.match(/\.inv-pos-body\s*\{[^}]*\}/)[0];
    const innerRule = css.match(/\.inv-pos-inner\s*\{[^}]*\}/)[0];
    expect(bodyRule).toMatch(/overflow-y:\s*auto/);
    expect(innerRule).not.toMatch(/overflow-y:\s*auto/);
    expect(innerRule).toMatch(/overflow:\s*visible/);
  });

  test('vùng cuộn không lan overscroll ra ngoài (iOS)', () => {
    const bodyRule = css.match(/\.inv-pos-body\s*\{[^}]*\}/)[0];
    expect(bodyRule).toMatch(/overscroll-behavior:\s*contain/);
    expect(bodyRule).toMatch(/-webkit-overflow-scrolling:\s*touch/);
  });

  test('autoScaleInvoiceModal không set width inline (tránh nhảy layout khi resize)', () => {
    const fnStart = src.indexOf('function autoScaleInvoiceModal(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, fnStart + 2000);
    // Reset transform trước khi đo
    expect(fnBody).toContain("modal.style.transform = 'none'");
    // KHÔNG set width/maxWidth inline
    expect(fnBody).not.toMatch(/modal\.style\.width\s*=\s*\(/);
    expect(fnBody).not.toMatch(/modal\.style\.maxWidth\s*=\s*\(/);
  });

  test('có listener resize/orientationchange để scale lại modal', () => {
    expect(src).toContain("window.addEventListener('resize'");
    expect(src).toContain("window.addEventListener('orientationchange'");
    expect(src).toContain('visualViewport');
  });

  test('scale lại modal khi Card khuyến mãi render xong (tránh modal nhảy)', () => {
    // Card sản lượng
    const promoIdx = src.indexOf("promoNoteEl.innerHTML = html;");
    expect(promoIdx).toBeGreaterThan(-1);
    expect(src.slice(promoIdx, promoIdx + 200)).toContain('autoScaleInvoiceModal()');
    // Card thưởng quán mới
    const nsIdx = src.indexOf('paintInvoiceNewShopNote(el, d);');
    expect(nsIdx).toBeGreaterThan(-1);
    const paintStart = src.indexOf('function paintInvoiceNewShopNote(');
    const paintBody = src.slice(paintStart, paintStart + 4000);
    expect(paintBody).toContain('autoScaleInvoiceModal()');
  });
});
