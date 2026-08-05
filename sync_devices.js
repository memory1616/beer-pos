const db = require('./database');

console.log('=== Sync all customers with devices table ===\n');

let fixed = 0;
let customers = db.prepare('SELECT id, name, horizontal_fridge, vertical_fridge FROM customers').all();

for (const customer of customers) {
  const actualHorizontal = db.prepare(
    "SELECT COUNT(*) as count FROM devices WHERE customer_id = ? AND type = 'horizontal' AND status = 'in_use'"
  ).get(customer.id).count;
  
  const actualVertical = db.prepare(
    "SELECT COUNT(*) as count FROM devices WHERE customer_id = ? AND type = 'vertical' AND status = 'in_use'"
  ).get(customer.id).count;
  
  // Only update if different
  if (customer.horizontal_fridge !== actualHorizontal || customer.vertical_fridge !== actualVertical) {
    console.log(`Customer ${customer.id} (${customer.name}): horizontal ${customer.horizontal_fridge} -> ${actualHorizontal}, vertical ${customer.vertical_fridge} -> ${actualVertical}`);
    db.prepare('UPDATE customers SET horizontal_fridge = ?, vertical_fridge = ? WHERE id = ?')
      .run(actualHorizontal, actualVertical, customer.id);
    fixed++;
  }
}

console.log(`\n=== Done! Fixed ${fixed} customers ===\n`);

// Summary
console.log('=== Summary ===');
const totalHorizontal = db.prepare("SELECT COUNT(*) as count FROM devices WHERE type = 'horizontal'").get().count;
const totalVertical = db.prepare("SELECT COUNT(*) as count FROM devices WHERE type = 'vertical'").get().count;
const availableHorizontal = db.prepare("SELECT COUNT(*) as count FROM devices WHERE type = 'horizontal' AND status = 'available'").get().count;
const availableVertical = db.prepare("SELECT COUNT(*) as count FROM devices WHERE type = 'vertical' AND status = 'available'").get().count;

console.log(`Total horizontal: ${totalHorizontal}`);
console.log(`Total vertical: ${totalVertical}`);
console.log(`Available horizontal: ${availableHorizontal}`);
console.log(`Available vertical: ${availableVertical}`);
console.log(`In use horizontal: ${totalHorizontal - availableHorizontal}`);
console.log(`In use vertical: ${totalVertical - availableVertical}`);
