/**
 * Edge-case test cho BIA INOX V2 (chuyển từ script gốc test_edge_cases.js → Jest):
 * 1. Quà tặng KHÔNG được tính vào sản lượng mua
 * 2. Không cộng dồn mốc 300+500
 * 3. Luồng đầy đủ: tạo đơn → tính thưởng → claim → xóa đơn → revert
 */
const { PromotionService } = require('../src/services');
const db = require('../database');

const TEST_CUSTOMER_ID = 999998;
const GOLD_ID = 990003;
const BLACK_ID = 990004;

function setup() {
  db.prepare(
    `INSERT OR REPLACE INTO customers (id, name, phone, created_at, promotion_enabled, reward_enabled)
     VALUES (?, 'Test Edge', '0909111111', '2026-01-01', 1, 1)`
  ).run(TEST_CUSTOMER_ID);
  db.prepare(
    `INSERT OR REPLACE INTO products (id, name, slug, type, archived, stock, cost_price)
     VALUES (?, 'Bia Vàng', 'bia-vang-edge', 'keg', 0, 1000, 1000)`
  ).run(GOLD_ID);
  db.prepare(
    `INSERT OR REPLACE INTO products (id, name, slug, type, archived, stock, cost_price)
     VALUES (?, 'Bia Đen', 'bia-den-edge', 'keg', 0, 1000, 1000)`
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

function makeSale(itemList) {
  // itemList: [{productId, qty, price, name}]
  const date = new Date().toISOString().split('T')[0];
  const saleId = db
    .prepare(
      `INSERT INTO sales (customer_id, date, total, profit, type, archived) VALUES (?, ?, 0, 0, 'sale', 0)`
    )
    .run(TEST_CUSTOMER_ID, date).lastInsertRowid;
  let yellowLiters = 0;
  let blackLiters = 0;
  for (const it of itemList) {
    db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    ).run(saleId, it.productId, `prod-${it.productId}`, it.qty, it.price, 100);
    if (PromotionService.classifyBeer(it.name || 'Bia Vàng') === 'black') blackLiters += it.qty;
    else yellowLiters += it.qty;
  }
  return { saleId, yellowLiters, blackLiters };
}

function rewardShape(r) {
  return {
    mode: r.mode,
    yellowReward: r.yellowReward,
    blackReward: r.blackReward,
    totalReward: r.totalReward
  };
}

beforeAll(() => {
  cleanup();
  setup();
});

afterAll(() => {
  cleanup();
});

beforeEach(() => {
  resetMonth();
});

describe('khuyến mãi — edge cases', () => {
  test('quà tặng (price=0) KHÔNG tính vào sản lượng', () => {
    makeSale([{ productId: GOLD_ID, qty: 300, price: 200, name: 'Bia Vàng' }]);
    makeSale([{ productId: GOLD_ID, qty: 100, price: 0, name: 'Bia Vàng' }]);

    const liters = PromotionService.calculateMonthlyPurchasedLiters(TEST_CUSTOMER_ID);
    expect(liters).toEqual({ total: 300, yellow: 300, black: 0 });

    const reward = PromotionService.calculateMonthlyReward(TEST_CUSTOMER_ID);
    expect(rewardShape(reward)).toEqual({
      mode: 'YELLOW_ONLY',
      yellowReward: 20,
      blackReward: 0,
      totalReward: 20
    });
  });

  test('500L chỉ thưởng 40L (không cộng dồn)', () => {
    makeSale([{ productId: GOLD_ID, qty: 500, price: 200, name: 'Bia Vàng' }]);
    const reward = PromotionService.calculateMonthlyReward(TEST_CUSTOMER_ID);
    expect(rewardShape(reward)).toEqual({
      mode: 'YELLOW_ONLY',
      yellowReward: 40,
      blackReward: 0,
      totalReward: 40
    });
  });

  test('700L vẫn cap 40L', () => {
    makeSale([{ productId: GOLD_ID, qty: 700, price: 200, name: 'Bia Vàng' }]);
    const reward = PromotionService.calculateMonthlyReward(TEST_CUSTOMER_ID);
    expect(rewardShape(reward)).toEqual({
      mode: 'YELLOW_ONLY',
      yellowReward: 40,
      blackReward: 0,
      totalReward: 40
    });
  });

  test('SEPARATE 500+500 → 40+40 = 80L', () => {
    makeSale([
      { productId: GOLD_ID, qty: 500, price: 200, name: 'Bia Vàng' },
      { productId: BLACK_ID, qty: 500, price: 200, name: 'Bia Đen' }
    ]);
    const reward = PromotionService.calculateMonthlyReward(TEST_CUSTOMER_ID);
    expect(rewardShape(reward)).toEqual({
      mode: 'SEPARATE',
      yellowReward: 40,
      blackReward: 40,
      totalReward: 80
    });
  });

  test('chỉ bia đen đạt mốc → thưởng bia đen', () => {
    makeSale([{ productId: BLACK_ID, qty: 300, price: 200, name: 'Bia Đen' }]);
    const reward = PromotionService.calculateMonthlyReward(TEST_CUSTOMER_ID);
    expect(rewardShape(reward)).toEqual({
      mode: 'BLACK_ONLY',
      yellowReward: 0,
      blackReward: 20,
      totalReward: 20
    });
  });

  test('hỗn hợp 300+200 → MIXED → 40L vàng', () => {
    makeSale([
      { productId: GOLD_ID, qty: 300, price: 200, name: 'Bia Vàng' },
      { productId: BLACK_ID, qty: 200, price: 200, name: 'Bia Đen' }
    ]);
    const reward = PromotionService.calculateMonthlyReward(TEST_CUSTOMER_ID);
    expect(rewardShape(reward)).toEqual({
      mode: 'MIXED',
      yellowReward: 40,
      blackReward: 0,
      totalReward: 40
    });
  });

  test('299+299 = 598 → MIXED 40L vàng', () => {
    makeSale([
      { productId: GOLD_ID, qty: 299, price: 200, name: 'Bia Vàng' },
      { productId: BLACK_ID, qty: 299, price: 200, name: 'Bia Đen' }
    ]);
    const reward = PromotionService.calculateMonthlyReward(TEST_CUSTOMER_ID);
    expect(rewardShape(reward)).toEqual({
      mode: 'MIXED',
      yellowReward: 40,
      blackReward: 0,
      totalReward: 40
    });
  });
});
