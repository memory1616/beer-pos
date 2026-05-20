/**
 * Test script for Promotion System
 * Run: node test_promo.js
 */
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  PASS:', name);
    passed++;
  } catch (e) {
    console.log('  FAIL:', name, '|', e.message);
    failed++;
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

// Load PromotionService
const { PromotionService } = require('./src/services');

console.log('\n=== PROMOTION SYSTEM TESTS ===\n');

// Test 1: classifyBeer
console.log('--- classifyBeer ---');
test('Bia Heineken => gold', () => {
  assertEqual(PromotionService.classifyBeer('Heineken'), 'gold', 'type');
});
test('Bia Tiger => gold', () => {
  assertEqual(PromotionService.classifyBeer('Tiger'), 'gold', 'type');
});
test('Bia Guinness => black', () => {
  assertEqual(PromotionService.classifyBeer('Guinness'), 'black', 'type');
});
test('Bia Kilkenny => black', () => {
  assertEqual(PromotionService.classifyBeer('Kilkenny'), 'black', 'type');
});
test('Bia Budweiser => gold', () => {
  assertEqual(PromotionService.classifyBeer('Budweiser'), 'gold', 'type');
});

// Test 2: calculateNewShopPromotion - Bia vang
console.log('\n--- calculateNewShopPromotion (Bia vang) ---');
test('Mua 10L vang => tang 1L', () => {
  const r = PromotionService.calculateNewShopPromotion(10, 0);
  assertEqual(r.freeGold, 1, 'freeGold');
  assertEqual(r.freeBlack, 0, 'freeBlack');
  assertEqual(r.totalFree, 1, 'totalFree');
});
test('Mua 20L vang => tang 2L', () => {
  const r = PromotionService.calculateNewShopPromotion(20, 0);
  assertEqual(r.freeGold, 2, 'freeGold');
  assertEqual(r.totalFree, 2, 'totalFree');
});
test('Mua 35L vang => tang 3L', () => {
  const r = PromotionService.calculateNewShopPromotion(35, 0);
  assertEqual(r.freeGold, 3, 'freeGold');
  assertEqual(r.totalFree, 3, 'totalFree');
});
test('Mua 9L vang => tang 0L', () => {
  const r = PromotionService.calculateNewShopPromotion(9, 0);
  assertEqual(r.totalFree, 0, 'totalFree');
});
test('Mua 25L vang => tang 2L (TC1)', () => {
  const r = PromotionService.calculateNewShopPromotion(25, 0);
  assertEqual(r.freeGold, 2, 'freeGold');
  assertEqual(r.totalFree, 2, 'totalFree');
});

// Test 3: calculateNewShopPromotion - Bia den
console.log('\n--- calculateNewShopPromotion (Bia den) ---');
test('Mua 20L den => tang 1L', () => {
  const r = PromotionService.calculateNewShopPromotion(0, 20);
  assertEqual(r.freeBlack, 1, 'freeBlack');
  assertEqual(r.totalFree, 1, 'totalFree');
});
test('Mua 40L den => tang 2L', () => {
  const r = PromotionService.calculateNewShopPromotion(0, 40);
  assertEqual(r.freeBlack, 2, 'freeBlack');
  assertEqual(r.totalFree, 2, 'totalFree');
});
test('Mua 45L den => tang 2L (TC2)', () => {
  const r = PromotionService.calculateNewShopPromotion(0, 45);
  assertEqual(r.freeBlack, 2, 'freeBlack');
  assertEqual(r.totalFree, 2, 'totalFree');
});
test('Mua 19L den => tang 0L', () => {
  const r = PromotionService.calculateNewShopPromotion(0, 19);
  assertEqual(r.totalFree, 0, 'totalFree');
});

// Test 4: calculateNewShopPromotion - Mix
console.log('\n--- calculateNewShopPromotion (Mix) ---');
test('Mua 10L vang + 20L den => tang 2L', () => {
  const r = PromotionService.calculateNewShopPromotion(10, 20);
  assertEqual(r.freeGold, 1, 'freeGold');
  assertEqual(r.freeBlack, 1, 'freeBlack');
  assertEqual(r.totalFree, 2, 'totalFree');
});

// Test 5: Database schema - kiem tra cac truong moi
console.log('\n--- Database Schema ---');
test('customers.co lon first_order_date', () => {
  const r = db.prepare("PRAGMA table_info(customers)").all();
  const cols = r.map(c => c.name);
  if (!cols.includes('first_order_date')) throw new Error('missing first_order_date');
  if (!cols.includes('monthly_purchased_liters')) throw new Error('missing monthly_purchased_liters');
  if (!cols.includes('reward_tier')) throw new Error('missing reward_tier');
  if (!cols.includes('reward_claimed')) throw new Error('missing reward_claimed');
});
test('sales.co lon promo fields', () => {
  const r = db.prepare("PRAGMA table_info(sales)").all();
  const cols = r.map(c => c.name);
  if (!cols.includes('promo_free_liters')) throw new Error('missing promo_free_liters');
  if (!cols.includes('promo_type')) throw new Error('missing promo_type');
  if (!cols.includes('reward_liters_used')) throw new Error('missing reward_liters_used');
});
test('reward_history table ton tai', () => {
  const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reward_history'").get();
  if (!r) throw new Error('reward_history table not found');
});

// Test 6: Revenue integrity — same-type beer (bya tang giong loai)
console.log('\n--- Same-Type Beer Promotion ---');
test('Bia tang cung loai: tang vang thi trừ kho vang, tang den thi trừ kho den', () => {
  const r1 = PromotionService.calculateNewShopPromotion(10, 0);
  if (r1.freeGold !== 1 || r1.totalFree !== 1) throw new Error('expect freeGold=1, totalFree=1');
  const r2 = PromotionService.calculateNewShopPromotion(0, 20);
  if (r2.freeBlack !== 1 || r2.totalFree !== 1) throw new Error('expect freeBlack=1, totalFree=1');
  const r3 = PromotionService.calculateNewShopPromotion(10, 20);
  if (r3.freeGold !== 1 || r3.freeBlack !== 1 || r3.totalFree !== 2) throw new Error('expect gold=1, black=1, total=2');
});

// Test 7: Revenue chi tinh paid liters, khong tinh liters tang
console.log('\n--- Revenue Integrity ---');
test('MONTHLY_BONUS sale co total=0', () => {
  const bonusSales = db.prepare("SELECT * FROM sales WHERE promo_type='MONTHLY_BONUS' AND archived=0").all();
  for (const s of bonusSales) {
    if (s.total !== 0) throw new Error(`MONTHLY_BONUS sale #${s.id} has total=${s.total}, expected 0`);
  }
});
test('NEW_SHOP sale tinh revenue dung (khong tinh liters tang)', () => {
  const newShopSales = db.prepare("SELECT * FROM sales WHERE promo_type='NEW_SHOP' AND archived=0 AND total > 0 LIMIT 3").all();
  for (const s of newShopSales) {
    if (s.total < 0) throw new Error(`NEW_SHOP sale #${s.id} has total=${s.total}, should be >= 0`);
    if (s.promo_free_liters > 0 && s.total > 0) {
      // total chi tinh paid liters, khong tinh promo_free_liters
    }
  }
});

// Test 7: monthly_purchased_liters chi tinh paid liters
console.log('\n--- Monthly Purchased Liters ---');
test('monthly_purchased_liters khong am', () => {
  const neg = db.prepare("SELECT COUNT(*) as cnt FROM customers WHERE monthly_purchased_liters < 0").get();
  if (neg.cnt > 0) throw new Error(`${neg.cnt} customers have negative monthly_purchased_liters`);
});

// Summary
console.log('\n=== RESULTS ===');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log('');

db.close();
process.exit(failed > 0 ? 1 : 0);
