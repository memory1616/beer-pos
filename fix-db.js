const db = require('./database');

// Add time column if not exists
try {
  db.exec("ALTER TABLE expenses ADD COLUMN time TEXT DEFAULT ''");
  console.log('Added time column');
} catch(e) {
  console.log('Time column may exist:', e.message);
}

// Add is_auto column if not exists  
try {
  db.exec("ALTER TABLE expenses ADD COLUMN is_auto INTEGER DEFAULT 0");
  console.log('Added is_auto column');
} catch(e) {
  console.log('is_auto column may exist:', e.message);
}

console.log('Done!');
