const { getDb } = require('../connection');

/** Repository cho bang gateway_settings. KHONG luu secret. */
class SettingsRepository {
  constructor(db) {
    this.db = db || getDb();
  }

  get(key, fallback = null) {
    const row = this.db
      .prepare('SELECT value FROM gateway_settings WHERE key = ?')
      .get(String(key));
    return row && row.value !== null ? row.value : fallback;
  }

  getAll() {
    const rows = this.db.prepare('SELECT key, value FROM gateway_settings ORDER BY key').all();
    const out = {};
    rows.forEach((r) => {
      out[r.key] = r.value;
    });
    return out;
  }

  set(key, value) {
    this.db
      .prepare(
        `INSERT INTO gateway_settings (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                        updated_at = CURRENT_TIMESTAMP`
      )
      .run(String(key), value === null || value === undefined ? null : String(value));
    return this.get(key);
  }

  remove(key) {
    this.db.prepare('DELETE FROM gateway_settings WHERE key = ?').run(String(key));
  }
}

module.exports = SettingsRepository;
