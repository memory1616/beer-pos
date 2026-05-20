const db = require('./database');

// Verify filters
console.log('=== Verify filters ===');
const tests = [
  ['Gold - NOT LIKE %Đen%', "name NOT LIKE '%Đen%' AND name NOT LIKE '%den%' AND name NOT LIKE '%Guinness%'"],
  ['Black - LIKE %Đen%', "name LIKE '%Đen%' OR name LIKE '%den%'"],
];
tests.forEach(([label, cond]) => {
  const r = db.prepare(`SELECT id, name FROM products WHERE archived = 0 AND type = 'keg' AND ${cond} ORDER BY id ASC LIMIT 1`).get();
  console.log(label + ':', r ? r.name : 'NOT FOUND');
});

db.close();
