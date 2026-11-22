const db = require('../database');
const { PromotionService: ps } = require('../src/services');

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
    const e = ps.getPromotionEligibility(r, 11, 2026);
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

console.log('\n--- Thong ke don hang thang 11/2026 cua cac khach tren:');
for (const r of rows) {
  const agg = db.prepare(
    `SELECT p.name AS pn, si.quantity AS q
       FROM sales s
       JOIN sale_items si ON si.sale_id = s.id
       JOIN products p ON p.id = si.product_id
      WHERE s.customer_id = ? AND s.type = 'sale' AND s.archived = 0
        AND si.price > 0 AND p.type = 'keg'
        AND strftime('%Y', s.date) = '2026' AND strftime('%m', s.date) = '11'`
  ).all(r.id);
  console.log(r.name, '=>', JSON.stringify(agg));
}
