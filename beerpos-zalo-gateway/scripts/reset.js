#!/usr/bin/env node
/**
 * Script reset - XOA toan bo database Gateway (chi dung local dev).
 * Khong bao gio chay tren production.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { closeDb } = require('../src/database/connection');

function main() {
  if (config.isProduction) {
    console.error('[RESET] KHONG chay tren production.');
    process.exit(1);
  }

  closeDb();

  const targets = [
    config.database.path,
    `${config.database.path}-shm`,
    `${config.database.path}-wal`,
  ];

  targets.forEach((t) => {
    if (fs.existsSync(t)) {
      fs.unlinkSync(t);
      console.log(`[RESET] Da xoa ${t}`);
    }
  });

  console.log('[RESET] Xong. Chay `npm run migrate` de tao lai schema.');
}

main();
