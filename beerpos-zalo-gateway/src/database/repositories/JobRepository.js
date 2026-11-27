const { getDb } = require('../connection');

const JOB_STATUS = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  SENT: 'sent',
  RETRY: 'retry',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
  NO_GROUP: 'no_group',
  CANCELLED: 'cancelled',
};

class JobRepository {
  constructor(db) {
    this.db = db || getDb();
  }

  findById(id) {
    return this.db.prepare('SELECT * FROM gateway_jobs WHERE id = ?').get(Number(id)) || null;
  }

  findByIdempotencyKey(key) {
    return (
      this.db.prepare('SELECT * FROM gateway_jobs WHERE idempotency_key = ?').get(String(key)) ||
      null
    );
  }

  insert(row) {
    const info = this.db
      .prepare(
        `INSERT INTO gateway_jobs
           (idempotency_key, payment_id, customer_id, customer_name,
            group_id, group_name, message_content, provider,
            status, max_attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(row.idempotencyKey),
        row.paymentId || null,
        String(row.customerId),
        row.customerName || null,
        String(row.groupId),
        row.groupName || null,
        String(row.messageContent),
        String(row.provider),
        row.status || JOB_STATUS.QUEUED,
        Number(row.maxAttempts) || 4
      );
    return this.findById(info.lastInsertRowid);
  }

  /**
   * Lay job de xu ly (lease). Dung UPDATE ... WHERE de tranh hai worker
   * cung lay 1 job.
   */
  leaseJobs(opts = {}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 1, 1), 50);
    const workerId = String(opts.workerId || 'worker');
    const leaseSeconds = Math.max(Number(opts.leaseSeconds) || 60, 5);

    const candidates = this.db
      .prepare(
        `SELECT id FROM gateway_jobs
         WHERE status IN ('queued', 'retry')
           AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP)
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(limit);

    const claimed = [];
    const claim = this.db.prepare(
      `UPDATE gateway_jobs
       SET status = 'processing',
           locked_at = CURRENT_TIMESTAMP,
           locked_until = datetime('now', ?),
           locked_by = ?,
           attempts = attempts + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN ('queued', 'retry')`
    );

    candidates.forEach((c) => {
      const res = claim.run(`+${leaseSeconds} seconds`, workerId, c.id);
      if (res.changes === 1) claimed.push(this.findById(c.id));
    });

    return claimed.filter(Boolean);
  }

  /** Job processing bi treo (lease het han) -> queued lai. */
  recoverStaleJobs() {
    const res = this.db
      .prepare(
        `UPDATE gateway_jobs
         SET status = 'queued',
             locked_at = NULL,
             locked_until = NULL,
             locked_by = NULL,
             next_retry_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE status = 'processing'
           AND locked_until IS NOT NULL
           AND locked_until < CURRENT_TIMESTAMP`
      )
      .run();
    return res.changes;
  }

  markSent(id, opts = {}) {
    this.db
      .prepare(
        `UPDATE gateway_jobs
         SET status = 'sent',
             last_error = NULL,
             provider_response = ?,
             locked_at = NULL,
             locked_until = NULL,
             locked_by = NULL,
             next_retry_at = NULL,
             processed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(opts.providerResponse ? JSON.stringify(opts.providerResponse) : null, Number(id));
    return this.findById(id);
  }

  markFailed(id, opts = {}) {
    this.db
      .prepare(
        `UPDATE gateway_jobs
         SET status = 'failed',
             last_error = ?,
             provider_response = ?,
             locked_at = NULL,
             locked_until = NULL,
             locked_by = NULL,
             next_retry_at = NULL,
             processed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(
        opts.error || null,
        opts.providerResponse ? JSON.stringify(opts.providerResponse) : null,
        Number(id)
      );
    return this.findById(id);
  }

  markUnknown(id, opts = {}) {
    this.db
      .prepare(
        `UPDATE gateway_jobs
         SET status = 'unknown',
             last_error = ?,
             provider_response = ?,
             locked_at = NULL,
             locked_until = NULL,
             locked_by = NULL,
             next_retry_at = NULL,
             processed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(
        opts.error || null,
        opts.providerResponse ? JSON.stringify(opts.providerResponse) : null,
        Number(id)
      );
    return this.findById(id);
  }

  /** Chuyen sang retry, tinh next_retry_at theo backoff. */
  markRetry(id, opts = {}) {
    const delaySeconds = Math.max(Number(opts.delaySeconds) || 10, 1);
    this.db
      .prepare(
        `UPDATE gateway_jobs
         SET status = 'retry',
             last_error = ?,
             provider_response = ?,
             next_retry_at = datetime('now', ?),
             locked_at = NULL,
             locked_until = NULL,
             locked_by = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(
        opts.error || null,
        opts.providerResponse ? JSON.stringify(opts.providerResponse) : null,
        `+${delaySeconds} seconds`,
        Number(id)
      );
    return this.findById(id);
  }

  requeue(id) {
    this.db
      .prepare(
        `UPDATE gateway_jobs
         SET status = 'queued',
             attempts = 0,
             next_retry_at = NULL,
             last_error = NULL,
             locked_at = NULL,
             locked_until = NULL,
             locked_by = NULL,
             processed_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(Number(id));
    return this.findById(id);
  }

  cancel(id) {
    this.db
      .prepare(
        `UPDATE gateway_jobs
         SET status = 'cancelled',
             locked_at = NULL,
             locked_until = NULL,
             locked_by = NULL,
             next_retry_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(Number(id));
    return this.findById(id);
  }

  list(opts = {}) {
    const where = [];
    const params = [];

    if (opts.status) {
      const statuses = String(opts.status)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (statuses.length) {
        where.push(`status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
    }
    if (opts.customerId) {
      where.push('customer_id = ?');
      params.push(String(opts.customerId));
    }
    if (opts.paymentId) {
      where.push('payment_id = ?');
      params.push(String(opts.paymentId));
    }
    if (opts.from) {
      where.push('created_at >= ?');
      params.push(String(opts.from));
    }
    if (opts.to) {
      where.push('created_at <= ?');
      params.push(String(opts.to));
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db
      .prepare(`SELECT COUNT(*) AS c FROM gateway_jobs ${clause}`)
      .get(...params).c;

    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
    const page = Math.max(Number(opts.page) || 1, 1);
    const offset = (page - 1) * limit;

    const items = this.db
      .prepare(
        `SELECT * FROM gateway_jobs ${clause}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    return { total, page, limit, items };
  }

  countByStatus(status) {
    return this.db
      .prepare('SELECT COUNT(*) AS c FROM gateway_jobs WHERE status = ?')
      .get(String(status)).c;
  }

  countsByStatus() {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS c FROM gateway_jobs GROUP BY status')
      .all();
    const out = {};
    Object.values(JOB_STATUS).forEach((s) => {
      out[s] = 0;
    });
    rows.forEach((r) => {
      out[r.status] = r.c;
    });
    return out;
  }
}

module.exports = JobRepository;
module.exports.JOB_STATUS = JOB_STATUS;
