/**
 * Migration 001 — init
 * ─────────────────────────────────────────────────────────────────────────────
 * Tao toan bo schema cho BeerPOS Zalo Gateway.
 *
 *  - gateway_settings     : cau hinh khong nhay cam (KHONG luu API key)
 *  - gateway_account      : 1 tai khoan Zalo (id = 1)
 *  - gateway_groups       : mapping 1 khach hang <-> 1 nhom Zalo
 *  - gateway_jobs         : hang doi thong bao (persistent, DB-backed)
 *  - gateway_messages     : lich su TUNG LAN THU gui tin
 *  - gateway_audit_logs   : nhat ky thao tac quan trong
 *
 *  ADDITIVE — tao bang moi, khong dung vao database nao khac.
 */

const migration = {
  version: 1,
  name: 'init',

  up: (db) => {
    // ── 1. gateway_settings ──────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_settings (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key        TEXT NOT NULL UNIQUE,
        value      TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── 2. gateway_account ───────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_account (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        provider        TEXT NOT NULL DEFAULT 'mock',
        display_name    TEXT NOT NULL DEFAULT 'Tai khoan Zalo chinh',
        status          TEXT NOT NULL DEFAULT 'not_configured',
        connection_mode TEXT NOT NULL DEFAULT 'mock',
        last_checked_at TEXT,
        last_error      TEXT,
        created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── 3. gateway_groups ────────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_groups (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id   TEXT    NOT NULL,
        customer_name TEXT,
        group_id      TEXT    NOT NULL CHECK (length(trim(group_id)) > 0),
        group_name    TEXT,
        note          TEXT,
        is_active     INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // 1 khach hang chi co 1 nhom
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_groups_customer
      ON gateway_groups(customer_id)
    `);
    // 1 nhom chi thuoc 1 khach hang
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_groups_group
      ON gateway_groups(group_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_groups_active
      ON gateway_groups(is_active)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_groups_name
      ON gateway_groups(customer_name)
    `);

    // ── 4. gateway_jobs ──────────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_jobs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key   TEXT    NOT NULL UNIQUE,
        payment_id        TEXT,
        customer_id       TEXT    NOT NULL,
        customer_name     TEXT,
        group_id          TEXT    NOT NULL,
        group_name        TEXT,
        message_content   TEXT    NOT NULL,
        provider          TEXT    NOT NULL,
        status            TEXT    NOT NULL DEFAULT 'queued',
        attempts          INTEGER NOT NULL DEFAULT 0,
        max_attempts      INTEGER NOT NULL DEFAULT 4,
        next_retry_at     TEXT,
        locked_at         TEXT,
        locked_until      TEXT,
        locked_by         TEXT,
        last_error        TEXT,
        provider_response TEXT,
        created_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at      TEXT
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_jobs_status
      ON gateway_jobs(status)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_jobs_retry
      ON gateway_jobs(next_retry_at)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_jobs_payment
      ON gateway_jobs(payment_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_jobs_customer
      ON gateway_jobs(customer_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_jobs_created
      ON gateway_jobs(created_at)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_jobs_locked
      ON gateway_jobs(locked_until)
    `);

    // ── 5. gateway_messages ──────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_messages (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id           INTEGER NOT NULL,
        provider         TEXT    NOT NULL,
        request_payload  TEXT,
        response_payload TEXT,
        status           TEXT    NOT NULL,
        error_message    TEXT,
        started_at       TEXT,
        completed_at     TEXT,
        created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (job_id) REFERENCES gateway_jobs(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_messages_job
      ON gateway_messages(job_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_messages_status
      ON gateway_messages(status)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_messages_created
      ON gateway_messages(created_at)
    `);

    // ── 6. gateway_audit_logs ────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_audit_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        action      TEXT NOT NULL,
        entity_type TEXT,
        entity_id   TEXT,
        details     TEXT,
        created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_audit_action
      ON gateway_audit_logs(action)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_gateway_audit_created
      ON gateway_audit_logs(created_at)
    `);

    // ── Seed ─────────────────────────────────────────────────────────────────
    db.prepare(
      `INSERT OR IGNORE INTO gateway_account
         (id, provider, display_name, status, connection_mode)
       VALUES (1, 'mock', 'Tai khoan Zalo chinh', 'not_configured', 'mock')`
    ).run();

    const insertSetting = db.prepare(
      'INSERT OR IGNORE INTO gateway_settings (key, value) VALUES (?, ?)'
    );
    [
      ['provider', 'mock'],
      ['worker_enabled', '1'],
      ['worker_interval_ms', '2000'],
      ['worker_max_attempts', '4'],
      ['retry_delays_ms', '10000,30000,120000,300000'],
      ['max_message_length', '2000'],
      ['title', 'Cap nhat cong no'],
    ].forEach(([k, v]) => insertSetting.run(k, v));
  },

  down: (db) => {
    [
      'gateway_audit_logs',
      'gateway_messages',
      'gateway_jobs',
      'gateway_groups',
      'gateway_account',
      'gateway_settings',
    ].forEach((t) => db.exec(`DROP TABLE IF EXISTS ${t}`));
  },
};

module.exports = migration;
