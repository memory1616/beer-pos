/**
 * Full-flow test (chuyển từ script gốc test_full_flow.js → Jest):
 * 1. Tạo đơn đạt tier
 * 2. Auto claim reward → attach vào sale
 * 3. Verify sale_items có 2 rows (vàng + đen) nếu SEPARATE
 * 4. Soft-delete sale → verify revert đúng
 */
const { PromotionService } = require('../src/services');
const { deleteSaleRestoringInventory } = require('../src/services/saleDelete');
const db = require('../database');

const TEST_CUSTOMER_ID = 999997;
const GOLD_ID = 990005;
const BLACK_ID = 990006;

function setup() {
  db.prepare(
    `INSERT OR REPLACE INTO customers (id, name, phone, created_at, promotion_enabled, reward_enabled)
     VALUES (?, 'Test Flow', '0909222222', '2026-01-01', 1, 1)`
  ).run(TEST_CUSTOMER_ID);
  db.prepare(
    `INSERT OR REPLACE INTO products (id, name, slug, type, archived, stock, cost_price)
     VALUES (?, 'Bia Vàng', 'bia-vang-flow', 'keg', 0, 1000, 1000)`
  ).run(GOLD_ID);
  db.prepare(
    `INSERT OR REPLACE INTO products (id, name, slug, type, archived, stock, cost_price)
     VALUES (?, 'Bia Đen', 'bia-den-flow', 'keg', 0, 1000, 1000)`
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

function resetMonth() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  db.prepare(
    `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE customer_id = ? AND strftime('%Y', date) = ? AND strftime('%m', date) = ?)`
  ).run(TEST_CUSTOMER_ID, String(year), String(month).padStart(2, '0'));
  db.prepare(
    `DELETE FROM sales WHERE customer_id = ? AND strftime('%Y', date) = ? AND strftime('%m', date) = ?`
  ).run(TEST_CUSTOMER_ID, String(year), String(month).padStart(2, '0'));
  db.prepare(
    `DELETE FROM customer_monthly_stats WHERE customer_id = ? AND year = ? AND month = ?`
  ).run(TEST_CUSTOMER_ID, year, month);
  db.prepare(
    `UPDATE customers SET monthly_purchased_liters = 0, reward_claimed = 0, reward_claimed_at = NULL WHERE id = ?`
  ).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM reward_history WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM pending_rewards WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
}

function makeSale(yellowLiters, blackLiters, dates) {
  const date = dates || new Date().toISOString().split('T')[0];
  const saleId = db
    .prepare(
      `INSERT INTO sales (customer_id, date, total, profit, type, archived) VALUES (?, ?, 0, 0, 'sale', 0)`
    )
    .run(TEST_CUSTOMER_ID, date).lastInsertRowid;
  if (yellowLiters > 0) {
    db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit)
       VALUES (?, ?, 'bia-vang-flow', ?, 200, 100, 0)`
    ).run(saleId, GOLD_ID, yellowLiters);
  }
  if (blackLiters > 0) {
    db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit)
       VALUES (?, ?, 'bia-den-flow', ?, 200, 100, 0)`
    ).run(saleId, BLACK_ID, blackLiters);
  }
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  PromotionService.updateCustomerMonthlyStats(
    TEST_CUSTOMER_ID,
    yellowLiters + blackLiters,
    year,
    month,
    yellowLiters,
    blackLiters
  );
  db.prepare(
    'UPDATE customers SET monthly_purchased_liters = monthly_purchased_liters + ? WHERE id = ?'
  ).run(yellowLiters + blackLiters, TEST_CUSTOMER_ID);
  return saleId;
}

beforeAll(() => {
  cleanup();
  setup();
});

afterAll(() => {
  cleanup();
});

describe('luồng đầy đủ — attach reward + soft-delete revert', () => {
  let currentSaleId;

  test('500 vàng + 500 đen → SEPARATE → attach 2 reward rows vào sale', () => {
    resetMonth();

    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const lastMonthStr = lastMonth.toISOString().split('T')[0];
    makeSale(500, 500, lastMonthStr);

    const reward = PromotionService.getRewardForPrevMonth(TEST_CUSTOMER_ID);
    expect({
      eligible: reward.eligible,
      yellowReward: reward.yellowReward,
      blackReward: reward.blackReward,
      totalReward: reward.rewardLiters,
      mode: reward.mode
    }).toEqual({
      eligible: true,
      yellowReward: 40,
      blackReward: 40,
      totalReward: 80,
      mode: 'SEPARATE'
    });

    currentSaleId = makeSale(50, 0); // chỉ mua 50L, không đạt tier mới
    const result = PromotionService.attachRewardToSale(
      TEST_CUSTOMER_ID,
      currentSaleId,
      reward.rewardLiters,
      reward.tier,
      reward.rewardMonth,
      reward.rewardYear,
      reward.yellowReward,
      reward.blackReward
    );
    expect(result.success).toBe(true);
    expect(result.yellowReward).toBe(40);
    expect(result.blackReward).toBe(40);

    const saleItems = db
      .prepare(`SELECT product_id, quantity, price FROM sale_items WHERE sale_id = ? ORDER BY product_id`)
      .all(currentSaleId);
    const paidRow = saleItems.find(r => r.price > 0);
    const rewardRows = saleItems.filter(r => r.price === 0);
    expect(paidRow ? paidRow.quantity : 0).toBe(50);
    expect(rewardRows.length).toBe(2);
    expect(rewardRows.reduce((s, r) => s + r.quantity, 0)).toBe(80);

    const lastReward = db
      .prepare(
        `SELECT reward_yellow_liters, reward_black_liters, reward_liters
         FROM reward_history WHERE customer_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(TEST_CUSTOMER_ID);
    expect({
      yellow: lastReward.reward_yellow_liters,
      black: lastReward.reward_black_liters,
      total: lastReward.reward_liters
    }).toEqual({ yellow: 40, black: 40, total: 80 });

    const lastMonthForStats = new Date();
    lastMonthForStats.setMonth(lastMonthForStats.getMonth() - 1);
    const statsRow = db
      .prepare(
        `SELECT reward_claimed_liters FROM customer_monthly_stats WHERE customer_id = ? AND year = ? AND month = ?`
      )
      .get(
        TEST_CUSTOMER_ID,
        lastMonthForStats.getFullYear(),
        lastMonthForStats.getMonth() + 1
      );
    expect(statsRow ? statsRow.reward_claimed_liters : 0).toBe(80);
  });

  test('soft-delete sale → revert stats + xóa reward_history', () => {
    const deleteResult = deleteSaleRestoringInventory(currentSaleId);
    expect(deleteResult.ok).toBe(true);

    const currentLiters = db
      .prepare(`SELECT monthly_purchased_liters FROM customers WHERE id = ?`)
      .get(TEST_CUSTOMER_ID);
    expect(currentLiters.monthly_purchased_liters).toBe(1000);

    const remainingHistory = db
      .prepare(`SELECT COUNT(*) as cnt FROM reward_history WHERE customer_id = ?`)
      .get(TEST_CUSTOMER_ID);
    expect(remainingHistory.cnt).toBe(0);

    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const statsAfter = db
      .prepare(
        `SELECT reward_claimed, reward_claimed_liters FROM customer_monthly_stats
         WHERE customer_id = ? AND year = ? AND month = ?`
      )
      .get(TEST_CUSTOMER_ID, lastMonth.getFullYear(), lastMonth.getMonth() + 1);
    expect(statsAfter ? statsAfter.reward_claimed : -1).toBe(0);
  });
});
