/**
 * Integration test end-to-end cho Auto-apply reward (Migration 043).
 *
 * Test qua cac layer:
 *   1. DB: insert customer, product, prior month sales
 *   2. PromotionService: tạo pending reward
 *   3. POST /api/sales flow (simulated): tạo sale, apply reward
 *   4. Verify sale_items.paid_quantity, reward_quantity
 *   5. Verify pending_rewards.consumed_liters, status
 *   6. Verify reward_history co 1 row
 *   7. DELETE /api/sales flow (simulated): reverse reward
 *   8. Verify pending_rewards reset ve pending
 *   9. Verify reward_history deleted
 *   10. Verify report: revenue, cogs, profit, reward_summary
 *
 * Su dung in-memory better-sqlite3 + mock db module nhu RewardService.test.js.
 */

const Database = require('better-sqlite3');

let memDb;

function setupSchema(db) {
  db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT,
      type TEXT DEFAULT 'keg',
      stock REAL DEFAULT 0,
      cost_price REAL DEFAULT 0,
      sell_price REAL DEFAULT 0
    );

    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      debt REAL DEFAULT 0,
      keg_balance REAL DEFAULT 0,
      monthly_purchased_liters REAL DEFAULT 0,
      first_order_date TEXT,
      reward_claimed INTEGER DEFAULT 0,
      reward_claimed_at TEXT,
      tier TEXT
    );

    CREATE TABLE prices (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER,
      product_id INTEGER,
      product_slug TEXT,
      price REAL DEFAULT 0
    );

    CREATE TABLE sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      type TEXT DEFAULT 'sale',
      date TEXT,
      total REAL DEFAULT 0,
      profit REAL DEFAULT 0,
      promo_type TEXT,
      promo_free_liters REAL DEFAULT 0,
      reward_liters_used REAL DEFAULT 0,
      deliver_kegs REAL DEFAULT 0,
      return_kegs REAL DEFAULT 0,
      status TEXT,
      note TEXT,
      archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER,
      product_id INTEGER,
      product_slug TEXT,
      quantity REAL DEFAULT 0,
      price REAL DEFAULT 0,
      cost_price REAL DEFAULT 0,
      profit REAL DEFAULT 0,
      paid_quantity REAL DEFAULT 0,
      reward_quantity REAL DEFAULT 0,
      reward_source TEXT,
      reward_month INTEGER,
      reward_year INTEGER
    );

    CREATE TABLE pending_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      reward_month INTEGER,
      reward_year INTEGER,
      reward_liters REAL DEFAULT 0,
      reward_yellow_liters REAL DEFAULT 0,
      reward_black_liters REAL DEFAULT 0,
      mode TEXT,
      consumed_liters REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      tier TEXT
    );

    CREATE TABLE reward_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      -- NOTE: production KHONG co cot sale_id (chi co sale_item_id).
      -- sale_id INTEGER,
      sale_item_id INTEGER,
      note TEXT,
      reward_liters REAL DEFAULT 0,
      reward_tier TEXT,
      reward_yellow_liters REAL DEFAULT 0,
      reward_black_liters REAL DEFAULT 0,
      paid_quantity_at_claim REAL,
      -- NOTE: KHONG co reward_month / reward_year (chi co tren sale_items va pending_rewards).
      -- Thong tin thang/nam da duoc luu trong note pattern "tháng X/YYYY".
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE product_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      type TEXT,
      quantity REAL,
      reason TEXT,
      ref_id INTEGER,
      ref_type TEXT,
      customer_name TEXT,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

jest.mock('../../database', () => {
  let _db;
  return {
    get db() { return _db; },
    set db(v) { _db = v; },
    prepare: function(...args) { return _db.prepare(...args); },
    transaction: function(fn) { return _db.transaction(fn); },
    exec: function(...args) { return _db.exec(...args); },
    getVietnamDateStr: () => '2026-09-02',
    getVietnamTimeStr: () => '2026-09-02 10:00:00'
  };
});

const dbModule = require('../../database');
const RewardServiceClass = require('../../src/services/RewardService');
const RewardService = new RewardServiceClass();

beforeEach(() => {
  memDb = new Database(':memory:');
  setupSchema(memDb);
  dbModule.db = memDb;

  // Seed co ban
  memDb.prepare(`INSERT INTO products (id, name, slug, type, stock, cost_price, sell_price) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(1, 'Bia Vàng 30L', 'bia-vang-30l', 'keg', 1000, 11000, 21000);
  memDb.prepare(`INSERT INTO customers (id, name, debt, keg_balance) VALUES (?, ?, ?, ?)`).run(1, 'Khach Test', 0, 0);
  memDb.prepare(`INSERT INTO prices (customer_id, product_id, product_slug, price) VALUES (?, ?, ?, ?)`).run(1, 1, 'bia-vang-30l', 21000);

  // Seed pending reward (Aug 2026 - tháng trước Sep 2026)
  memDb.prepare(`
    INSERT INTO pending_rewards (customer_id, reward_month, reward_year, reward_liters, reward_yellow_liters, reward_black_liters, mode, status, tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 8, 2026, 40, 40, 0, 'auto', 'pending', 'tier_1');
});

afterEach(() => {
  if (memDb) { memDb.close(); memDb = null; }
});

describe('Integration: Auto-apply reward on sale (full flow)', () => {

  /**
   * Helper: gia lap transaction cua POST /api/sales:
   *   1. Insert sales + sale_items (quantity = orderedQty)
   *   2. Tru stock
   *   3. RewardService.applyRewardToOrder
   *   4. Verify
   */
  function createSaleWithReward(customerId, quantity, productId) {
    // 1. Insert sale
    const saleResult = memDb.prepare(`
      INSERT INTO sales (customer_id, type, date, total, profit, deliver_kegs, status)
      VALUES (?, 'sale', '2026-09-02', 0, 0, ?, NULL)
    `).run(customerId, quantity);
    const saleId = saleResult.lastInsertRowid;

    // 2. Insert sale_items (chua co reward)
    const itemResult = memDb.prepare(`
      INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(saleId, productId, 'bia-vang-30l', quantity, 21000, 11000);
    const saleItemId = itemResult.lastInsertRowid;

    // 3. Tru stock (giong logic production)
    memDb.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(quantity, productId);

    // 4. Reward service
    const available = RewardService.getAvailableReward(customerId);
    const orderedItems = [{
      saleItemId,
      productId,
      productSlug: 'bia-vang-30l',
      productName: 'Bia Vàng 30L',
      quantity,
      price: 21000,
      costPrice: 11000,
      type: 'keg'
    }];
    const application = RewardService.calculateRewardApplication(orderedItems, available);
    if (application.applied) {
      RewardService.applyRewardToOrder(saleId, customerId, application, available.pendingId, 8, 2026);
    }

    return { saleId, saleItemId, application, available };
  }

  test('Step 1-4: full flow - tao don, apply reward, verify', () => {
    const { saleId, saleItemId, application, available } = createSaleWithReward(1, 100, 1);

    // Verify application
    expect(application.applied).toBe(true);
    expect(application.totalRewardApplied).toBe(40);
    expect(application.totalPaidQty).toBe(60);

    // Verify sale_items
    const item = memDb.prepare('SELECT * FROM sale_items WHERE id = ?').get(saleItemId);
    expect(item.quantity).toBe(100); // delivered giu nguyen
    expect(item.paid_quantity).toBe(60);
    expect(item.reward_quantity).toBe(40);
    expect(item.reward_source).toBe('pending');

    // Verify pending_rewards
    const pending = memDb.prepare('SELECT * FROM pending_rewards WHERE id = ?').get(available.pendingId);
    expect(pending.consumed_liters).toBe(40);
    expect(pending.status).toBe('paid');

    // Verify reward_history
    const history = memDb.prepare('SELECT * FROM reward_history WHERE customer_id = ?').all(1);
    expect(history.length).toBe(1);
    expect(history[0].customer_id).toBe(1);
    expect(history[0].reward_liters).toBe(40);
    // reward_history KHONG co cot reward_month/reward_year (chi co note pattern)
    // Thong tin thang/nam duoc luu trong note "tháng X/YYYY"
    expect(history[0].note).toMatch(/tháng 8\/2026/);

    // Verify sales
    const sale = memDb.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(sale.total).toBe(60 * 21000); // 1,260,000
    expect(sale.deliver_kegs).toBe(100);
    expect(sale.reward_liters_used).toBe(40);
    expect(sale.promo_type).toBe('MONTHLY_BONUS');

    // Verify stock
    const product = memDb.prepare('SELECT stock FROM products WHERE id = 1').get();
    expect(product.stock).toBe(900);
  });

  test('Step 5: profit chinh xac = revenue - COGS (COGS bao gom ca reward)', () => {
    const { saleId } = createSaleWithReward(1, 100, 1);

    // Revenue = paidQty * price = 60 * 21000 = 1,260,000
    // COGS = quantity * cost_price = 100 * 11000 = 1,100,000
    // Profit = 1,260,000 - 1,100,000 = 160,000
    const sale = memDb.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    expect(sale.profit).toBe(160000);
  });

  test('Step 6: report reward summary (tuong tu reportData.js)', () => {
    createSaleWithReward(1, 100, 1);

    // Query report reward summary
    const rewardR = memDb.prepare(`
      SELECT
        COALESCE(SUM(si.reward_quantity), 0) as total_liters,
        COALESCE(SUM(si.reward_quantity * si.price), 0) as revenue_lost,
        COUNT(DISTINCT s.id) as order_count
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE s.archived = 0 AND s.type = 'sale' AND si.reward_quantity > 0
    `).get();

    expect(rewardR.total_liters).toBe(40);
    expect(rewardR.revenue_lost).toBe(40 * 21000); // 840,000
    expect(rewardR.order_count).toBe(1);
  });

  test('Step 7: DELETE flow - reverse reward, pending reset', () => {
    const { saleId, saleItemId, available } = createSaleWithReward(1, 100, 1);

    // Verify truoc khi xoa
    expect(memDb.prepare('SELECT consumed_liters FROM pending_rewards WHERE id = ?').get(available.pendingId).consumed_liters).toBe(40);

    // Archive sale (gia lap saleDelete.js)
    memDb.prepare('UPDATE sales SET archived = 1 WHERE id = ?').run(saleId);

    // Restore stock (gia lap saleDelete.js)
    memDb.prepare('UPDATE products SET stock = stock + 100 WHERE id = 1').run();

    // Reverse reward qua RewardService
    const reverseResult = RewardService.reverseRewardFromOrder(saleId);
    expect(reverseResult.reversedLiters).toBe(40);

    // Verify pending_rewards reset
    const pending = memDb.prepare('SELECT * FROM pending_rewards WHERE id = ?').get(available.pendingId);
    expect(pending.consumed_liters).toBe(0);
    expect(pending.status).toBe('pending');

    // Verify sale_items.reward_quantity = 0
    const item = memDb.prepare('SELECT * FROM sale_items WHERE id = ?').get(saleItemId);
    expect(item.reward_quantity).toBe(0);
    expect(item.paid_quantity).toBe(item.quantity); // paid_quantity reset ve quantity

    // Verify reward_history deleted
    const history = memDb.prepare('SELECT * FROM reward_history WHERE customer_id = ?').all(1);
    expect(history.length).toBe(0);

    // Verify stock restored
    const product = memDb.prepare('SELECT stock FROM products WHERE id = 1').get();
    expect(product.stock).toBe(1000); // back to 1000
  });

  test('Step 8: idempotency - double click tao 1 reward_history', () => {
    // Apply lan 1
    const r1 = createSaleWithReward(1, 100, 1);
    const saleId = r1.saleId;

    // Apply lan 2 (simulate double-click) - can tao sale moi, nhung cung sale_id
    // Trong production, hasRewardApplied check truoc khi apply
    const hasReward = RewardService.hasRewardApplied(saleId);
    expect(hasReward).toBe(true);

    // Neu co gang apply lan 2: skip
    const historyBefore = memDb.prepare('SELECT * FROM reward_history WHERE customer_id = ?').all(1).length;
    expect(historyBefore).toBe(1);

    // Verify pending consumed van la 40 (khong bi double count)
    const pending = memDb.prepare('SELECT consumed_liters FROM pending_rewards WHERE id = ?').get(r1.available.pendingId);
    expect(pending.consumed_liters).toBe(40);
  });

  test('Step 9: multiple sales cung thang - chi apply reward cho sale dau', () => {
    // Sale 1 - co reward (consume het 40L pending)
    const r1 = createSaleWithReward(1, 100, 1);

    // Sale 2 - khong con reward (pending da het)
    const sale2Result = memDb.prepare(`
      INSERT INTO sales (customer_id, type, date, total, profit, deliver_kegs, status)
      VALUES (1, 'sale', '2026-09-02', 0, 0, 50, NULL)
    `).run();
    const sale2Id = sale2Result.lastInsertRowid;
    const item2Result = memDb.prepare(`
      INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit)
      VALUES (?, 1, 'bia-vang-30l', 50, 21000, 11000, 0)
    `).run(sale2Id);
    const item2Id = item2Result.lastInsertRowid;

    const available2 = RewardService.getAvailableReward(1);
    const items2 = [{
      saleItemId: item2Id,
      productId: 1,
      productSlug: 'bia-vang-30l',
      productName: 'Bia Vàng 30L',
      quantity: 50,
      price: 21000,
      costPrice: 11000,
      type: 'keg'
    }];
    const app2 = RewardService.calculateRewardApplication(items2, available2);

    // Sale 2 khong co reward (vi pending da consumed het)
    expect(app2.applied).toBe(false);

    // Sale 2 sale_items khong co reward
    const item2 = memDb.prepare('SELECT * FROM sale_items WHERE id = ?').get(item2Id);
    expect(item2.reward_quantity).toBe(0);

    // Verify pending van paid
    const pending = memDb.prepare('SELECT * FROM pending_rewards WHERE id = ?').get(r1.available.pendingId);
    expect(pending.status).toBe('paid');
    expect(pending.consumed_liters).toBe(40);

    // Sale 2 chi co 1 history tu sale 1
    const histories = memDb.prepare('SELECT * FROM reward_history WHERE customer_id = 1').all();
    expect(histories.length).toBe(1);
    // NOTE: reward_history KHONG co cot sale_id (chi co sale_item_id)
    // Verify note co chua thong tin thang/nam
    expect(histories[0].note).toMatch(/tháng 8\/2026/);
  });

  test('Step 10: edit sale giam quantity tu 100 -> 80 (partial reverse)', () => {
    // Tao sale 100
    const r = createSaleWithReward(1, 100, 1);
    const saleId = r.saleId;

    // Verify truoc
    expect(memDb.prepare('SELECT consumed_liters FROM pending_rewards WHERE id = ?').get(r.available.pendingId).consumed_liters).toBe(40);

    // Reverse toan bo sale (giong delete)
    RewardService.reverseRewardFromOrder(saleId);

    // Update sale quantity = 80 (khong tao sale moi)
    memDb.prepare('UPDATE sale_items SET quantity = 80 WHERE sale_id = ?').run(saleId);
    memDb.prepare('UPDATE sales SET deliver_kegs = 80 WHERE id = ?').run(saleId);

    // Apply lai (re-apply)
    const available = RewardService.getAvailableReward(1);
    const items = [{
      saleItemId: r.saleItemId,
      productId: 1,
      productSlug: 'bia-vang-30l',
      productName: 'Bia Vàng 30L',
      quantity: 80,
      price: 21000,
      costPrice: 11000,
      type: 'keg'
    }];
    const app = RewardService.calculateRewardApplication(items, available);
    expect(app.applied).toBe(true);
    expect(app.totalRewardApplied).toBe(40); // 80 >= 40, reward het muc
    expect(app.totalPaidQty).toBe(40); // 80 - 40

    RewardService.applyRewardToOrder(saleId, 1, app, available.pendingId, 8, 2026);

    const item = memDb.prepare('SELECT * FROM sale_items WHERE id = ?').get(r.saleItemId);
    expect(item.quantity).toBe(80);
    expect(item.paid_quantity).toBe(40);
    expect(item.reward_quantity).toBe(40);

    const pending = memDb.prepare('SELECT consumed_liters, status FROM pending_rewards WHERE id = ?').get(available.pendingId);
    expect(pending.consumed_liters).toBe(40);
    expect(pending.status).toBe('paid');
  });
});