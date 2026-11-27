#!/usr/bin/env node
/**
 * Script migrate - chay migration cho gateway.sqlite.
 * Dung: npm run migrate | npm run migrate:down
 */
const { migrate, rollback } = require('../src/database/migrator');
const { closeDb } = require('../src/database/connection');
const logger = require('../src/logger');

function main() {
  const down = process.argv.includes('--down');
  const result = down ? rollback() : migrate();

  if (down) {
    console.log(`[MIGRATE] Da rollback: ${result.rolledBack || 'khong co'}`);
  } else {
    console.log(
      `[MIGRATE] Da ap dung ${result.applied.length} migration` +
        (result.applied.length ? `: ${result.applied.join(', ')}` : ' (database da cap nhat moi)')
    );
  }
  closeDb();
}

try {
  main();
} catch (e) {
  logger.error('[MIGRATE] That bai', { error: e.message });
  console.error('[MIGRATE] THAT BAI:', e.message);
  closeDb();
  process.exit(1);
}
