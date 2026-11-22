const db = require('../database');
const ps = require('../src/services');

const rows = db.prepare(
  "SELECT id, name, created_at FROM customers WHERE created_at >= '2026-10-01' ORDER BY created_at DESC LIMIT 8"
).all();
console.log('--- Khach mo quan gan day:');
for (const r of rows) {
  console.log(r.id, '|', r.name, '|', r.created_at);
}

console.log('\n--- Eligibility (thang 11/2026):');
for (const r of rows) {
  try {
    const e = ps.getPromotionEligibility(r.id, 11, 2026);
    console.log(r.name, '=>', JSON.stringify(e));
  } catch (err) {
    console.log(r.name, 'ERR', err.message);
  }
}

console.log('\n--- Tinh thuong thang mo quan:');
for (const r of rows) {
  try {
    const c = new Date(r.created_at);
    const rew = ps.calculateNewShopMonthlyReward(r.id, c.getFullYear(), c.getMonth() + 1);
    console.log(r.name, '=>', JSON.stringify(rew));
  } catch (err) {
    console.log(r.name, 'ERR', err.message);
  }
}

console.log('\n--- Settings promotion:');
console.log(JSON.stringify(ps.getSystemPromotionSettings(), null, 1));
