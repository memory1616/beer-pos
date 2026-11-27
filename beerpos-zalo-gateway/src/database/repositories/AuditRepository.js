const { getDb } = require('../connection');

/** Repository cho bang gateway_audit_logs. KHONG ghi secret. */
class AuditRepository {
  constructor(db) {
    this.db = db || getDb();
  }

  insert(row) {
    const info = this.db
      .prepare(
        `INSERT INTO gateway_audit_logs (action, entity_type, entity_id, details)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        String(row.action),
        row.entityType || null,
        row.entityId !== undefined && row.entityId !== null ? String(row.entityId) : null,
        row.details ? JSON.stringify(row.details) : null
      );
    return info.lastInsertRowid;
  }

  list(opts = {}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const where = [];
    const params = [];

    if (opts.action) {
      where.push('action = ?');
      params.push(String(opts.action));
    }
    if (opts.entityType) {
      where.push('entity_type = ?');
      params.push(String(opts.entityType));
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db
      .prepare(`SELECT COUNT(*) AS c FROM gateway_audit_logs ${clause}`)
      .get(...params).c;

    const items = this.db
      .prepare(
        `SELECT * FROM gateway_audit_logs ${clause}
         ORDER BY id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    return { total, items };
  }
}

module.exports = AuditRepository;
