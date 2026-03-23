/**
 * Beer POS - Database Helpers
 * Shared utilities for database operations
 */
const db = require('../database');

/**
 * Auto-update updated_at column for a row after modify
 * Call after any INSERT/UPDATE/DELETE on sync-enabled tables
 */
function touchRow(table, id) {
  if (!table || !id) return;
  try {
    db.prepare(`UPDATE ${table} SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  } catch (e) {
    // Table may not have updated_at column — silent fail
  }
}

module.exports = { touchRow };
