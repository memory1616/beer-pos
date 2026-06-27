// Migration 042: Add sale_time column to sales table
// Purpose: Store exact sale time (HH:MM:SS) for accurate invoice timestamps

'use strict';

module.exports = function(db) {
  // Add sale_time column if it doesn't exist
  const columns = db.prepare("PRAGMA table_info(sales)").all();
  const hasSaleTime = columns.some(c => c.name === 'sale_time');

  if (!hasSaleTime) {
    db.exec("ALTER TABLE sales ADD COLUMN sale_time TEXT");
    logger && logger.info('[Migration 042] Added sale_time column to sales table');
  }
};
