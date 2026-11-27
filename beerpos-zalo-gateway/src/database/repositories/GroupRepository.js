const { getDb } = require('../connection');

/** Repository cho bang gateway_groups. */
class GroupRepository {
  constructor(db) {
    this.db = db || getDb();
  }

  findByCustomerId(customerId) {
    return (
      this.db
        .prepare('SELECT * FROM gateway_groups WHERE customer_id = ?')
        .get(String(customerId)) || null
    );
  }

  findActiveByCustomerId(customerId) {
    return (
      this.db
        .prepare(
          'SELECT * FROM gateway_groups WHERE customer_id = ? AND is_active = 1'
        )
        .get(String(customerId)) || null
    );
  }

  findByGroupId(groupId) {
    return (
      this.db
        .prepare('SELECT * FROM gateway_groups WHERE group_id = ?')
        .get(String(groupId)) || null
    );
  }

  findById(id) {
    return (
      this.db.prepare('SELECT * FROM gateway_groups WHERE id = ?').get(Number(id)) || null
    );
  }

  list(opts = {}) {
    const where = [];
    const params = [];

    const status = String(opts.status || 'all').toLowerCase();
    if (status === 'active') where.push('is_active = 1');
    else if (status === 'inactive') where.push('is_active = 0');

    const search = String(opts.search || '').trim();
    if (search) {
      where.push(
        '(customer_id LIKE ? OR group_id LIKE ? OR customer_name LIKE ? OR group_name LIKE ?)'
      );
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = this.db
      .prepare(`SELECT COUNT(*) AS c FROM gateway_groups ${clause}`)
      .get(...params).c;

    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
    const page = Math.max(Number(opts.page) || 1, 1);
    const offset = (page - 1) * limit;

    const items = this.db
      .prepare(
        `SELECT * FROM gateway_groups ${clause}
         ORDER BY customer_name COLLATE NOCASE ASC, id ASC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    return { total, page, limit, items };
  }

  insert(row) {
    const info = this.db
      .prepare(
        `INSERT INTO gateway_groups
           (customer_id, customer_name, group_id, group_name, note, is_active)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(row.customerId),
        row.customerName || null,
        String(row.groupId),
        row.groupName || null,
        row.note || null,
        row.isActive === false ? 0 : 1
      );
    return this.findById(info.lastInsertRowid);
  }

  update(id, patch) {
    const fields = [];
    const params = [];
    const map = {
      customerId: 'customer_id',
      customerName: 'customer_name',
      groupId: 'group_id',
      groupName: 'group_name',
      note: 'note',
      isActive: 'is_active',
    };
    Object.entries(patch).forEach(([k, v]) => {
      const col = map[k];
      if (!col) return;
      fields.push(`${col} = ?`);
      params.push(k === 'isActive' ? (v ? 1 : 0) : v);
    });
    if (!fields.length) return this.findById(id);
    fields.push("updated_at = CURRENT_TIMESTAMP");
    params.push(Number(id));
    this.db.prepare(`UPDATE gateway_groups SET ${fields.join(', ')} WHERE id = ?`).run(
      ...params
    );
    return this.findById(id);
  }

  deactivate(id) {
    this.db
      .prepare(
        "UPDATE gateway_groups SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      )
      .run(Number(id));
    return this.findById(id);
  }

  countActive() {
    return this.db
      .prepare('SELECT COUNT(*) AS c FROM gateway_groups WHERE is_active = 1')
      .get().c;
  }

  countAll() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM gateway_groups').get().c;
  }
}

module.exports = GroupRepository;
