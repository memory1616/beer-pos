const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { config } = require('../config');
const logger = require('../logger');

let _db = null;

/**
 * Mo ket noi SQLite cho Gateway.
 * - WAL mode: doc khong chan ghi.
 * - busy_timeout: tranh SQLITE_BUSY khi worker ghi dong thoi voi API doc.
 * - foreign_keys: bat rang buoc FK.
 */
function getDb() {
  if (_db) return _db;

  const dir = path.dirname(config.database.path);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(config.database.path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  _db = db;
  logger.info('[DB] Da mo gateway.sqlite', { path: config.database.path });
  return _db;
}

/** Dong ket noi (dung khi test / shutdown). */
function closeDb() {
  if (_db) {
    try {
      _db.close();
    } catch (_) {
      /* ignore */
    }
    _db = null;
  }
}

module.exports = { getDb, closeDb };
