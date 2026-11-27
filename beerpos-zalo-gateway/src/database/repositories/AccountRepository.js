const { getDb } = require('../connection');

/** Repository cho bang gateway_account (chi 1 tai khoan, id = 1). */
class AccountRepository {
  constructor(db) {
    this.db = db || getDb();
  }

  get() {
    return (
      this.db.prepare('SELECT * FROM gateway_account WHERE id = 1').get() || null
    );
  }

  ensure() {
    const existing = this.get();
    if (existing) return existing;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO gateway_account
           (id, provider, display_name, status, connection_mode)
         VALUES (1, 'mock', 'Tai khoan Zalo chinh', 'not_configured', 'mock')`
      )
      .run();
    return this.get();
  }

  update(patch) {
    this.ensure();
    const fields = [];
    const params = [];
    const map = {
      provider: 'provider',
      displayName: 'display_name',
      status: 'status',
      connectionMode: 'connection_mode',
      lastCheckedAt: 'last_checked_at',
      lastError: 'last_error',
    };
    Object.entries(patch).forEach(([k, v]) => {
      const col = map[k];
      if (!col) return;
      fields.push(`${col} = ?`);
      params.push(v === undefined ? null : v);
    });
    if (!fields.length) return this.get();
    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(1);
    this.db
      .prepare(`UPDATE gateway_account SET ${fields.join(', ')} WHERE id = ?`)
      .run(...params);
    return this.get();
  }
}

module.exports = AccountRepository;
