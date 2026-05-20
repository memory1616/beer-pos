const db = require('./database');
const r = db.prepare(`
  SELECT COUNT(*) as total,
    SUM(CASE WHEN first_order_date IS NOT NULL THEN 1 ELSE 0 END) as with_date,
    SUM(CASE WHEN first_order_date IS NULL THEN 1 ELSE 0 END) as null_date
  FROM customers WHERE archived = 0
`).get();
console.log('Total customers:', r.total);
console.log('With first_order_date:', r.with_date);
console.log('NULL (old customers treated as new shops):', r.null_date);
const examples = db.prepare(`
  SELECT name, first_order_date, created_at
  FROM customers WHERE archived = 0 AND first_order_date IS NOT NULL
  ORDER BY created_at DESC LIMIT 3
`).all();
console.log('\nSample backfilled customers:');
examples.forEach(c => console.log(' -', c.name, '| first_order:', c.first_order_date, '| created:', c.created_at));
db.close();
