/**
 * promotionCalc.js — SINGLE SOURCE OF TRUTH cho logic khuyến mãi bia inox
 *
 * Mục đích: Gom toàn bộ logic tính thưởng theo sản lượng bia vàng/đen vào 1 module duy nhất.
 * Backend và Frontend đều dùng function `calculatePromotion()` trong file này.
 *
 * QUY TẮC (đã chốt với user):
 *   - 2 loại sản lượng: yellowVolume (bia vàng), blackVolume (bia đen)
 *   - totalVolume = yellowVolume + blackVolume
 *   - 2 mốc: 300L → 20L, 500L → 40L (không cộng dồn)
 *
 *   TRƯỜNG HỢP A — Chỉ mua bia vàng (yellowVolume > 0 && blackVolume <= 0):
 *     - yellowVolume < 300           → không thưởng
 *     - 300 ≤ yellowVolume < 500    → 20L vàng
 *     - yellowVolume ≥ 500          → 40L vàng
 *
 *   TRƯỜNG HỢP B — Chỉ mua bia đen (blackVolume > 0 && yellowVolume <= 0):
 *     - blackVolume < 300           → không thưởng
 *     - 300 ≤ blackVolume < 500     → 20L đen
 *     - blackVolume ≥ 500           → 40L đen
 *     ⇒ Phần thưởng là BIA ĐEN (không phải bia vàng như logic cũ)
 *
 *   TRƯỜNG HỢP C1 — Mua cả 2 loại, cả 2 đều ≥ 300L:
 *     ⇒ Tách riêng theo từng loại (SEPARATE):
 *       - Bia vàng: 300 ≤ <500 → 20L vàng; ≥ 500 → 40L vàng
 *       - Bia đen:  300 ≤ <500 → 20L đen;  ≥ 500 → 40L đen
 *
 *   TRƯỜNG HỢP C2 — Mua cả 2 loại nhưng KHÔNG cùng ≥ 300L:
 *     ⇒ Tách riêng từng loại trước (loại đạt mốc thì thưởng theo loại đó):
 *       - Bia vàng: ≥ 300 → 20L vàng; ≥ 500 → 40L vàng
 *       - Bia đen:  ≥ 300 → 20L đen;  ≥ 500 → 40L đen
 *     ⇒ Nếu cả 2 đều < 300L → cộng tổng hỗn hợp, thưởng BIA VÀNG:
 *       - total < 300          → không thưởng
 *       - 300 ≤ total < 500    → 20L vàng
 *       - total ≥ 500          → 40L vàng
 *
 * KHÔNG TÍNH QUÀ TẶNG VÀO SẢN LƯỢNG MUA.
 *
 * Module này là pure (không phụ thuộc DB), để có thể import từ bất kỳ đâu:
 *   - Backend: routes/api/promotions.js, PromotionService, routes/reportData.js, routes/dashboard.js
 *   - Frontend: copy y nguyên function này (có thể dùng shared module qua build).
 */

// ────────────────────────────────────────────────────────────
// CONSTANTS
// ────────────────────────────────────────────────────────────

const TIER_THRESHOLDS = [300, 500];
const TIER_REWARDS = { 300: 20, 500: 40 };

const REWARD_MODES = {
  NONE: 'NONE',
  YELLOW_ONLY: 'YELLOW_ONLY',
  BLACK_ONLY: 'BLACK_ONLY',
  SEPARATE: 'SEPARATE',
  MIXED: 'MIXED'
};

/**
 * Tính mức thưởng 1 loại bia theo sản lượng đơn lẻ.
 * @param {number} volume - Sản lượng (yellow hoặc black)
 * @returns {number} 0, 20, hoặc 40
 */
function tierReward(volume) {
  if (volume >= 500) return TIER_REWARDS[500];
  if (volume >= 300) return TIER_REWARDS[300];
  return 0;
}

/**
 * Hàm tính khuyến mãi CHÍNH - Single Source of Truth.
 *
 * @param {number} yellowVolume - Tổng lít bia vàng mua hợp lệ (đã loại bỏ quà tặng)
 * @param {number} blackVolume - Tổng lít bia đen mua hợp lệ (đã loại bỏ quà tặng)
 * @returns {{
 *   mode: 'NONE'|'YELLOW_ONLY'|'BLACK_ONLY'|'SEPARATE'|'MIXED',
 *   yellowReward: number,
 *   blackReward: number,
 *   totalReward: number
 * }}
 */
function calculatePromotion(yellowVolume, blackVolume) {
  const y = Math.max(0, Number(yellowVolume) || 0);
  const b = Math.max(0, Number(blackVolume) || 0);
  const total = y + b;

  // Không có sản lượng
  if (y <= 0 && b <= 0) {
    return { mode: REWARD_MODES.NONE, yellowReward: 0, blackReward: 0, totalReward: 0 };
  }

  // TRƯỜNG HỢP A — Chỉ bia vàng
  if (y > 0 && b <= 0) {
    const yReward = tierReward(y);
    return {
      mode: REWARD_MODES.YELLOW_ONLY,
      yellowReward: yReward,
      blackReward: 0,
      totalReward: yReward
    };
  }

  // TRƯỜNG HỢP B — Chỉ bia đen
  if (b > 0 && y <= 0) {
    const bReward = tierReward(b);
    return {
      mode: REWARD_MODES.BLACK_ONLY,
      yellowReward: 0,
      blackReward: bReward,
      totalReward: bReward
    };
  }

  // CÓ MUA CẢ HAI (y > 0 && b > 0)
  // C1 — Cả 2 đều ≥ 300L → tách riêng từng loại
  if (y >= 300 && b >= 300) {
    const yReward = tierReward(y);
    const bReward = tierReward(b);
    return {
      mode: REWARD_MODES.SEPARATE,
      yellowReward: yReward,
      blackReward: bReward,
      totalReward: yReward + bReward
    };
  }

  // C2 — Mua cả 2 nhưng không cùng ≥ 300L
  // Bước 1: Tách riêng từng loại
  // Bước 2: Nếu một loại đạt 300→20, kiểm tra thêm tổng hỗn hợp:
  //         - Nếu tổng ≥ 500 và CHỈ 1 loại đạt → thưởng 40L VÀNG (tiết kiệm hơn)
  //         - Nếu tổng 300-500 → giữ nguyên 20L theo loại đạt
  // Bước 3: Nếu cả 2 đều < 300L → dùng tổng hỗn hợp, thưởng bia vàng
  let yReward = tierReward(y);
  let bReward = tierReward(b);
  if (yReward > 0 || bReward > 0) {
    // Có ít nhất 1 loại đạt 300L. Kiểm tra tổng để quyết định tier.
    if (total >= 500) {
      // Tổng đạt mốc 500 → thưởng 40L VÀNG (chỉ 1 loại đạt, loại kia < 300)
      // Vì chỉ tách riêng khi cả 2 đều ≥ 300 (đã loại ở SEPARATE), nên ở đây
      // chỉ có nhiều nhất 1 loại đạt mốc. Thưởng 40L vàng tiết kiệm hơn 40L đen.
      yReward = TIER_REWARDS[500];
      bReward = 0;
    }
    return {
      mode: REWARD_MODES.MIXED,
      yellowReward: yReward,
      blackReward: bReward,
      totalReward: yReward + bReward
    };
  }
  // Cả 2 đều < 300L → tính tổng, thưởng vàng
  const totalReward = tierReward(total);
  return {
    mode: REWARD_MODES.MIXED,
    yellowReward: totalReward,
    blackReward: 0,
    totalReward
  };
}

/**
 * Tính tier tiếp theo cho mục đích hiển thị progress.
 *
 * @param {number} yellowVolume
 * @param {number} blackVolume
 * @returns {{ nextThreshold: number|null, litersToNext: number, isSeparate: boolean, isMixed: boolean }}
 */
function getNextTierProgress(yellowVolume, blackVolume) {
  const y = Math.max(0, Number(yellowVolume) || 0);
  const b = Math.max(0, Number(blackVolume) || 0);
  const total = y + b;

  // Nếu cả 2 ≥ 300 (SEPARATE branch đã active), tier tiếp theo là 500 (nếu chưa đạt)
  if (y > 0 && b > 0 && y >= 300 && b >= 300) {
    const yTier = tierReward(y);
    const bTier = tierReward(b);
    // Nếu cả 2 đều đạt 40L rồi → next = null
    if (yTier >= 40 && bTier >= 40) {
      return { nextThreshold: null, litersToNext: 0, isSeparate: true, isMixed: false };
    }
    // Nếu vàng < 500 → next 500 vàng
    if (yTier < 40) {
      return { nextThreshold: 500, litersToNext: Math.max(0, 500 - y), isSeparate: true, isMixed: false };
    }
    // Nếu đen < 500 → next 500 đen
    if (bTier < 40) {
      return { nextThreshold: 500, litersToNext: Math.max(0, 500 - b), isSeparate: true, isMixed: false };
    }
    return { nextThreshold: null, litersToNext: 0, isSeparate: true, isMixed: false };
  }

  // Nếu SEPARATE chưa active (chỉ 1 loại ≥ 300, hoặc cả 2 nhỏ hơn 300)
  // → tier tiếp theo dựa trên tổng (MIXED/YELLOW_ONLY/BLACK_ONLY)
  if (total < 300) {
    return { nextThreshold: 300, litersToNext: 300 - total, isSeparate: false, isMixed: total > 0 };
  }
  if (total < 500) {
    return { nextThreshold: 500, litersToNext: 500 - total, isSeparate: false, isMixed: true };
  }
  return { nextThreshold: null, litersToNext: 0, isSeparate: false, isMixed: true };
}

/**
 * Format label mô tả thưởng (cho UI/invoice).
 * @param {{ yellowReward: number, blackReward: number, mode: string }} calcResult
 * @returns {string} "Không thưởng" | "20L Bia Vàng" | "20L Bia Đen" | "20L Bia Vàng + 20L Bia Đen" | "40L Bia Vàng" | ...
 */
function formatRewardLabel(calcResult) {
  if (!calcResult) return 'Không thưởng';
  const { yellowReward, blackReward, mode } = calcResult;
  if (yellowReward === 0 && blackReward === 0) return 'Không thưởng';

  const parts = [];
  if (yellowReward > 0) parts.push(`${yellowReward}L Bia Vàng`);
  if (blackReward > 0) parts.push(`${blackReward}L Bia Đen`);
  return parts.join(' + ');
}

// ────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────

module.exports = {
  calculatePromotion,
  getNextTierProgress,
  formatRewardLabel,
  tierReward,
  TIER_THRESHOLDS,
  TIER_REWARDS,
  REWARD_MODES
};