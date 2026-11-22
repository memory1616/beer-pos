/**
 * KM QUÁN MỚI — phân biệt nguồn thưởng NEW_SHOP_BONUS vs MONTHLY_BONUS
 * ─────────────────────────────────────────────────────────────────────────────
 * QUY TẮC (2026-11-22):
 *   - Thưởng "10 tặng 1" của THÁNG MỞ QUÁN → sale.promo_type = 'NEW_SHOP_BONUS'
 *   - Thưởng doanh số (tier 300L→20L, 500L→40L) → sale.promo_type = 'MONTHLY_BONUS'
 *   - sale_items.reward_source tương ứng
 *   - reward_history.reward_tier = 'NEW_SHOP_XL' (lọc được bằng NOT LIKE 'NEW_SHOP%')
 *
 * Mục đích: để báo cáo "Lít tặng tháng" (NEW_SHOP) tách khỏi thưởng doanh số,
 * và để đơn quán mới không bị nhầm là đơn thưởng doanh số khi xóa/sửa.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

describe('KM quán mới — nguồn thưởng NEW_SHOP_BONUS', () => {
  let serviceSrc;
  let salesRouteSrc;
  let deleteServiceSrc;

  beforeAll(() => {
    serviceSrc = fs.readFileSync(path.join(ROOT, 'src/services/index.js'), 'utf8');
    salesRouteSrc = fs.readFileSync(path.join(ROOT, 'routes/api/sales.js'), 'utf8');
    deleteServiceSrc = fs.readFileSync(path.join(ROOT, 'src/services/saleDelete.js'), 'utf8');
  });

  test('service có hằng số NEW_SHOP_BONUS và phân biệt promo_type', () => {
    expect(serviceSrc).toContain("'NEW_SHOP_BONUS'");
    expect(serviceSrc).toContain("rewardSource === 'NEW_SHOP_BONUS' ? 'NEW_SHOP_BONUS' : 'MONTHLY_BONUS'");
  });

  test('route sales truyền NEW_SHOP_BONUS khi gắn thưởng quán mới', () => {
    expect(salesRouteSrc).toContain("'NEW_SHOP_BONUS'");
    // Trong nhánh NEW_CUSTOMER của auto-reward
    const newCustomerIdx = salesRouteSrc.indexOf("program === 'NEW_CUSTOMER'");
    expect(newCustomerIdx).toBeGreaterThan(-1);
    const block = salesRouteSrc.slice(newCustomerIdx, newCustomerIdx + 2000);
    expect(block).toContain("'NEW_SHOP_BONUS'");
  });

  test('chặn sửa đơn nhận diện NEW_SHOP_BONUS', () => {
    expect(salesRouteSrc).toContain("currentSale.promo_type === 'NEW_SHOP_BONUS'");
  });

  test('xóa đơn revert thưởng nhận diện NEW_SHOP_BONUS', () => {
    expect(deleteServiceSrc).toContain("sale.promo_type === 'NEW_SHOP_BONUS'");
  });

  test('note thưởng quán mới khớp regex nhận diện', () => {
    // note ghi: "Trả Thưởng quán mới tháng X/Y"
    expect(serviceSrc).toContain("'Thưởng quán mới'");
    // Regex phải match được cả 2 dạng
    const rx = /Trả\s+(thưởng sản lượng|Thưởng quán mới)\s+tháng\s+\d+\/\d+/i;
    expect(rx.test('Trả Thưởng quán mới tháng 11/2026')).toBe(true);
    expect(rx.test('Trả thưởng sản lượng tháng 11/2026')).toBe(true);
    expect(rx.test('Trả Thưởng quán mới tháng 12/2026 - (2L vàng)')).toBe(true);
    expect(rx.test('Không liên quan')).toBe(false);
  });

  test('báo cáo lọc reward_tier NEW_SHOP (không lẫn vào thưởng doanh số)', () => {
    const reportSrc = fs.readFileSync(path.join(ROOT, 'routes/reportData.js'), 'utf8');
    expect(reportSrc).toContain("reward_tier NOT LIKE 'NEW_SHOP%'");
  });

  test('tier thưởng quán mới có tiền tố NEW_SHOP_', () => {
    expect(serviceSrc).toContain('`NEW_SHOP_${newShopCalc.totalReward}L`');
  });
});
