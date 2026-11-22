/**
 * KM QUÁN MỚI — "N tặng M" theo TỔNG SẢN LƯỢNG THÁNG MỞ QUÁN
 * ─────────────────────────────────────────────────────────────────────────────
 * QUY TẮC (2026-11-22):
 *   1. "Quán mới" = THÁNG MỞ quán (tháng có created_at) — không phụ thuộc ngày nào.
 *   2. Tổng sản lượng TRONG THÁNG áp dụng theo cài đặt:
 *        + Bia vàng: newShopGoldBuy lít mua → newShopGoldFree lít tặng
 *        + Bia đen : newShopBlackBuy lít mua → newShopBlackFree lít tặng
 *   3. KHÔNG cộng dồn qua tháng (mỗi tháng reset độc lập).
 *   4. Thưởng trả vào đơn hàng đầu tiên của THÁNG SAU (như thưởng doanh số).
 *
 * Test này test hàm thuần `computeNewShopReward` (mô phỏng logic trong
 * PromotionService.calculateNewShopMonthlyReward) + hàm `computeIncremental`.
 */
process.env.TZ = 'Asia/Ho_Chi_Minh';

/** Hàm thuần — mirror PromotionService.calculateNewShopMonthlyReward */
function computeNewShopReward(yellowVolume, blackVolume, settings) {
  const buyGold = settings.newShopGoldBuy || 10;
  const freeGold = settings.newShopGoldFree || 1;
  const buyBlack = settings.newShopBlackBuy || 20;
  const freeBlack = settings.newShopBlackFree || 1;

  const yellowReward = Math.floor(yellowVolume / buyGold) * freeGold;
  const blackReward = Math.floor(blackVolume / buyBlack) * freeBlack;
  return {
    yellowReward,
    blackReward,
    totalReward: yellowReward + blackReward
  };
}

/** Chỉ trả phần VƯỢT MỐC chưa được tặng (tránh tặng trùng) */
function computeIncremental(yellowVolume, blackVolume, alreadyGiftGold, alreadyGiftBlack, settings) {
  const entitled = computeNewShopReward(yellowVolume, blackVolume, settings);
  const freeGold = Math.max(0, entitled.yellowReward - alreadyGiftGold);
  const freeBlack = Math.max(0, entitled.blackReward - alreadyGiftBlack);
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

describe('KM quán mới — "10 tặng 1" theo tổng sản lượng tháng', () => {
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

  test('mua 19L đen (mặc định 20 tặng 1) → chưa đủ', () => {
    expect(computeNewShopReward(0, 19, DEFAULT).totalReward).toBe(0);
  });

  test('mua 20L đen → tặng 1L đen', () => {
    const r = computeNewShopReward(0, 20, DEFAULT);
    expect(r.blackReward).toBe(1);
    expect(r.yellowReward).toBe(0);
  });

  test('mua cả vàng + đen → tính riêng từng loại', () => {
    const r = computeNewShopReward(30, 40, DEFAULT);
    expect(r.yellowReward).toBe(3);
    expect(r.blackReward).toBe(2);
    expect(r.totalReward).toBe(5);
  });

  test('tỉ lệ tùy chỉnh được áp dụng (vàng 5 tặng 2, đen 10 tặng 3)', () => {
    const s = {
      newShopGoldBuy: 5,
      newShopGoldFree: 2,
      newShopBlackBuy: 10,
      newShopBlackFree: 3
    };
    const r = computeNewShopReward(12, 25, s);
    expect(r.yellowReward).toBe(4); // floor(12/5) * 2
    expect(r.blackReward).toBe(6); // floor(25/10) * 3
    expect(r.totalReward).toBe(10);
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
    // Tính RIÊNG từng tháng (không cộng dồn)
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

  test('vàng và đen đếm riêng, không trừ chéo', () => {
    const r = computeIncremental(10, 20, 0, 0, DEFAULT);
    expect(r.freeGold).toBe(1);
    expect(r.freeBlack).toBe(1);
    expect(r.totalFree).toBe(2);
  });
});
