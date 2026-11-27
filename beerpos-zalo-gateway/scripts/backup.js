#!/usr/bin/env node
/**
 * Script backup - sao luu gateway.sqlite an toan (dung API .backup() cua
 * better-sqlite3, khong copy thang file khi process dang ghi).
 */
const fs = require('fs');
const path = require('path');
const { getDb, closeDb } = require('../src/database/connection');
const { config } = require('../src/config');

function main() {
  const db = getDb();
  const backupDir = path.join(path.dirname(config.database.path), 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(backupDir, `gateway-${stamp}.sqlite`);

  db.backup(target).then(() => {
    const size = fs.statSync(target).size;
    console.log(`[BACKUP] Da sao luu: ${target} (${size} bytes)`);
    closeDb();
  }).catch((e) => {
    console.error('[BACKUP] THAT BAI:', e.message);
    closeDb();
    process.exit(1);
  });
}

main();
