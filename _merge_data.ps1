$key = "_k_1782360718674.pem"
$hostStr = "root@103.75.183.57"

Write-Host "=== Stop server ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "pm2 stop beer-pos 2>&1 | tail -2"

Write-Host ""
Write-Host "=== Stop server processes ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "pkill -f 'node.*server.js' 2>/dev/null; sleep 2"

Write-Host ""
Write-Host "=== Create merge script ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr @"
cat > /root/beer-pos/_merge_data.js << 'SCRIPT'
const Database = require('better-sqlite3');

const oldDb = new Database('/root/beer-pos/beer.db');
const newDb = new Database('/root/beer-pos/database.sqlite');

console.log('Old DB customers:', oldDb.prepare('SELECT COUNT(*) FROM customers').get()['COUNT(*)']);
console.log('New DB customers:', newDb.prepare('SELECT COUNT(*) FROM customers').get()['COUNT(*)']);
console.log('Old DB products:', oldDb.prepare('SELECT COUNT(*) FROM products').get()['COUNT(*)']);
console.log('New DB products:', newDb.prepare('SELECT COUNT(*) FROM products').get()['COUNT(*)']);
console.log('Old DB sales:', oldDb.prepare('SELECT COUNT(*) FROM sales').get()['COUNT(*)']);
console.log('New DB sales:', newDb.prepare('SELECT COUNT(*) FROM sales').get()['COUNT(*)']);

// Copy customers (skip existing by uuid)
const oldCustomers = oldDb.prepare('SELECT * FROM customers').all();
const insertCustomer = newDb.prepare(\`
  INSERT OR IGNORE INTO customers (name, phone, deposit, keg_balance, debt, address, lat, lng,
    note, last_order_date, horizontal_fridge, vertical_fridge, archived, exclude_expected,
    uuid, version, deleted, monthly_expected, first_order_date, monthly_purchased_liters,
    reward_tier, reward_claimed, reward_claimed_at, promotion_enabled, new_shop_enabled, reward_enabled, updated_at, created_at)
  VALUES (@name, @phone, @deposit, @keg_balance, @debt, @address, @lat, @lng,
    @note, @last_order_date, @horizontal_fridge, @vertical_fridge, @archived, @exclude_expected,
    @uuid, @version, @deleted, @monthly_expected, @first_order_date, @monthly_purchased_liters,
    @reward_tier, @reward_claimed, @reward_claimed_at, @promotion_enabled, @new_shop_enabled, @reward_enabled, @updated_at, @created_at)
\`);

let custCount = 0;
for (const c of oldCustomers) {
  try {
    insertCustomer.run(c);
    custCount++;
  } catch(e) {
    // Skip duplicates
  }
}
console.log('Customers merged:', custCount);

// Copy products (skip existing by slug)
const oldProducts = oldDb.prepare('SELECT * FROM products').all();
const insertProduct = newDb.prepare(\`
  INSERT OR IGNORE INTO products (slug, name, stock, damaged_stock, cost_price, sell_price, type, image_url, created_at, updated_at)
  VALUES (@slug, @name, @stock, @damaged_stock, @cost_price, @sell_price, @type, @image_url, @created_at, @updated_at)
\`);

let prodCount = 0;
for (const p of oldProducts) {
  try {
    insertProduct.run(p);
    prodCount++;
  } catch(e) {
    // Skip duplicates
  }
}
console.log('Products merged:', prodCount);

// Copy sales (skip existing by id)
const oldSales = oldDb.prepare('SELECT * FROM sales').all();
const insertSale = newDb.prepare(\`
  INSERT OR IGNORE INTO sales (id, customer_id, type, items, subtotal, discount, total, profit, payment_method, note, created_at, updated_at, archived, device_id)
  VALUES (@id, @customer_id, @type, @items, @subtotal, @discount, @total, @profit, @payment_method, @note, @created_at, @updated_at, @archived, @device_id)
\`);

let saleCount = 0;
for (const s of oldSales) {
  try {
    insertSale.run(s);
    saleCount++;
  } catch(e) {
    // Skip duplicates
  }
}
console.log('Sales merged:', saleCount);

console.log('Done!');
oldDb.close();
newDb.close();
SCRIPT
"@

Write-Host "=== Run merge ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "cd /root/beer-pos && node _merge_data.js 2>&1"
