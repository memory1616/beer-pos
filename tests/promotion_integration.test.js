/**
 * Integration test: PromotionService.calculateMonthlyReward() với dữ liệu thật trong DB test.
 * (Chuyển từ script gốc test_integration.js → Jest)
 *
 * Lưu ý: tests/setup.js clone database.sqlite sang DB tạm → DB vận hành không bị ảnh hưởng.
 */
process.env.TZ = 'Asia/Ho_Chi_Minh';

const db = require('../database');
const { PromotionService } = require('../src/services');

const TEST_CUSTOMER_ID = 999999;
const TEST_PRODUCTS = [
  { id: 990001, name: 'Bia Vàng', slug: 'bia-vang', type: 'keg', archived: 0 },
  { id: 990002, name: 'Bia Đen', slug: 'bia-den', type: 'keg', archived: 0 }
];

function setup() {
  db.prepare(`
    INSERT OR REPLACE INTO customers (id, name, phone, created_at, promotion_enabled, reward_enabled)
    VALUES (?, 'Test Customer Bia Inox', '0909000000', date('now', '-2 months'), 1, 1)
  `).run(TEST_CUSTOMER_ID);

  for (const p of TEST_PRODUCTS) {
    db.prepare(`
      INSERT OR IGNORE INTO products (id, name, slug, type, archived, stock, cost_price)
      VALUES (?, ?, ?, ?, 0, 1000, 1000)
    `).run(p.id, p.name, p.slug, p.type);
  }
}

function cleanup() {
  db.prepare(`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE customer_id = ?)`).run(
    TEST_CUSTOMER_ID
  );
  db.prepare(`DELETE FROM sales WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM customer_monthly_stats WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM reward_history WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM pending_rewards WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM customers WHERE id = ?`).run(TEST_CUSTOMER_ID);
}

function resetMonthlyStats() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  db.prepare(
    'DELETE FROM customer_monthly_stats WHERE customer_id = ? AND year = ? AND month = ?'
  ).run(TEST_CUSTOMER_ID, year, month);
  db.prepare('UPDATE customers SET monthly_purchased_liters = 0 WHERE id = ?').run(TEST_CUSTOMER_ID);
  db.prepare(
    `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE customer_id = ? AND strftime('%Y', date) = ? AND strftime('%m', date) = ?)`
  ).run(TEST_CUSTOMER_ID, String(year), String(month).padStart(2, '0'));
  db.prepare(
    `DELETE FROM sales WHERE customer_id = ? AND strftime('%Y', date) = ? AND strftime('%m', date) = ?`
  ).run(TEST_CUSTOMER_ID, String(year), String(month).padStart(2, '0'));
  db.prepare(`DELETE FROM reward_history WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
  db.prepare(`DELETE FROM pending_rewards WHERE customer_id = ?`).run(TEST_CUSTOMER_ID);
}

function makeSale(yellowLiters, blackLiters) {
  const date = new Date().toISOString().split('T')[0];
  const saleRes = db.prepare(`
    INSERT INTO sales (customer_id, date, total, profit, type, archived)
    VALUES (?, ?, 0, 0, 'sale', 0)
  `).run(TEST_CUSTOMER_ID, date);
  const saleId = saleRes.lastInsertRowid;

  if (yellowLiters > 0) {
    db.prepare(`
      INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit)
      VALUES (?, ?, 'bia-vang', ?, 100, 100, 0)
    `).run(saleId, TEST_PRODUCTS[0].id, yellowLiters);
  }
  if (blackLiters > 0) {
    db.prepare(`
      INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit)
      VALUES (?, ?, 'bia-den', ?, 100, 100, 0)
    `).run(saleId, TEST_PRODUCTS[1].id, blackLiters);
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
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

// [yellow, black, expectedMode, expectedYellow, expectedBlack]
const cases = [
  [0, 0, 'NONE', 0, 0],
  [300, 0, 'YELLOW_ONLY', 20, 0],
  [500, 0, 'YELLOW_ONLY', 40, 0],
  [0, 300, 'BLACK_ONLY', 0, 20],
  [0, 500, 'BLACK_ONLY', 0, 40],
  [200, 100, 'MIXED', 20, 0],
  [250, 250, 'MIXED', 40, 0],
  [300, 300, 'SEPARATE', 20, 20],
  [500, 500, 'SEPARATE', 40, 40],
  [300, 200, 'MIXED', 40, 0],
  [200, 300, 'MIXED', 40, 0],
  [299, 299, 'MIXED', 40, 0]
];

beforeAll(() => {
  cleanup();
  setup();
});

afterAll(() => {
  cleanup();
});

describe('PromotionService.calculateMonthlyReward (integration)', () => {
  test.each(cases)(
    'vàng=%i đen=%i → mode=%s y=%i b=%i',
    (y, b, expMode, expY, expBl) => {
      resetMonthlyStats();
      if (y + b > 0) makeSale(y, b);

      const reward = PromotionService.calculateMonthlyReward(TEST_CUSTOMER_ID);
      expect(reward.mode).toBe(expMode);
      expect(reward.yellowReward || 0).toBe(expY);
      expect(reward.blackReward || 0).toBe(expBl);
    }
  );
});
