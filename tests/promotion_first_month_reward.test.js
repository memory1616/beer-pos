/**
 * Test FIRST MONTH REWARD FLOW (chuyển từ script gốc test_first_month_reward.js → Jest):
 *
 * Scenario 1: Khách đạt tier 300L tháng trước → đơn ĐẦU TIÊN tháng này phải auto-attach thưởng
 * Scenario 2: Đơn thứ 2 trở đi KHÔNG được attach lại (đã nhận rồi)
 * Scenario 3: Đạt tier 500L → 40L
 * Scenario 4: Khách chưa đạt tier → không có reward
 * Scenario 5: SEPARATE mode (cả vàng + đen ≥ 300) → 2 rows trong sale_items
 * Scenario 6: MIXED mode (chỉ 1 loại ≥ 300) → 1 row bia vàng
 * Scenario 7: Bảo vệ chống gắn thưởng 2 lần cùng tháng
 * Scenario 8: Mua trong tháng hiện tại chưa tính thưởng
 */
const { PromotionService } = require('../src/services');
const db = require('../database');

const TEST_CUSTOMER_ID = 999996;
const GOLD_ID = 990007;
const BLACK_ID = 990008;

function setup() {
  cleanup();
  db.prepare(
    `INSERT INTO customers (id, name, phone, created_at, promotion_enabled, reward_enabled)
     VALUES (?, 'Test First Month', '0909111222', '2026-01-01', 1, 1)`
  ).run(TEST_CUSTOMER_ID);
  db.prepare(
    `INSERT OR REPLACE INTO products (id, name, slug, type, archived, stock, cost_price)
     VALUES (?, 'Bia Vàng', 'bia-vang-first', 'keg', 0, 10000, 1000)`
  ).run(GOLD_ID);
  db.prepare(
    `INSERT OR REPLACE INTO products (id, name, slug, type, archived, stock, cost_price)
     VALUES (?, 'Bia Đen', 'bia-den-first', 'keg', 0, 10000, 1000)`
  ).run(BLACK_ID);
}

function cleanup() {
  db.prepare(
    `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE customer_id = ?)`
  ).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM sales WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM customer_monthly_stats WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM reward_history WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM pending_rewards WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM customers WHERE id = ?`).run(TEST_CUSTOMER_ID);
}

function resetRewardState() {
  db.prepare(
    `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE customer_id = ?)`
  ).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM sales WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM customer_monthly_stats WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM reward_history WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM pending_rewards WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
  db.prepare(
    `UPDATE customers SET monthly_purchased_liters = 0, reward_claimed = 0, reward_claimed_at = NULL WHERE id = ?`
  ).run(TEST_CUSTOMER_ID);
}

function getLastMonthDates() {
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const year = prevMonth.getFullYear();
  const month = prevMonth.getMonth() + 1;
  const lastDay = new Date(year, month, 0).getDate();
  return {
    year,
    month,
    startDate: `${year}-${String(month).padStart(2, '0')}-01`,
    endDate: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    thisMonth: now.getMonth() + 1,
    thisYear: now.getFullYear()
  };
}

function makeSaleInMonth(customerId, yellowLiters, blackLiters, year, month, day = 15) {
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const saleId = db
    .prepare(
      `INSERT INTO sales (customer_id, date, total, profit, type, archived) VALUES (?, ?, 0, 0, 'sale', 0)`
    )
    .run(customerId, date).lastInsertRowid;
  if (yellowLiters > 0) {
    db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit)
       VALUES (?, ?, 'bia-vang-first', ?, 200, 100, 0)`
    ).run(saleId, GOLD_ID, yellowLiters);
  }
  if (blackLiters > 0) {
    db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit)
       VALUES (?, ?, 'bia-den-first', ?, 200, 100, 0)`
    ).run(saleId, BLACK_ID, blackLiters);
  }
  PromotionService.updateCustomerMonthlyStats(
    customerId,
    yellowLiters + blackLiters,
    year,
    month,
    yellowLiters,
    blackLiters
  );
  return saleId;
}

function getRealGoldProductId() {
  return db
    .prepare(
      `SELECT id FROM products WHERE archived=0 AND type='keg' AND name LIKE '%Vàng%' AND name NOT LIKE '%Đen%' ORDER BY id ASC LIMIT 1`
    )
    .get()?.id;
}

function getRealBlackProductId() {
  return db
    .prepare(
      `SELECT id FROM products WHERE archived=0 AND type='keg'
       AND (name LIKE '%Đen%' OR name LIKE '%Guinness%' OR name LIKE '%Kilkenny%'
            OR name LIKE '%Murphy%' OR name LIKE '%Smithwick%')
       ORDER BY id ASC LIMIT 1`
    )
    .get()?.id;
}

beforeAll(() => {
  setup();
});

afterAll(() => {
  cleanup();
});

describe('luồng thưởng tháng đầu', () => {
  test('Scenario 1: đạt tier tháng trước → đơn đầu tiên tháng này auto-attach reward', () => {
    resetRewardState();
    const REAL_GOLD_ID = getRealGoldProductId();
    const dates = getLastMonthDates();
    const { thisMonth, thisYear } = dates;

    makeSaleInMonth(TEST_CUSTOMER_ID, 320, 0, dates.year, dates.month, 10);

    const rewardInfo = PromotionService.getRewardForPrevMonth(TEST_CUSTOMER_ID);
    expect(rewardInfo.eligible).toBe(true);
    expect(rewardInfo.rewardLiters).toBe(20);
    expect(rewardInfo.yellowReward).toBe(20);
    expect(rewardInfo.blackReward).toBe(0);
    expect(rewardInfo.rewardMonth).toBe(dates.month);

    const firstSaleId = makeSaleInMonth(TEST_CUSTOMER_ID, 50, 0, thisYear, thisMonth, 2);
    const attachResult = PromotionService.attachRewardToSale(
      TEST_CUSTOMER_ID,
      firstSaleId,
      rewardInfo.rewardLiters,
      rewardInfo.tier,
      rewardInfo.rewardMonth,
      rewardInfo.rewardYear,
      rewardInfo.yellowReward,
      rewardInfo.blackReward
    );
    expect(attachResult.success).toBe(true);

    const items = db
      .prepare(`SELECT product_id, quantity, price FROM sale_items WHERE sale_id = ?`)
      .all(firstSaleId);
    const rewardItem = items.find(i => i.quantity === 20 && i.price === 0);
    expect(rewardItem).toBeTruthy();
    expect(rewardItem.product_id).toBe(REAL_GOLD_ID);

    const history = db
      .prepare(`SELECT * FROM reward_history WHERE customer_id = ? AND note LIKE ?`)
      .all(TEST_CUSTOMER_ID, `%tháng ${dates.month}/${dates.year}%`);
    expect(history.length).toBe(1);
    expect(history[0].reward_liters).toBe(20);
    expect(history[0].reward_yellow_liters).toBe(20);

    const stats = db
      .prepare(`SELECT * FROM customer_monthly_stats WHERE customer_id = ? AND year = ? AND month = ?`)
      .get(TEST_CUSTOMER_ID, dates.year, dates.month);
    expect(stats).toBeTruthy();
    expect(stats.reward_claimed).toBe(1);
    expect(stats.reward_claimed_liters).toBe(20);

    // Đơn thứ 2 trong tháng → KHÔNG được attach lại
    const secondSaleId = makeSaleInMonth(TEST_CUSTOMER_ID, 30, 0, thisYear, thisMonth, 5);
    const rewardInfo2 = PromotionService.getRewardForPrevMonth(TEST_CUSTOMER_ID);
    expect(rewardInfo2.eligible).toBe(false);
    expect(rewardInfo2.alreadyClaimed).toBe(true);

    const items2 = db
      .prepare(`SELECT product_id, quantity, price FROM sale_items WHERE sale_id = ?`)
      .all(secondSaleId);
    expect(items2.find(i => i.price === 0)).toBeFalsy();

    const historyAll = db
      .prepare(`SELECT * FROM reward_history WHERE customer_id = ?`)
      .all(TEST_CUSTOMER_ID);
    expect(historyAll.length).toBe(1);
  });

  test('Scenario 2: đạt tier 500L → 40L', () => {
    resetRewardState();
    const dates = getLastMonthDates();
    const { thisMonth, thisYear } = dates;

    makeSaleInMonth(TEST_CUSTOMER_ID, 550, 0, dates.year, dates.month, 10);

    const rewardInfo = PromotionService.getRewardForPrevMonth(TEST_CUSTOMER_ID);
    expect(rewardInfo.eligible).toBe(true);
    expect(rewardInfo.rewardLiters).toBe(40);
    expect(rewardInfo.yellowReward).toBe(40);

    const saleId = makeSaleInMonth(TEST_CUSTOMER_ID, 50, 0, thisYear, thisMonth, 3);
    PromotionService.attachRewardToSale(
      TEST_CUSTOMER_ID,
      saleId,
      rewardInfo.rewardLiters,
      rewardInfo.tier,
      rewardInfo.rewardMonth,
      rewardInfo.rewardYear,
      rewardInfo.yellowReward,
      rewardInfo.blackReward
    );

    const items = db.prepare(`SELECT * FROM sale_items WHERE sale_id = ?`).all(saleId);
    const reward = items.find(i => i.price === 0);
    expect(reward && reward.quantity).toBe(40);
  });

  test('Scenario 3: chưa đạt tier → không có reward', () => {
    resetRewardState();
    const dates = getLastMonthDates();

    makeSaleInMonth(TEST_CUSTOMER_ID, 200, 0, dates.year, dates.month, 10);

    const rewardInfo = PromotionService.getRewardForPrevMonth(TEST_CUSTOMER_ID);
    expect(rewardInfo.eligible).toBe(false);
    expect(rewardInfo.rewardLiters).toBe(0);
  });

  test('Scenario 4: SEPARATE — vàng ≥ 300 VÀ đen ≥ 300 → tách 2 rows', () => {
    resetRewardState();
    const dates = getLastMonthDates();
    const { thisMonth, thisYear } = dates;
    const REAL_GOLD_ID = getRealGoldProductId();
    const REAL_BLACK_ID = getRealBlackProductId();

    makeSaleInMonth(TEST_CUSTOMER_ID, 320, 320, dates.year, dates.month, 10);

    const rewardInfo = PromotionService.getRewardForPrevMonth(TEST_CUSTOMER_ID);
    expect(rewardInfo.eligible).toBe(true);
    expect(rewardInfo.yellowReward).toBe(20);
    expect(rewardInfo.blackReward).toBe(20);
    expect(rewardInfo.rewardLiters).toBe(40);
    expect(rewardInfo.mode).toBe('SEPARATE');

    const saleId = makeSaleInMonth(TEST_CUSTOMER_ID, 50, 0, thisYear, thisMonth, 3);
    PromotionService.attachRewardToSale(
      TEST_CUSTOMER_ID,
      saleId,
      rewardInfo.rewardLiters,
      rewardInfo.tier,
      rewardInfo.rewardMonth,
      rewardInfo.rewardYear,
      rewardInfo.yellowReward,
      rewardInfo.blackReward
    );

    const items = db
      .prepare(`SELECT * FROM sale_items WHERE sale_id = ? AND price = 0`)
      .all(saleId);
    expect(items.length).toBe(2);
    const goldRow = items.find(i => i.product_id === REAL_GOLD_ID);
    const blackRow = items.find(i => i.product_id === REAL_BLACK_ID);
    expect(goldRow && goldRow.quantity).toBe(20);
    expect(blackRow && blackRow.quantity).toBe(20);
  });

  test('Scenario 5: MIXED — vàng < 300 và đen ≥ 300 → 1 row bia vàng', () => {
    resetRewardState();
    const dates = getLastMonthDates();
    const { thisMonth, thisYear } = dates;
    const REAL_GOLD_ID = getRealGoldProductId();

    makeSaleInMonth(TEST_CUSTOMER_ID, 100, 250, dates.year, dates.month, 10);

    const rewardInfo = PromotionService.getRewardForPrevMonth(TEST_CUSTOMER_ID);
    expect(rewardInfo.eligible).toBe(true);
    expect(rewardInfo.mode).toBe('MIXED');

    const saleId = makeSaleInMonth(TEST_CUSTOMER_ID, 50, 0, thisYear, thisMonth, 3);
    PromotionService.attachRewardToSale(
      TEST_CUSTOMER_ID,
      saleId,
      rewardInfo.rewardLiters,
      rewardInfo.tier,
      rewardInfo.rewardMonth,
      rewardInfo.rewardYear,
      rewardInfo.yellowReward,
      rewardInfo.blackReward
    );

    const items = db
      .prepare(`SELECT * FROM sale_items WHERE sale_id = ? AND price = 0`)
      .all(saleId);
    expect(items.length).toBe(1);
    expect(items[0].product_id).toBe(REAL_GOLD_ID);
    expect(items[0].quantity).toBe(20);
  });

  test('Scenario 6: bảo vệ chống gắn thưởng 2 lần cùng tháng', () => {
    resetRewardState();
    const dates = getLastMonthDates();
    const { thisMonth, thisYear } = dates;

    makeSaleInMonth(TEST_CUSTOMER_ID, 320, 0, dates.year, dates.month, 10);

    const rewardInfo = PromotionService.getRewardForPrevMonth(TEST_CUSTOMER_ID);

    const sale1 = makeSaleInMonth(TEST_CUSTOMER_ID, 50, 0, thisYear, thisMonth, 3);
    const result1 = PromotionService.attachRewardToSale(
      TEST_CUSTOMER_ID,
      sale1,
      rewardInfo.rewardLiters,
      rewardInfo.tier,
      rewardInfo.rewardMonth,
      rewardInfo.rewardYear,
      rewardInfo.yellowReward,
      rewardInfo.blackReward
    );
    expect(result1.success).toBe(true);

    const sale2 = makeSaleInMonth(TEST_CUSTOMER_ID, 50, 0, thisYear, thisMonth, 5);
    const result2 = PromotionService.attachRewardToSale(
      TEST_CUSTOMER_ID,
      sale2,
      rewardInfo.rewardLiters,
      rewardInfo.tier,
      rewardInfo.rewardMonth,
      rewardInfo.rewardYear,
      rewardInfo.yellowReward,
      rewardInfo.blackReward
    );
    expect(result2.success).toBe(false);
    expect(result2.error).toContain('Da co reward history');

    const historyAll = db
      .prepare(`SELECT * FROM reward_history WHERE customer_id = ?`)
      .all(TEST_CUSTOMER_ID);
    expect(historyAll.length).toBe(1);
  });

  test('Scenario 7: mua trong tháng hiện tại chưa tính thưởng', () => {
    resetRewardState();
    const dates = getLastMonthDates();
    const { thisMonth, thisYear } = dates;

    makeSaleInMonth(TEST_CUSTOMER_ID, 500, 0, thisYear, thisMonth, 5);

    const rewardInfo = PromotionService.getRewardForPrevMonth(TEST_CUSTOMER_ID);
    expect(rewardInfo.eligible).toBe(false);
    expect(rewardInfo.rewardLiters).toBe(0);
  });
});
