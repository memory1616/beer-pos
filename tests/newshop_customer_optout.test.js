/**
 * Khách hàng TẮT khuyến mãi quán mới → KHÔNG hiển thị Card "🏆 Thưởng quán mới"
 * ─────────────────────────────────────────────────────────────────────────────
 * BỐI CẢNH (bug report 2026-11-24):
 *   Khách hàng #63 đã được admin tắt "khuyến mãi quán mới"
 *   (customers.new_shop_enabled = 0) nhưng Card "Thưởng quán mới"
 *   vẫn hiện trên hoá đơn.
 *
 * NGUYÊN NHÂN:
 *   1. Backend `GET /api/promotions/new-shop/monthly-summary/:customerId`
 *      chỉ check "còn trong tháng mở quán", KHÔNG check cờ của khách.
 *   2. Backend `GET /api/driver/sale/promotions/new-shop/monthly-summary/:customerId`
 *      (bản Driver Portal) — lỗi tương tự.
 *   3. Frontend `renderInvoiceNewShopNote()` chỉ check `promotion_enabled`
 *      mà BỎ SÓT `new_shop_enabled`.
 *   4. `PromotionService.calculateNewShopMonthlyReward()` cũng không check.
 *
 * Test này kiểm tra SOURCE CODE (frontend + backend) vì UI thuần không
 * chạy được trong môi trường test Node.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SALES_JS = path.join(ROOT, 'public', 'js', 'sales.js');
const PROMO_ROUTES = path.join(ROOT, 'routes', 'api', 'promotions.js');
const DRIVER_ROUTES = path.join(ROOT, 'routes', 'api', 'driverSale.js');
const SERVICES = path.join(ROOT, 'src', 'services', 'index.js');

describe('Khách TẮT khuyến mãi quán mới → ẩn Card "Thưởng quán mới"', () => {
  let src;
  let promoRoutes;
  let driverRoutes;
  let services;

  beforeAll(() => {
    src = fs.readFileSync(SALES_JS, 'utf8');
    promoRoutes = fs.readFileSync(PROMO_ROUTES, 'utf8');
    driverRoutes = fs.readFileSync(DRIVER_ROUTES, 'utf8');
    services = fs.readFileSync(SERVICES, 'utf8');
  });

  test('frontend: renderInvoiceNewShopNote() check new_shop_enabled', () => {
    const fn = src.slice(
      src.indexOf('function renderInvoiceNewShopNote('),
      src.indexOf('function paintInvoiceNewShopNote(')
    );
    // Phải có check promotion_enabled VÀ new_shop_enabled
    expect(fn).toMatch(/customer\.promotion_enabled\s*===\s*0/);
    expect(fn).toMatch(/customer\.new_shop_enabled\s*===\s*0/);
  });

  test('frontend: check new_shop_enabled xảy ra TRƯỚC khi dùng cache / gọi API', () => {
    const fn = src.slice(
      src.indexOf('function renderInvoiceNewShopNote('),
      src.indexOf('function paintInvoiceNewShopNote(')
    );
    const checkIdx = fn.indexOf('new_shop_enabled');
    const cacheIdx = fn.indexOf('_newShopSummaryCache[cacheKey]');
    const fetchIdx = fn.indexOf("fetch('/api/promotions/new-shop/monthly-summary/");
    expect(checkIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(cacheIdx);
    expect(checkIdx).toBeLessThan(fetchIdx);
  });

  test('backend admin: monthly-summary trả eligible=false khi new_shop_enabled = 0', () => {
    const route = promoRoutes.slice(
      promoRoutes.indexOf("router.get('/new-shop/monthly-summary/:customerId'")
    );
    // Đọc cột new_shop_enabled từ DB
    expect(route).toMatch(/SELECT[\s\S]{0,200}new_shop_enabled[\s\S]{0,200}FROM customers/);
    // Có nhánh chặn
    expect(route).toMatch(/customer\.new_shop_enabled\s*===\s*0/);
    expect(route).toMatch(/customer\.promotion_enabled\s*===\s*0/);
    // Trả eligible false + lý do
    expect(route).toMatch(/eligible:\s*false[\s\S]{0,200}Khách đã tắt khuyến mãi quán mới/);
  });

  test('backend driver: monthly-summary trả eligible=false khi new_shop_enabled = 0', () => {
    const route = driverRoutes.slice(
      driverRoutes.indexOf("router.get('/promotions/new-shop/monthly-summary/:customerId'")
    );
    expect(route).toMatch(/SELECT[\s\S]{0,200}new_shop_enabled[\s\S]{0,200}FROM customers/);
    expect(route).toMatch(/customer\.new_shop_enabled\s*===\s*0/);
    expect(route).toMatch(/customer\.promotion_enabled\s*===\s*0/);
    expect(route).toMatch(/eligible:\s*false[\s\S]{0,200}Khách đã tắt khuyến mãi quán mới/);
  });

  test('service: calculateNewShopMonthlyReward() tôn trọng cờ của khách', () => {
    const fn = services.slice(
      services.indexOf('calculateNewShopMonthlyReward(customerId, year, month)'),
      services.indexOf('calculateNewShopMonthlyReward(customerId, year, month)')
        + 1600
    );
    expect(fn).toMatch(/promotion_enabled\s*===\s*0/);
    expect(fn).toMatch(/new_shop_enabled\s*===\s*0/);
    // Phải return empty khi bị chặn (không tính thưởng)
    expect(fn).toMatch(/if\s*\(cust\.promotion_enabled\s*===\s*0\)\s*return empty/);
    expect(fn).toMatch(/if\s*\(cust\.new_shop_enabled\s*===\s*0\)\s*return empty/);
  });

  test('isNewShopEligible() đã check new_shop_enabled (giữ nguyên)', () => {
    const fn = services.slice(
      services.indexOf('isNewShopEligible(customerId, targetMonth'),
      services.indexOf('isNewShopEligible(customerId, targetMonth') + 1200
    );
    expect(fn).toMatch(/customer\.new_shop_enabled\s*===\s*0/);
  });

  test('không thay đổi logic tính thưởng (vẫn dùng newShopGoldBuy/Free)', () => {
    const fn = services.slice(
      services.indexOf('calculateNewShopMonthlyReward(customerId, year, month)'),
      services.indexOf('calculateNewShopMonthlyReward(customerId, year, month)') + 2000
    );
    // Công thức gộp vàng + đen, chỉ tặng vàng — GIỮ NGUYÊN
    expect(fn).toMatch(/Math\.floor\(totalLiters\s*\/\s*settings\.newShopGoldBuy\)\s*\*\s*settings\.newShopGoldFree/);
    expect(fn).toMatch(/const blackReward\s*=\s*0/);
  });
});
