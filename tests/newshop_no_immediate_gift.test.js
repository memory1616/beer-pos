/**
 * KM QUÁN MỚI — KHÔNG TẶNG NGAY TRONG ĐƠN (chống tặng trùng)
 * ─────────────────────────────────────────────────────────────────────────────
 * BỐI CẢNH (2026-11-23):
 *   Trước đây `routes/api/sales.js` (POST + PUT) gọi `calculateNewShopPromotion()`
 *   → cộng lít tặng (sale_items price=0) NGAY vào đơn + `deliver_kegs` + trừ kho.
 *   Sau đó tháng sau auto-claim lại gắn thêm lần nữa (promo_type='NEW_SHOP_BONUS')
 *   → TẶNG TRÙNG 2 LẦN cho cùng 1 tháng.
 *
 * NGUYÊN TẮC ĐÚNG (giống thưởng doanh số):
 *   "N tặng M" của THÁNG MỞ QUÁN được tính theo TỔNG sản lượng tháng đó,
 *   rồi trả vào ĐƠN HÀNG ĐẦU TIÊN CỦA THÁNG KẾ TIẾP.
 *
 * Mục tiêu test: bảo vệ luồng đúng, không cho code cũ quay lại.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

describe('KM quán mới — không tặng ngay trong đơn', () => {
  let salesRouteSrc;
  let serviceSrc;

  beforeAll(() => {
    salesRouteSrc = fs.readFileSync(path.join(ROOT, 'routes/api/sales.js'), 'utf8');
    serviceSrc = fs.readFileSync(path.join(ROOT, 'src/services/index.js'), 'utf8');
  });

  // ── 1. POST / (tạo đơn) ────────────────────────────────────────────────
  describe('POST / (tạo đơn)', () => {
    test('KHÔNG gọi calculateNewShopPromotion trong luồng tạo đơn', () => {
      const callIdx = salesRouteSrc.indexOf('PromotionService.calculateNewShopPromotion(');
      expect(callIdx).toBe(-1);
    });

    test('KHÔNG có block trừ kho lít tặng (promo_new_shop) trong create', () => {
      // Block cũ từng có `reason: 'promo_new_shop'` + INSERT sale_items price=0
      expect(salesRouteSrc).not.toContain("reason: 'promo_new_shop'");
    });

    test('promoInfo khi quán mới chỉ mang NHÃN, không có lít tặng', () => {
      expect(salesRouteSrc).toContain(
        "promoInfo = { freeGold: 0, freeBlack: 0, totalFree: 0, promoType: 'NEW_SHOP' }"
      );
    });

    test('KHÔNG cộng promoFreeTotal vào deliver_kegs khi KM quán mới', () => {
      // finalDeliverKegs phải dùng kegQuantity (lít mua thật), không cộng lít tặng
      const idx = salesRouteSrc.indexOf('const finalDeliverKegs');
      expect(idx).toBeGreaterThan(-1);
      const block = salesRouteSrc.slice(idx, idx + 400);
      expect(block).toContain('kegQuantity');
    });

    test('vẫn giữ nhãn NEW_SHOP để báo cáo nhận biết tháng mở quán', () => {
      expect(salesRouteSrc).toContain("promoType: 'NEW_SHOP'");
    });
  });

  // ── 2. PUT /:id (sửa đơn) ───────────────────────────────────────────────
  describe('PUT /:id (sửa đơn)', () => {
    test('KHÔNG gọi calculateNewShopPromotion trong luồng sửa đơn', () => {
      const callIdx = salesRouteSrc.indexOf('PromotionService.calculateNewShopPromotion(');
      expect(callIdx).toBe(-1);
    });

    test('nhánh sửa đơn cũng chỉ giữ nhãn NEW_SHOP, không tặng lít', () => {
      // Phải có đúng 2 chỗ set promoInfo: POST + PUT
      const matches = salesRouteSrc.match(
        /promoInfo = \{ freeGold: 0, freeBlack: 0, totalFree: 0, promoType: 'NEW_SHOP' \}/g
      );
      expect(matches).toHaveLength(2);
    });
  });

  // ── 3. Luồng trả thưởng đúng: đơn đầu tiên tháng kế tiếp ──────────────
  describe('Luồng trả thưởng (đơn đầu tiên tháng kế tiếp)', () => {
    // Tìm vị trí CODE (không phải comment): dùng `const program = ...` rồi
    // `if (program === 'NEW_CUSTOMER')`
    function findNewCustomerBranch(src) {
      const declIdx = src.indexOf('const program = PromotionService.determinePromotionProgram(');
      expect(declIdx).toBeGreaterThan(-1);
      const branchIdx = src.indexOf("program === 'NEW_CUSTOMER'", declIdx);
      expect(branchIdx).toBeGreaterThan(-1);
      return src.slice(branchIdx, branchIdx + 2000);
    }

    test('auto-reward nhánh NEW_CUSTOMER gắn NEW_SHOP_BONUS', () => {
      const block = findNewCustomerBranch(salesRouteSrc);
      expect(block).toContain('getRewardForPrevMonth');
      expect(block).toContain("'NEW_SHOP_BONUS'");
    });

    test('attachRewardToSale nhận đủ yellowReward/blackReward', () => {
      const block = findNewCustomerBranch(salesRouteSrc);
      expect(block).toContain('rewardInfo.yellowReward');
      expect(block).toContain('rewardInfo.blackReward');
    });

    test('calculateNewShopMonthlyReward chỉ tặng BIA VÀNG, tỉ lệ theo tổng vàng+đen', () => {
      const idx = serviceSrc.indexOf('calculateNewShopMonthlyReward(customerId, year, month)');
      expect(idx).toBeGreaterThan(-1);
      const block = serviceSrc.slice(idx, idx + 2000);
      expect(block).toContain('const totalLiters = yellowVolume + blackVolume;');
      expect(block).toContain('const blackReward = 0;');
    });

    test('isNewShopEligible xác định quán mới theo THÁNG created_at', () => {
      const idx = serviceSrc.indexOf('isNewShopEligible(customerId, targetMonth');
      expect(idx).toBeGreaterThan(-1);
      const block = serviceSrc.slice(idx, idx + 2500);
      expect(block).toContain('isOpenMonth');
      expect(block).toContain('freeBlack: 0');
    });
  });

  // ── 4. Frontend: badge không còn text quy tắc cũ ────────────────────────
  describe('Frontend (POS)', () => {
    let salesJs;

    beforeAll(() => {
      salesJs = fs.readFileSync(path.join(ROOT, 'public/js/sales.js'), 'utf8');
    });

    test('badge không còn text hardcode quy tắc cũ', () => {
      // Loại bỏ comment giải thích rồi kiểm tra phần CODE render
      const codeOnly = salesJs
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n');
      expect(codeOnly).not.toContain('Mua 10L vàng tặng 1L');
      expect(codeOnly).not.toContain('Mua 20L đen tặng 1L');
    });

    test('badge đọc tỉ lệ động từ promoSettings', () => {
      expect(salesJs).toContain('saleState.promoSettings?.newShopGoldBuy');
      expect(salesJs).toContain('saleState.promoSettings?.newShopGoldFree');
    });

    test('badge nói rõ thưởng trả ở đơn đầu tiên tháng sau', () => {
      expect(salesJs).toContain('Thưởng trả vào đơn đầu tiên của tháng sau');
    });

    test('customer-detail không còn hiển thị "Mua 20L đen tặng 1L"', () => {
      const detailHtml = fs.readFileSync(path.join(ROOT, 'views/customer-detail.html'), 'utf8');
      // Không còn dựng chuỗi "Mua ...L đen + ...L"
      expect(detailHtml).not.toMatch(/'L đen \+ '/);
      expect(detailHtml).not.toMatch(/blackBuy\s*:\s*settings\.newShopBlackBuy/);
    });
  });

  // ── 5. Driver API không trả quy tắc đen cũ ──────────────────────────────
  test('driver API newShopSettings phản ánh quy tắc mới (đen = 0)', () => {
    const driverSrc = fs.readFileSync(path.join(ROOT, 'routes/api/driver.js'), 'utf8');
    const idx = driverSrc.indexOf('newShopSettings: {');
    expect(idx).toBeGreaterThan(-1);
    const block = driverSrc.slice(idx, idx + 400);
    expect(block).not.toContain('settings.newShopBlackBuy');
    expect(block).not.toContain('settings.newShopBlackFree');
  });
});
