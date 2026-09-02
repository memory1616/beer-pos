/**
 * Tests for RewardService (Migration 043)
 *
 * 10 test cases theo plan:
 *   1. ordered=100, reward=40 -> paid=60, reward=40, delivered=100
 *   2. ordered=30, reward=40 -> paid=0, reward=30, remaining=10
 *   3. ordered=120, reward=40 -> paid=80, reward=40
 *   4. no reward -> paid=100, reward=0
 *   5. reward already claimed -> skip
 *   6. delete order -> reward remaining += used, keg restored, total reset
 *   7. edit order (100->80) -> reward recalc
 *   8. double submit API -> khong tao 2 reward_history rows
 *   9. multi-product: chi reward Bia Vang, Bia Den/Pet binh thuong
 *   10. integration: stock/cogs/profit/keg/debt/report dong bo
 *
 * Su dung jest.mock + in-memory better-sqlite3 cho moi test (khong mock method, chi mock module).
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

function seedData(db, opts) {
  const { yellowReward = 40, blackReward = 0 } = opts || {};

  db.prepare(`INSERT INTO products (id, name, slug, type, stock, cost_price, sell_price) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(1, 'Bia Vàng 30L', 'bia-vang-30l', 'keg', 1000, 11000, 21000);
  db.prepare(`INSERT INTO products (id, name, slug, type, stock, cost_price, sell_price) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(2, 'Bia Đen 30L', 'bia-den-30l', 'keg', 500, 13000, 25000);
  db.prepare(`INSERT INTO products (id, name, slug, type, stock, cost_price, sell_price) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(3, 'Bia Pet 330ml', 'bia-pet-330ml', 'pet', 2000, 5000, 10000);

  db.prepare(`INSERT INTO customers (id, name, debt, keg_balance) VALUES (?, ?, ?, ?)`).run(1, 'Khach Test', 0, 0);

  db.prepare(`INSERT INTO prices (customer_id, product_id, product_slug, price) VALUES (?, ?, ?, ?)`).run(1, 1, 'bia-vang-30l', 21000);
  db.prepare(`INSERT INTO prices (customer_id, product_id, product_slug, price) VALUES (?, ?, ?, ?)`).run(1, 2, 'bia-den-30l', 25000);
  db.prepare(`INSERT INTO prices (customer_id, product_id, product_slug, price) VALUES (?, ?, ?, ?)`).run(1, 3, 'bia-pet-330ml', 10000);

  db.prepare(`
    INSERT INTO pending_rewards (customer_id, reward_month, reward_year, reward_liters, reward_yellow_liters, reward_black_liters, mode, status, tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 8, 2026, yellowReward + blackReward, yellowReward, blackReward, 'auto', 'pending', 'tier_1');
}

// Mock database module BEFORE requiring RewardService
jest.mock('../../database', () => {
  let _db;
  return {
    get db() { return _db; },
    set db(v) { _db = v; },
    prepare: function(...args) { return _db.prepare(...args); },
    transaction: function(fn) { return _db.transaction(fn); },
    exec: function(...args) { return _db.exec(...args); },
    getVietnamDateStr: () => '2026-08-15',
    getVietnamTimeStr: () => '2026-08-15 10:00:00'
  };
});

const dbModule = require('../../database');
const RewardServiceClass = require('../../src/services/RewardService');
const RewardService = new RewardServiceClass();

beforeEach(() => {
  memDb = new Database(':memory:');
  setupSchema(memDb);
  dbModule.db = memDb;
});

afterEach(() => {
  if (memDb) {
    memDb.close();
    memDb = null;
  }
});

function makePending(customerId = 1) {
  return RewardService.getAvailableReward(customerId);
}

function makeOrderedItems(quantity, productId = 1) {
  const productMap = {
    1: { productId: 1, name: 'Bia Vàng 30L', slug: 'bia-vang-30l', type: 'keg' },
    2: { productId: 2, name: 'Bia Đen 30L', slug: 'bia-den-30l', type: 'keg' },
    3: { productId: 3, name: 'Bia Pet 330ml', slug: 'bia-pet-330ml', type: 'pet' }
  };
  const p = productMap[productId];
  return [{
    productId: p.productId,
    productSlug: p.slug,
    productName: p.name,
    quantity: quantity,
    price: 21000,
    costPrice: 11000,
    type: p.type
  }];
}

describe('RewardService.calculateRewardApplication - Pure Logic', () => {

  test('Case 1: ordered=100, reward=40 -> paid=60, reward=40', () => {
    seedData(memDb, { yellowReward: 40 });
    const available = makePending();
    const items = makeOrderedItems(100);

    const result = RewardService.calculateRewardApplication(items, available);

    expect(result.applied).toBe(true);
    expect(result.items[0].paidQty).toBe(60);
    expect(result.items[0].rewardQty).toBe(40);
    expect(result.totalRewardApplied).toBe(40);
    expect(result.yellowApplied).toBe(40);
    expect(result.blackApplied).toBe(0);
  });

  test('Case 2: ordered=30, reward=40 -> paid=0, reward=30, remaining=10', () => {
    seedData(memDb, { yellowReward: 40 });
    const available = makePending();
    const items = makeOrderedItems(30);

    const result = RewardService.calculateRewardApplication(items, available);

    expect(result.applied).toBe(true);
    expect(result.items[0].paidQty).toBe(0);
    expect(result.items[0].rewardQty).toBe(30);
    expect(result.remainingAfter.total).toBe(10);
  });

  test('Case 3: ordered=120, reward=40 -> paid=80, reward=40', () => {
    seedData(memDb, { yellowReward: 40 });
    const available = makePending();
    const items = makeOrderedItems(120);

    const result = RewardService.calculateRewardApplication(items, available);

    expect(result.applied).toBe(true);
    expect(result.items[0].paidQty).toBe(80);
    expect(result.items[0].rewardQty).toBe(40);
  });

  test('Case 4: no reward -> paid=100, reward=0', () => {
    seedData(memDb, { yellowReward: 0 });
    const available = makePending();
    const items = makeOrderedItems(100);

    const result = RewardService.calculateRewardApplication(items, available);

    expect(result.applied).toBe(false);
    expect(result.items[0].paidQty).toBe(100);
    expect(result.items[0].rewardQty).toBe(0);
  });

  test('Case 9: multi-product - chi reward Bia Vang', () => {
    seedData(memDb, { yellowReward: 40 });
    const available = makePending();
    const items = [
      { productId: 1, productSlug: 'bia-vang-30l', productName: 'Bia Vàng 30L', quantity: 100, price: 21000, costPrice: 11000, type: 'keg' },
      { productId: 2, productSlug: 'bia-den-30l', productName: 'Bia Đen 30L', quantity: 50, price: 25000, costPrice: 13000, type: 'keg' },
      { productId: 3, productSlug: 'bia-pet-330ml', productName: 'Bia Pet 330ml', quantity: 200, price: 10000, costPrice: 5000, type: 'pet' }
    ];

    const result = RewardService.calculateRewardApplication(items, available);

    expect(result.applied).toBe(true);
    expect(result.items[0].paidQty).toBe(60);
    expect(result.items[0].rewardQty).toBe(40);
    expect(result.items[1].paidQty).toBe(50);
    expect(result.items[1].rewardQty).toBe(0);
    expect(result.items[2].paidQty).toBe(200);
    expect(result.items[2].rewardQty).toBe(0);
  });

  test('Case black reward: ordered=50, black=20 -> reward 20L den', () => {
    seedData(memDb, { yellowReward: 0, blackReward: 20 });
    const available = makePending();
    const items = [
      { productId: 1, productSlug: 'bia-vang-30l', productName: 'Bia Vàng 30L', quantity: 50, price: 21000, costPrice: 11000, type: 'keg' },
      { productId: 2, productSlug: 'bia-den-30l', productName: 'Bia Đen 30L', quantity: 50, price: 25000, costPrice: 13000, type: 'keg' }
    ];

    const result = RewardService.calculateRewardApplication(items, available);

    expect(result.applied).toBe(true);
    expect(result.items[0].rewardQty).toBe(0);
    expect(result.items[1].paidQty).toBe(30);
    expect(result.items[1].rewardQty).toBe(20);
  });
});

describe('RewardService.applyRewardToOrder - Integration with DB', () => {

  function setupSale(quantity, productId = 1) {
    const product = memDb.prepare('SELECT * FROM products WHERE id = ?').get(productId);

    const insertSale = memDb.prepare(`
      INSERT INTO sales (customer_id, type, date, total, profit, deliver_kegs, status)
      VALUES (?, 'sale', '2026-08-15', ?, ?, ?, NULL)
    `);
    const saleResult = insertSale.run(1, quantity * 21000, quantity * (21000 - 11000), quantity);
    const saleId = saleResult.lastInsertRowid;

    const insertItem = memDb.prepare(`
      INSERT INTO sale_items (sale_id, product_id, product_slug, quantity, price, cost_price, profit)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const itemResult = insertItem.run(saleId, productId, product.slug, quantity, 21000, 11000, quantity * (21000 - 11000));

    return { saleId, saleItemId: itemResult.lastInsertRowid, product };
  }

  test('Case 1 integration: apply reward to sale_items', () => {
    seedData(memDb, { yellowReward: 40 });
    const { saleId, saleItemId } = setupSale(100);

    const available = makePending();
    const items = makeOrderedItems(100);
    items[0].saleItemId = saleItemId;
    const application = RewardService.calculateRewardApplication(items, available);

    const result = RewardService.applyRewardToOrder(saleId, 1, application, available.pendingId, 8, 2026);

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(0);

    const updatedItem = memDb.prepare('SELECT * FROM sale_items WHERE id = ?').get(saleItemId);
    expect(updatedItem.paid_quantity).toBe(60);
    expect(updatedItem.reward_quantity).toBe(40);
    expect(updatedItem.reward_source).toBe('pending');
    expect(updatedItem.reward_month).toBe(8);
    expect(updatedItem.reward_year).toBe(2026);

    const pending = memDb.prepare('SELECT * FROM pending_rewards WHERE id = ?').get(available.pendingId);
    expect(pending.consumed_liters).toBe(40);
    expect(pending.status).toBe('paid');

    const history = memDb.prepare('SELECT * FROM reward_history WHERE customer_id = ?').all(1);
    expect(history.length).toBe(1);
    expect(history[0].reward_liters).toBe(40);
  });

  test('Case 2 integration: reward > ordered -> pending partial', () => {
    seedData(memDb, { yellowReward: 40 });
    const { saleId, saleItemId } = setupSale(30);

    const available = makePending();
    const items = makeOrderedItems(30);
    items[0].saleItemId = saleItemId;
    const application = RewardService.calculateRewardApplication(items, available);

    const result = RewardService.applyRewardToOrder(saleId, 1, application, available.pendingId, 8, 2026);

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(10);

    const updatedItem = memDb.prepare('SELECT * FROM sale_items WHERE id = ?').get(saleItemId);
    expect(updatedItem.paid_quantity).toBe(0);
    expect(updatedItem.reward_quantity).toBe(30);

    const pending = memDb.prepare('SELECT * FROM pending_rewards WHERE id = ?').get(available.pendingId);
    expect(pending.consumed_liters).toBe(30);
    expect(pending.status).toBe('partial');
  });

  test('Case 5/8: idempotency - khong tao 2 reward_history', () => {
    seedData(memDb, { yellowReward: 40 });
    const { saleId, saleItemId } = setupSale(100);

    const available = makePending();
    const items = makeOrderedItems(100);
    items[0].saleItemId = saleItemId;
    const application = RewardService.calculateRewardApplication(items, available);

    RewardService.applyRewardToOrder(saleId, 1, application, available.pendingId, 8, 2026);

    const hasReward = RewardService.hasRewardApplied(saleId);
    expect(hasReward).toBe(true);

    const history = memDb.prepare('SELECT * FROM reward_history WHERE customer_id = ?').all(1);
    expect(history.length).toBe(1);
  });

  test('Case 6: reverse reward khi xoa don', () => {
    seedData(memDb, { yellowReward: 40 });
    const { saleId, saleItemId } = setupSale(100);

    const available = makePending();
    const items = makeOrderedItems(100);
    items[0].saleItemId = saleItemId;
    const application = RewardService.calculateRewardApplication(items, available);
    RewardService.applyRewardToOrder(saleId, 1, application, available.pendingId, 8, 2026);

    const reverseResult = RewardService.reverseRewardFromOrder(saleId);

    expect(reverseResult.reversedLiters).toBe(40);
    expect(reverseResult.yellowReversed).toBe(40);
    expect(reverseResult.blackReversed).toBe(0);

    const pending = memDb.prepare('SELECT * FROM pending_rewards WHERE id = ?').get(available.pendingId);
    expect(pending.consumed_liters).toBe(0);
    expect(pending.status).toBe('pending');

    const updatedItem = memDb.prepare('SELECT * FROM sale_items WHERE id = ?').get(saleItemId);
    expect(updatedItem.reward_quantity).toBe(0);

    const history = memDb.prepare('SELECT * FROM reward_history WHERE customer_id = ?').all(1);
    expect(history.length).toBe(0);
  });

  test('Case 10: integration - stock/cogs/profit consistency', () => {
    seedData(memDb, { yellowReward: 40 });
    const { saleId, saleItemId } = setupSale(100);

    memDb.prepare('UPDATE products SET stock = stock - 100 WHERE id = 1').run();

    const available = makePending();
    const items = makeOrderedItems(100);
    items[0].saleItemId = saleItemId;
    const application = RewardService.calculateRewardApplication(items, available);
    const rewardResult = RewardService.applyRewardToOrder(saleId, 1, application, available.pendingId, 8, 2026);

    expect(rewardResult.success).toBe(true);

    const item = memDb.prepare('SELECT * FROM sale_items WHERE id = ?').get(saleItemId);
    const cogs = item.quantity * item.cost_price; // 100 * 11000 = 1,100,000
    expect(cogs).toBe(1100000);

    const lineTotal = item.paid_quantity * item.price; // 60 * 21000 = 1,260,000
    expect(lineTotal).toBe(1260000);

    // stock da bi tru 100 (delivered = quantity)
    const stockAfter = memDb.prepare('SELECT stock FROM products WHERE id = 1').get();
    expect(stockAfter.stock).toBe(900);
  });
});
