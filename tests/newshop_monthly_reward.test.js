/**
 * KM QUÁN MỚI — "N tặng M" theo TỔNG SẢN LƯỢNG THÁNG MỞ QUÁN
 * ─────────────────────────────────────────────────────────────────────────────
 * QUY TẮC (2026-11-22, cập nhật):
 *   1. "Quán mới" = THÁNG MỞ quán (tháng có created_at) — không phụ thuộc ngày nào.
 *   2. Tổng sản lượng TRONG THÁNG (bia VÀNG + bia ĐEN CỘNG LẠI) áp dụng:
 *        → newShopGoldBuy lít mua → newShopGoldFree lít BIA VÀNG tặng
 *   3. ⚠️ Quán mới CHỈ tặng BIA VÀNG — KHÔNG tặng bia đen.
 *   4. KHÔNG cộng dồn qua tháng (mỗi tháng reset độc lập).
 *   5. Thưởng trả vào đơn hàng đầu tiên của THÁNG SAU (như thưởng doanh số).
 *
 * Test này test hàm thuần `computeNewShopReward` (mô phỏng logic trong
 * PromotionService.calculateNewShopMonthlyReward) + hàm `computeIncremental`.
 */
process.env.TZ = 'Asia/Ho_Chi_Minh';

/** Hàm thuần — mirror PromotionService.calculateNewShopMonthlyReward */
function computeNewShopReward(yellowVolume, blackVolume, settings) {
  const buyGold = settings.newShopGoldBuy || 10;
  const freeGold = settings.newShopGoldFree || 1;

  // QUY TẮC 2026-11-22: gộp vàng + đen, chỉ tặng BIA VÀNG
  const totalLiters = (Number(yellowVolume) || 0) + (Number(blackVolume) || 0);
  const yellowReward = Math.floor(totalLiters / buyGold) * freeGold;
  const blackReward = 0;
  return {
    yellowReward,
    blackReward,
    totalReward: yellowReward + blackReward
  };
}

/** Chỉ trả phần VƯỢT MỐC chưa được tặng (tránh tặng trùng) */
function computeIncremental(yellowVolume, blackVolume, alreadyGiftGold, alreadyGiftBlack, settings) {
  const entitled = computeNewShopReward(yellowVolume, blackVolume, settings);
  // alreadyGiftGold + alreadyGiftBlack = tổng lít đã tặng trong tháng
  const alreadyGifted = alreadyGiftGold + alreadyGiftBlack;
  const freeGold = Math.max(0, entitled.yellowReward - alreadyGifted);
  const freeBlack = 0;
  return {
    freeGold,
    freeBlack,
    totalFree: freeGold + freeBlack
  };
}

const DEFAULT = {
  newShopGoldBuy: 10,
  newShopGoldFree: 1,
  newShopBlackBuy: 20,
  newShopBlackFree: 1
};

describe('KM quán mới — "10 tặng 1" theo tổng sản lượng tháng (chỉ tặng BIA VÀNG)', () => {
  test('mua đúng 10L vàng → tặng 1L vàng', () => {
    const r = computeNewShopReward(10, 0, DEFAULT);
    expect(r.yellowReward).toBe(1);
    expect(r.blackReward).toBe(0);
    expect(r.totalReward).toBe(1);
  });

  test('mua 9L vàng → chưa đủ, không tặng', () => {
    expect(computeNewShopReward(9, 0, DEFAULT).totalReward).toBe(0);
  });

  test('mua 25L vàng → tặng 2L (floor 25/10)', () => {
    expect(computeNewShopReward(25, 0, DEFAULT).totalReward).toBe(2);
  });

  test('mua 30L vàng → tặng 3L', () => {
    expect(computeNewShopReward(30, 0, DEFAULT).totalReward).toBe(3);
  });

  test('mua 20L đen → tặng 2L VÀNG (20/10), không tặng bia đen', () => {
    const r = computeNewShopReward(0, 20, DEFAULT);
    expect(r.yellowReward).toBe(2);
    expect(r.blackReward).toBe(0);
    expect(r.totalReward).toBe(2);
  });

  test('mua 9L đen → chưa đủ mốc 10L → không tặng', () => {
    expect(computeNewShopReward(0, 9, DEFAULT).totalReward).toBe(0);
  });

  test('mua 100L đen → tặng 10L VÀNG (floor 100/10)', () => {
    const r = computeNewShopReward(0, 100, DEFAULT);
    expect(r.yellowReward).toBe(10);
    expect(r.blackReward).toBe(0);
  });

  test('mua cả vàng + đen → GỘP LẠI, tặng toàn bộ bằng BIA VÀNG', () => {
    const r = computeNewShopReward(30, 40, DEFAULT);
    // Tổng 70L → floor(70/10) = 7L vàng
    expect(r.yellowReward).toBe(7);
    expect(r.blackReward).toBe(0);
    expect(r.totalReward).toBe(7);
  });

  test('tỉ lệ tùy chỉnh được áp dụng (mua 5 tặng 2)', () => {
    const s = {
      newShopGoldBuy: 5,
      newShopGoldFree: 2,
      newShopBlackBuy: 10,
      newShopBlackFree: 3
    };
    const r = computeNewShopReward(12, 25, s);
    // Tổng 37L → floor(37/5) * 2 = 14L vàng
    expect(r.yellowReward).toBe(14);
    expect(r.blackReward).toBe(0);
    expect(r.totalReward).toBe(14);
  });

  test('tỉ lệ = 1:1 (mua 1 tặng 1)', () => {
    const s = {
      newShopGoldBuy: 1,
      newShopGoldFree: 1,
      newShopBlackBuy: 1,
      newShopBlackFree: 1
    };
    expect(computeNewShopReward(7, 3, s).totalReward).toBe(10);
  });
});

describe('KM quán mới — KHÔNG cộng dồn qua tháng', () => {
  test('tháng 1 mua 7L (chưa đủ) → tháng 2 mua 5L → KHÔNG tặng (không cộng dồn)', () => {
    const thang1 = computeNewShopReward(7, 0, DEFAULT);   // 0
    const thang2 = computeNewShopReward(5, 0, DEFAULT);   // 0
    expect(thang1.totalReward).toBe(0);
    expect(thang2.totalReward).toBe(0);
    // Nếu cộng dồn (sai) thì 12L → 1L
    expect(computeNewShopReward(12, 0, DEFAULT).totalReward).toBe(1);
  });

  test('tháng 1 mua 12L → tặng 1L; tháng 2 mua 12L → tặng thêm 1L (reset mỗi tháng)', () => {
    expect(computeNewShopReward(12, 0, DEFAULT).totalReward).toBe(1);
    expect(computeNewShopReward(12, 0, DEFAULT).totalReward).toBe(1);
  });
});

describe('KM quán mới — tặng TĂNG dần theo đơn (không tặng trùng)', () => {
  test('đơn 1: mua 6L → chưa đủ mốc → 0', () => {
    const r = computeIncremental(6, 0, 0, 0, DEFAULT);
    expect(r.totalFree).toBe(0);
  });

  test('đơn 2: tổng 12L → tặng 1L', () => {
    const r = computeIncremental(12, 0, 0, 0, DEFAULT);
    expect(r.freeGold).toBe(1);
    expect(r.totalFree).toBe(1);
  });

  test('đơn 3: tổng 22L → chỉ tặng phần vượt (1L nữa, tổng 2L)', () => {
    const r = computeIncremental(22, 0, 1, 0, DEFAULT);
    expect(r.freeGold).toBe(1);
    expect(r.totalFree).toBe(1);
  });

  test('đơn 4: tổng 22L, đã tặng 2L → không tặng thêm', () => {
    const r = computeIncremental(22, 0, 2, 0, DEFAULT);
    expect(r.totalFree).toBe(0);
  });

  test('đơn 5: tổng 35L, đã tặng 2L → tặng thêm 1L', () => {
    const r = computeIncremental(35, 0, 2, 0, DEFAULT);
    expect(r.freeGold).toBe(1);
    expect(r.totalFree).toBe(1);
  });

  test('vàng + đen gộp chung, KHÔNG tặng trùng giữa 2 loại', () => {
    // Tổng 30L (10 vàng + 20 đen) → 3L vàng
    const r = computeIncremental(10, 20, 0, 0, DEFAULT);
    expect(r.freeGold).toBe(3);
    expect(r.freeBlack).toBe(0);
    expect(r.totalFree).toBe(3);
  });

  test('đã tặng cả vàng lẫn đen ở đơn trước → vẫn tính gộp vào phần đã tặng', () => {
    // Tổng 30L → 3L vàng; đã tặng 2L vàng + 1L đen = 3L → không tặng thêm
    const r = computeIncremental(10, 20, 2, 1, DEFAULT);
    expect(r.totalFree).toBe(0);
  });
});
