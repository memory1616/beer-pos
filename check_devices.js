const db = require('./database');

console.log('=== Devices Table ===');
const devices = db.prepare('SELECT id, name, type, status, customer_id FROM devices ORDER BY id').all();
console.table(devices);

console.log('\n=== Summary by status and type ===');
const summary = db.prepare("SELECT status, type, COUNT(*) as count FROM devices GROUP BY status, type ORDER BY type, status").all();
console.table(summary);

console.log('\n=== Customers with fridges ===');
const customers = db.prepare('SELECT id, name, horizontal_fridge, vertical_fridge FROM customers WHERE horizontal_fridge > 0 OR vertical_fridge > 0').all();
console.table(customers);

console.log('\n=== Available devices (status=available) ===');
const available = db.prepare("SELECT type, COUNT(*) as count FROM devices WHERE status = 'available' GROUP BY type").all();
console.table(available);
