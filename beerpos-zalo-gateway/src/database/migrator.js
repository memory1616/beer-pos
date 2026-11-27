const fs = require('fs');
const path = require('path');
const { getDb } = require('./connection');
const logger = require('../logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function loadMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => {
      const mod = require(path.join(MIGRATIONS_DIR, f));
      return { version: mod.version, name: mod.name, up: mod.up, down: mod.down };
    })
    .sort((a, b) => a.version - b.version);
}

function appliedVersions(db) {
  ensureMigrationsTable(db);
  return new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
}

/** Chay migration chua apply. */
function migrate() {
  const db = getDb();
  const done = appliedVersions(db);
  const all = loadMigrations();
  const pending = all.filter((m) => !done.has(m.version));

  if (!pending.length) {
    logger.info('[MIGRATE] Database da cap nhat moi (khong co migration moi)');
    return { applied: [], skipped: all.length };
  }

  const applied = [];
  for (const m of pending) {
    const run = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
        m.version,
        m.name
      );
    });
    run();
    applied.push(`${m.version}_${m.name}`);
    logger.info('[MIGRATE] Da ap dung', { version: m.version, name: m.name });
  }

  return { applied, skipped: done.size };
}

/** Giu migration moi nhat. */
function rollback() {
  const db = getDb();
  const all = loadMigrations();
  const done = appliedVersions(db);
  const last = [...all].reverse().find((m) => done.has(m.version));
  if (!last) {
    logger.info('[MIGRATE] Khong co migration nao de rollback');
    return { rolledBack: null };
  }
  const run = db.transaction(() => {
    if (typeof last.down === 'function') last.down(db);
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(last.version);
  });
  run();
  logger.info('[MIGRATE] Da rollback', { version: last.version, name: last.name });
  return { rolledBack: `${last.version}_${last.name}` };
}

module.exports = { migrate, rollback, loadMigrations, MIGRATIONS_DIR };
