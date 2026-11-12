/**
 * Unit test cho promotionCalc.calculatePromotion()
 * (Chuyển từ script gốc test_promotion.js → Jest để chạy tự động trong CI)
 */
const {
  calculatePromotion,
  formatRewardLabel,
  getNextTierProgress,
  REWARD_MODES
} = require('../src/services/promotionCalc');

// [yellow, black, expectedMode, expectedLabel]
const cases = [
  [0, 0, REWARD_MODES.NONE, 'Không thưởng'],
  [299, 0, REWARD_MODES.YELLOW_ONLY, 'Không thưởng'],
  [300, 0, REWARD_MODES.YELLOW_ONLY, '20L Bia Vàng'],
  [499, 0, REWARD_MODES.YELLOW_ONLY, '20L Bia Vàng'],
  [500, 0, REWARD_MODES.YELLOW_ONLY, '40L Bia Vàng'],
  [700, 0, REWARD_MODES.YELLOW_ONLY, '40L Bia Vàng'],
  [0, 299, REWARD_MODES.BLACK_ONLY, 'Không thưởng'],
  [0, 300, REWARD_MODES.BLACK_ONLY, '20L Bia Đen'],
  [0, 499, REWARD_MODES.BLACK_ONLY, '20L Bia Đen'],
  [0, 500, REWARD_MODES.BLACK_ONLY, '40L Bia Đen'],
  [0, 700, REWARD_MODES.BLACK_ONLY, '40L Bia Đen'],
  [100, 100, REWARD_MODES.MIXED, 'Không thưởng'],
  [200, 100, REWARD_MODES.MIXED, '20L Bia Vàng'],
  [200, 200, REWARD_MODES.MIXED, '20L Bia Vàng'],
  [250, 250, REWARD_MODES.MIXED, '40L Bia Vàng'],
  [299, 299, REWARD_MODES.MIXED, '40L Bia Vàng'],
  [300, 1, REWARD_MODES.MIXED, '20L Bia Vàng'],
  [300, 100, REWARD_MODES.MIXED, '20L Bia Vàng'],
  [300, 199, REWARD_MODES.MIXED, '20L Bia Vàng'],
  [300, 200, REWARD_MODES.MIXED, '40L Bia Vàng'],
  [400, 100, REWARD_MODES.MIXED, '40L Bia Vàng'],
  [499, 1, REWARD_MODES.MIXED, '40L Bia Vàng'],
  // Lưu ý: khi MUA CẢ HAI nhưng chỉ 1 loại đạt 300L và tổng < 500L →
  // thưởng 20L THEO LOẠI ĐẠT (vàng 1L + đen 300L → 20L Bia Đen).
  // Đây là hành vi hiện hành của promotionCalc.js (SSOT).
  [1, 300, REWARD_MODES.MIXED, '20L Bia Đen'],
  [100, 300, REWARD_MODES.MIXED, '20L Bia Đen'],
  [199, 300, REWARD_MODES.MIXED, '20L Bia Đen'],
  [200, 300, REWARD_MODES.MIXED, '40L Bia Vàng'],
  [100, 400, REWARD_MODES.MIXED, '40L Bia Vàng'],
  [1, 499, REWARD_MODES.MIXED, '40L Bia Vàng'],
  [300, 299, REWARD_MODES.MIXED, '40L Bia Vàng'],
  [299, 300, REWARD_MODES.MIXED, '40L Bia Vàng'],
  [300, 300, REWARD_MODES.SEPARATE, '20L Bia Vàng + 20L Bia Đen'],
  [400, 300, REWARD_MODES.SEPARATE, '20L Bia Vàng + 20L Bia Đen'],
  [300, 400, REWARD_MODES.SEPARATE, '20L Bia Vàng + 20L Bia Đen'],
  [499, 499, REWARD_MODES.SEPARATE, '20L Bia Vàng + 20L Bia Đen'],
  [500, 300, REWARD_MODES.SEPARATE, '40L Bia Vàng + 20L Bia Đen'],
  [300, 500, REWARD_MODES.SEPARATE, '20L Bia Vàng + 40L Bia Đen'],
  [500, 499, REWARD_MODES.SEPARATE, '40L Bia Vàng + 20L Bia Đen'],
  [499, 500, REWARD_MODES.SEPARATE, '20L Bia Vàng + 40L Bia Đen'],
  [500, 500, REWARD_MODES.SEPARATE, '40L Bia Vàng + 40L Bia Đen'],
  [700, 600, REWARD_MODES.SEPARATE, '40L Bia Vàng + 40L Bia Đen']
];

describe('promotionCalc.calculatePromotion', () => {
  test.each(cases)('vàng=%i đen=%i → mode=%s label=%s', (y, b, expMode, expLabel) => {
    const r = calculatePromotion(y, b);
    expect(r.mode).toBe(expMode);
    expect(formatRewardLabel(r)).toBe(expLabel);
  });
});

describe('promotionCalc.formatRewardLabel', () => {
  test('null → Không thưởng', () => {
    expect(formatRewardLabel(null)).toBe('Không thưởng');
  });

  test('0/0 → Không thưởng', () => {
    expect(formatRewardLabel({ yellowReward: 0, blackReward: 0, mode: 'NONE' })).toBe('Không thưởng');
  });

  test('chỉ vàng', () => {
    expect(formatRewardLabel({ yellowReward: 40, blackReward: 0, mode: 'YELLOW_ONLY' })).toBe('40L Bia Vàng');
  });

  test('chỉ đen', () => {
    expect(formatRewardLabel({ yellowReward: 0, blackReward: 20, mode: 'BLACK_ONLY' })).toBe('20L Bia Đen');
  });

  test('cả hai', () => {
    expect(formatRewardLabel({ yellowReward: 40, blackReward: 40, mode: 'SEPARATE' })).toBe(
      '40L Bia Vàng + 40L Bia Đen'
    );
  });
});

describe('promotionCalc.getNextTierProgress', () => {
  test('dưới 300L → next 300', () => {
    const p = getNextTierProgress(100, 50);
    expect(p.nextThreshold).toBe(300);
    expect(p.litersToNext).toBe(150);
    expect(p.isSeparate).toBe(false);
  });

  test('300–500L → next 500', () => {
    const p = getNextTierProgress(350, 0);
    expect(p.nextThreshold).toBe(500);
    expect(p.litersToNext).toBe(150);
    expect(p.isMixed).toBe(true);
  });

  test('≥500L → không còn mốc', () => {
    const p = getNextTierProgress(600, 0);
    expect(p.nextThreshold).toBeNull();
    expect(p.litersToNext).toBe(0);
  });

  test('SEPARATE đã đạt cả 40L → không còn mốc', () => {
    const p = getNextTierProgress(500, 500);
    expect(p.nextThreshold).toBeNull();
    expect(p.isSeparate).toBe(true);
  });

  test('SEPARATE mới đạt 1 loại → next 500', () => {
    const p = getNextTierProgress(300, 300);
    expect(p.nextThreshold).toBe(500);
    expect(p.isSeparate).toBe(true);
  });
});
