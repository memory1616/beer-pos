const { getDb } = require('../connection');

/** Repository cho bang gateway_messages (lich su tung lan thu). */
class MessageRepository {
  constructor(db) {
    this.db = db || getDb();
  }

  insert(row) {
    const info = this.db
      .prepare(
        `INSERT INTO gateway_messages
           (job_id, provider, request_payload, response_payload,
            status, error_message, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        Number(row.jobId),
        String(row.provider),
        row.requestPayload ? JSON.stringify(row.requestPayload) : null,
        row.responsePayload ? JSON.stringify(row.responsePayload) : null,
        String(row.status),
        row.errorMessage || null,
        row.startedAt || null,
        row.completedAt || null
      );
    return this.db
      .prepare('SELECT * FROM gateway_messages WHERE id = ?')
      .get(info.lastInsertRowid);
  }

  listByJob(jobId) {
    return this.db
      .prepare('SELECT * FROM gateway_messages WHERE job_id = ? ORDER BY id ASC')
      .all(Number(jobId));
  }

  countAll() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM gateway_messages').get().c;
  }
}

module.exports = MessageRepository;
