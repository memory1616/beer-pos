// Fix order 540 - update deliver_kegs from 100 to 140
const Database = require('better-sqlite3');
const db = new Database('/root/beer-pos/beer.db');

const saleId = 540;
const customerId = 31;
const correctDeliverKegs = 140;
const bonusLiters = 40;

// Get current values
const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
console.log('Before:', { 
  id: sale.id, 
  deliver_kegs: sale.deliver_kegs, 
  promo_free_liters: sale.promo_free_liters,
  keg_balance_after: sale.keg_balance_after 
});

// Update sale
db.prepare('UPDATE sales SET deliver_kegs = ?, promo_free_liters = ? WHERE id = ?')
  .run(correctDeliverKegs, bonusLiters, saleId);

// Update customer keg_balance (add 40 more kegs)
db.prepare('UPDATE customers SET keg_balance = keg_balance + ? WHERE id = ?')
  .run(bonusLiters, customerId);

// Verify
const updated = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
const customer = db.prepare('SELECT id, keg_balance FROM customers WHERE id = ?').get(customerId);
console.log('After:', { 
  id: updated.id, 
  deliver_kegs: updated.deliver_kegs, 
  promo_free_liters: updated.promo_free_liters,
  keg_balance_after: updated.keg_balance_after 
});
console.log('Customer:', customer);

db.close();
console.log('Done!');
