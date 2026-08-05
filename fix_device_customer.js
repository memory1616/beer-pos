const db = require('./database');

// Fix customer 16 - recount actual devices
const customerId = 16;

console.log(`=== Fixing customer ${customerId} ===`);

// Recount from devices table
const actualHorizontal = db.prepare(
  "SELECT COUNT(*) as count FROM devices WHERE customer_id = ? AND type = 'horizontal' AND status = 'in_use'"
).get(customerId).count;

const actualVertical = db.prepare(
  "SELECT COUNT(*) as count FROM devices WHERE customer_id = ? AND type = 'vertical' AND status = 'in_use'"
).get(customerId).count;

console.log(`Actual horizontal: ${actualHorizontal}`);
console.log(`Actual vertical: ${actualVertical}`);

// Update customer
db.prepare('UPDATE customers SET horizontal_fridge = ?, vertical_fridge = ? WHERE id = ?')
  .run(actualHorizontal, actualVertical, customerId);

console.log(`Updated customer ${customerId}`);

// Verify
const customer = db.prepare('SELECT id, name, horizontal_fridge, vertical_fridge FROM customers WHERE id = ?').get(customerId);
console.log('\nAfter fix:');
console.table(customer);

// Also check total available
console.log('\n=== Available devices (should show horizontal > 0 now) ===');
const available = db.prepare("SELECT type, COUNT(*) as count FROM devices WHERE status = 'available' GROUP BY type").all();
console.table(available);
