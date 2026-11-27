/**
 * Migration: Hàng đợi thông báo công nợ + ràng buộc 1 khách ↔ 1 nhóm Zalo (069)
 * ─────────────────────────────────────────────────────────────────────────────
 * BỐI CẢNH:
 *  BeerPOS hiện gửi tin thông báo công nợ qua OmniCall theo kiểu
 *  "fire-and-forget" (DebtNotifyService.notifyPaymentAsync). Hệ quả:
 *   - Tiến trình bị kết thúc (script CLI, restart server) → tin mất im lặng.
 *   - Không có retry có kiểm soát, không có idempotency chắc chắn.
 *   - Không tách được "nghiệp vụ" khỏi "phương thức gửi tin" (đang gọi thẳng
 *     OmniCallService trong DebtNotifyService).
 *
 * GIẢI PHÁP:
 *  1. Tạo bảng `debt_notification_jobs` — hàng đợi bền vững (durable queue)
 *     theo mô hình transactional outbox:
 *       • Ghi job TRONG CÙNG transaction với bút toán thanh toán (nếu có thể),
 *         hoặc ngay sau khi transaction commit (fallback + reconciliation).
 *       • Worker đọc job theo lease (locked_until) → gửi → cập nhật trạng thái.
 *       • Retry exponential backoff, có giới hạn (mặc định 5 lần).
 *       • Idempotency key UNIQUE theo (transaction_id, event_type, group_id).
 *  2. Ràng buộc 1:1 cho `debt_customer_groups`:
 *       • UNIQUE(platform, customer_id)  → 1 khách chỉ có 1 nhóm.
 *       • UNIQUE(platform, group_id)     → 1 nhóm chỉ thuộc 1 khách (đã có sẵn).
 *     ⚠️ TRƯỚC KHI tạo unique index → kiểm tra dữ liệu trùng. Nếu có bản ghi
 *     trùng → KHÔNG tạo index, ghi log cảnh báo, KHÔNG xoá/gộp dữ liệu.
 *  3. Bổ sung cột liên kết (nullable, tương thích ngược) cho
 *     `debt_notifications` để liên kết lịch sử gửi với job:
 *       • `job_id` INTEGER, `provider` TEXT, `delivery_status` TEXT.
 *     Bảng lịch sử CŨ giữ nguyên toàn bộ dữ liệu & API cũ vẫn chạy.
 *
 * ADDITIVE — KHÔNG sửa/xoá dữ liệu kinh doanh hiện có.
 * Rollback: chỉ gỡ bảng mới + cột mới + index mới (an toàn, không mất lịch sử).
 */

const migration = {
  id: 69,
  name: 'debt_notification_jobs',

  up: (db) => {
    const log = (m) => {
      try {
        // eslint-disable-next-line no-console
        console.log(`[MIGRATION 069] ${m}`);
      } catch (_) {
        /* ignore */
      }
    };

    // ══════════════════════════════════════════════════════════════════════
    // 1. debt_notification_jobs — hàng đợi bền vững (outbox)
    // ══════════════════════════════════════════════════════════════════════
    db.exec(`
      CREATE TABLE IF NOT EXISTS debt_notification_jobs (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id        INTEGER,
        customer_name      TEXT,
        -- id bút toán thanh toán trong debt_transactions (nguồn sự kiện)
        transaction_id     INTEGER,
        event_type         TEXT NOT NULL DEFAULT 'payment',
        -- GROUP ID là định danh chính khi gửi tin (snapshot tại thời điểm tạo job)
        group_id           TEXT,
        group_name_snapshot TEXT,
        -- nội dung tin nhắn (snapshot — retry KHÔNG dựng lại từ số dư mới)
        content_snapshot   TEXT,
        amount             REAL DEFAULT 0,
        applied_amount     REAL DEFAULT 0,
        credit_amount      REAL DEFAULT 0,
        balance_before     REAL DEFAULT 0,
        balance_after      REAL DEFAULT 0,
        provider           TEXT NOT NULL DEFAULT 'mock',
        status             TEXT NOT NULL DEFAULT 'queued',
        attempts           INTEGER NOT NULL DEFAULT 0,
        max_attempts       INTEGER NOT NULL DEFAULT 5,
        next_retry_at      TEXT,
        locked_until       TEXT,
        locked_by          TEXT,
        last_error         TEXT,
        last_error_code    TEXT,
        provider_message_id TEXT,
        delivery_status    TEXT,
        source             TEXT,
        -- idempotency: transaction_id + event_type + group_id
        idempotency_key    TEXT UNIQUE,
        sent_at            TEXT,
        created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Index phục vụ worker (status + next_retry_at), tra cứu theo khách,
    // theo bút toán, và sắp xếp mới nhất.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_notify_jobs_status
      ON debt_notification_jobs(status, next_retry_at)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_notify_jobs_retry
      ON debt_notification_jobs(next_retry_at)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_notify_jobs_customer
      ON debt_notification_jobs(customer_id, created_at DESC)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_notify_jobs_tx
      ON debt_notification_jobs(transaction_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_notify_jobs_created
      ON debt_notification_jobs(created_at DESC)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_notify_jobs_lock
      ON debt_notification_jobs(locked_until)
    `);

    // ══════════════════════════════════════════════════════════════════════
    // 2. Ràng buộc 1:1 — debt_customer_groups
    // ══════════════════════════════════════════════════════════════════════
    // ⚠️ CHỈ tạo unique index khi dữ liệu KHÔNG trùng. Nếu trùng → bỏ qua,
    //    ghi cảnh báo, KHÔNG tự ý xoá/gộp dữ liệu.
    const dupCustomer = db
      .prepare(
        `SELECT customer_id, platform, COUNT(*) AS c,
                GROUP_CONCAT(id) AS ids, GROUP_CONCAT(group_id) AS gids
           FROM debt_customer_groups
          GROUP BY platform, customer_id
         HAVING c > 1`
      )
      .all();
    const dupGroup = db
      .prepare(
        `SELECT group_id, platform, COUNT(*) AS c,
                GROUP_CONCAT(id) AS ids, GROUP_CONCAT(customer_id) AS custs
           FROM debt_customer_groups
          GROUP BY platform, group_id
         HAVING c > 1`
      )
      .all();

    if (dupCustomer.length) {
      log(
        `⚠️ CÓ DỮ LIỆU TRÙNG customer_id — KHÔNG tạo unique index 1:1. Chi tiết: ${JSON.stringify(
          dupCustomer
        )}`
      );
    }
    if (dupGroup.length) {
      log(
        `⚠️ CÓ DỮ LIỆU TRÙNG group_id — KHÔNG tạo unique index 1:1. Chi tiết: ${JSON.stringify(
          dupGroup
        )}`
      );
    }

    if (!dupCustomer.length && !dupGroup.length) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_groups_platform_customer
        ON debt_customer_groups(platform, customer_id)
      `);
      log('✅ Đã tạo unique index 1:1 (platform, customer_id)');
    }

    // ══════════════════════════════════════════════════════════════════════
    // 3. debt_notifications — bổ sung cột liên kết job (nullable, tương thích)
    // ══════════════════════════════════════════════════════════════════════
    const notifCols = db.prepare('PRAGMA table_info(debt_notifications)').all().map((c) => c.name);
    const addCol = (col, ddl) => {
      if (!notifCols.includes(col)) {
        db.exec(`ALTER TABLE debt_notifications ADD COLUMN ${col} ${ddl}`);
        log(`  + debt_notifications.${col}`);
      }
    };
    addCol('job_id', 'INTEGER');
    addCol('provider', 'TEXT');
    addCol('delivery_status', 'TEXT');

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_notifications_job
      ON debt_notifications(job_id)
    `);

    // ══════════════════════════════════════════════════════════════════════
    // 4. Seed settings cho hệ thống thông báo
    // ══════════════════════════════════════════════════════════════════════
    const defaults = [
      // Provider đang dùng: 'mock' (local) | 'omicall' (production hiện tại)
      // ⚠️ Mặc định 'omicall' để GIỮ NGUYÊN hành vi production khi deploy.
      //    Muốn chạy local thì đặt NOTIFICATION_PROVIDER=mock hoặc sửa ở UI.
      ['debt_notify_provider', 'omicall'],
      // Bật/tắt worker nền
      ['debt_notify_worker_enabled', '1'],
      // Số lần retry tối đa
      ['debt_notify_retry_max_attempts', '5'],
      // Độ trễ retry cơ sở (ms) — exponential backoff
      ['debt_notify_retry_base_delay_ms', '60000'],
      // Số job xử lý mỗi vòng
      ['debt_notify_job_batch_size', '10'],
      // Chu kỳ quét worker (ms)
      ['debt_notify_worker_interval_ms', '15000'],
      // Thời hạn lease job (ms) — job "processing" quá hạn được phục hồi
      ['debt_notify_job_lease_ms', '120000'],
    ];

    const insertSetting = db.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    defaults.forEach(([key, value]) => insertSetting.run(key, value));
  },

  down: (db) => {
    try {
      db.exec('DROP INDEX IF EXISTS idx_debt_notifications_job');
      db.exec('DROP TABLE IF EXISTS debt_notification_jobs');
      db.exec('DROP INDEX IF EXISTS idx_debt_groups_platform_customer');

      const cols = db.prepare('PRAGMA table_info(debt_notifications)').all().map((c) => c.name);
      const dropCol = (col) => {
        if (cols.includes(col)) {
          try {
            db.exec(`ALTER TABLE debt_notifications DROP COLUMN ${col}`);
          } catch (_) {
            /* rollback best-effort */
          }
        }
      };
      dropCol('delivery_status');
      dropCol('provider');
      dropCol('job_id');

      const stmt = db.prepare('DELETE FROM settings WHERE key = ?');
      [
        'debt_notify_provider',
        'debt_notify_worker_enabled',
        'debt_notify_retry_max_attempts',
        'debt_notify_retry_base_delay_ms',
        'debt_notify_job_batch_size',
        'debt_notify_worker_interval_ms',
        'debt_notify_job_lease_ms',
      ].forEach((key) => stmt.run(key));
    } catch (_) {
      /* rollback best-effort */
    }
  },
};

module.exports = migration;
