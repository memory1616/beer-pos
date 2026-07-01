// Debug script - check what attachRewardToSale does
const Database = require('better-sqlite3');
const db = new Database('/root/beer-pos/beer.db');

// Check if the latest code is deployed
const version = db.prepare("SELECT value FROM settings WHERE key = 'version'").get();
console.log('Version:', version);

// Get sale 544
const sale = db.prepare('SELECT * FROM sales WHERE id = 544').get();
console.log('Sale 544:', {
  id: sale.id,
  deliver_kegs: sale.deliver_kegs,
  promo_free_liters: sale.promo_free_liters,
  reward_liters_used: sale.reward_liters_used
});

// Get customer 31
const customer = db.prepare('SELECT id, name, keg_balance FROM customers WHERE id = 31').get();
console.log('Customer 31:', customer);

// Check reward_history
const reward = db.prepare('SELECT * FROM reward_history ORDER BY id DESC LIMIT 1').get();
console.log('Latest reward:', reward);

db.close();
