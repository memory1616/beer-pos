const Database = require('better-sqlite3');
const db = new Database('./database.sqlite');

console.log('Current stock:');
const before = db.prepare('SELECT id, name, stock FROM products').all();
console.log(JSON.stringify(before, null, 2));

// Add purchase record
const now = new Date().toISOString();
const note = 'Nhập hàng ngày 12/3/2026 - Khôi phục từ yêu cầu user';

// Purchase items
const items = [
  { product_id: 3, quantity: 550, unit_price: 10000 }, // Bia Bom Vàng
  { product_id: 1, quantity: 150, unit_price: 16000 }, // Bia Bom Đen
  { product_id: 2, quantity: 150, unit_price: 8000 },  // Bia Pet
];

let totalAmount = 0;
for (const item of items) {
  totalAmount += item.quantity * item.unit_price;
}

console.log('\nTotal amount:', totalAmount);

// Insert purchase
const result = db.prepare('INSERT INTO purchases (date, total_amount, note) VALUES (?, ?, ?)').run(now, totalAmount, note);
const purchaseId = result.lastInsertRowid;
console.log('Purchase ID:', purchaseId);

// Insert purchase items and update stock
for (const item of items) {
  const totalPrice = item.quantity * item.unit_price;
  db.prepare('INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?)').run(
    purchaseId, item.product_id, item.quantity, item.unit_price, totalPrice
  );
  
  // Update stock
  db.prepare('UPDATE products SET stock = stock + ?, cost_price = ? WHERE id = ?').run(item.quantity, item.unit_price, item.product_id);
}

console.log('\nStock after:');
const after = db.prepare('SELECT id, name, stock FROM products').all();
console.log(JSON.stringify(after, null, 2));

console.log('\nPurchases:');
const purchases = db.prepare('SELECT * FROM purchases ORDER BY date DESC LIMIT 5').all();
console.log(JSON.stringify(purchases, null, 2));

db.close();
console.log('\n✅ Đã khôi phục dữ liệu nhập hàng!');
