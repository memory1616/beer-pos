/**
 * Migration: Sepay — gạch nợ công nợ tự động (061)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Khách hàng chuyển tiền trực tiếp vào tài khoản ngân hàng liên kết với
 *  Sepay. Trước đây mọi giao dịch vào phải nhân viên nhập tay → sai sót,
 *  chậm, và không gạch được nợ tự động.
 *
 *  Module này dựng nền tảng để:
 *   1. LƯU MỌI giao dịch Sepay vào DB (kể cả khi chưa gạch nợ) → làm căn cứ
 *      đối soát, không bỏ sót.
 *   2. Gắn mã định danh khách hàng (`debt_code`) vào nội dung chuyển khoản
 *      → khi khách chuyển, hệ thống tự biết tiền của ai.
 *   3. Lưu kết quả gạch nợ (bút toán ledger đã tạo) để không gạch 2 lần.
 *
 *  Thiết kế:
 *  - ADDITIVE — không sửa/xoá dữ liệu kinh doanh hiện có.
 *  - Tên bảng có tiền tố `sepay_` → không đụng bảng cũ.
 *  - `debt_code` UNIQUE (NULL được phép nhiều lần) → mỗi khách 1 mã.
 *  - `sepay_transactions.sepay_id` UNIQUE → chống ghi trùng khi webhook retry
 *    (Sepay giữ nguyên `id` qua mọi lần retry/replay).
 *
 *  Rollback: chỉ gỡ 2 bảng mới + cột `debt_code`, không đụng dữ liệu khác.
 */

const migration = {
  id: 61,
  name: 'sepay_debt_settlement',

  up: (db) => {
    const hasColumn = (table, col) => {
      try {
        return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
      } catch (_) {
        return false;
      }
    };

    // ── 1. customers.debt_code — mã định danh nhúng vào nội dung CK ────────
    //    Dạng sinh tự động: KH0001, KH0002... (nhân viên có thể sửa).
    //    NULL = chưa có mã → khách đó chưa dùng được tự động gạch nợ.
    if (!hasColumn('customers', 'debt_code')) {
      db.exec(`ALTER TABLE customers ADD COLUMN debt_code TEXT`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_debt_code ON customers(debt_code)`);

    // ── 1b. Thêm loại bút toán `CREDIT` (tiền khách nợ lại) ─────────────────
    //    Bảng `debt_transactions` có CHECK constraint cứng trên `transaction_type`.
    //    SQLite KHÔNG hỗ trợ ALTER CHECK → phải REBUILD bảng.
    //
    //    AN TOÀN:
    //    - KHÔNG bảng nào có FK tham chiếu tới `debt_transactions`
    //      (`debt_audit_logs.transaction_id` chỉ là INTEGER thường) → rename
    //      bảng KHÔNG phá vỡ tham chiếu nào.
    //    - Toàn bộ dữ liệu được COPY sang bảng mới, không mất dòng nào.
    //    - Idempotent: nếu `CREDIT` đã có trong CHECK → bỏ qua.
    //    - Nếu rebuild lỗi → rollback tên bảng, hệ thống vẫn chạy với schema cũ.
    try {
      const ddl = db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='debt_transactions'`
        )
        .get();
      const tableSql = (ddl && ddl.sql) || '';

      if (tableSql && !/'CREDIT'/.test(tableSql)) {
        const cols = db.prepare('PRAGMA table_info(debt_transactions)').all();
        const hasBusinessDate = cols.some((c) => c.name === 'business_date');

        const tx = db.transaction(() => {
          db.exec(`ALTER TABLE debt_transactions RENAME TO debt_transactions_pre061`);
          db.exec(`
            CREATE TABLE debt_transactions (
              id               INTEGER PRIMARY KEY AUTOINCREMENT,
              customer_id      INTEGER NOT NULL,
              transaction_type TEXT NOT NULL,
              amount           REAL NOT NULL,
              direction        TEXT NOT NULL DEFAULT 'INCREASE',
              balance_before   REAL NOT NULL,
              balance_after    REAL NOT NULL,
              reference_type   TEXT,
              reference_id     TEXT,
              description      TEXT,
              created_by       TEXT,
              source           TEXT NOT NULL DEFAULT 'POS',
              idempotency_key  TEXT UNIQUE,
              created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              business_date    TEXT,
              FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
              CHECK (amount > 0),
              CHECK (direction IN ('INCREASE','DECREASE')),
              CHECK (transaction_type IN (
                'OPENING_BALANCE','ORDER_DEBT','MANUAL_DEBT',
                'PAYMENT','ADJUSTMENT','REVERSAL','CREDIT'
              ))
            )
          `);
          db.exec(`
            INSERT INTO debt_transactions
              (id, customer_id, transaction_type, amount, direction,
               balance_before, balance_after, reference_type, reference_id,
               description, created_by, source, idempotency_key, created_at
               ${hasBusinessDate ? ', business_date' : ''})
            SELECT
              id, customer_id, transaction_type, amount, direction,
              balance_before, balance_after, reference_type, reference_id,
              description, created_by, source, idempotency_key, created_at
              ${hasBusinessDate ? ', business_date' : ''}
            FROM debt_transactions_pre061
          `);
          db.exec(`DROP TABLE debt_transactions_pre061`);
        });
        tx();

        // Tạo lại index (rename/drop bảng đã mất index)
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_debt_tx_customer_created
           ON debt_transactions(customer_id, created_at DESC)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_debt_tx_type
           ON debt_transactions(transaction_type)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_debt_tx_reference
           ON debt_transactions(reference_type, reference_id)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_debt_tx_source
           ON debt_transactions(source)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_debt_tx_business_date
           ON debt_transactions(business_date)`
        );
      }
    } catch (e) {
      // Rollback an toàn: nếu bảng mới tạo lỗi → đổi tên lại bảng cũ
      try {
        const hasNew = db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='debt_transactions_pre061'`
          )
          .get();
        if (hasNew) {
          db.exec(`DROP TABLE IF EXISTS debt_transactions`);
          db.exec(`ALTER TABLE debt_transactions_pre061 RENAME TO debt_transactions`);
        }
      } catch (_) {
        /* best-effort */
      }
    }

    // ── 2. sepay_transactions — nhật ký MỌI giao dịch từ Sepay ────────────
    //    status:
    //      pending  — mới nhận, chưa xử lý (chưa gạch nợ)
    //      matched  — đã tự khớp được khách + đã gạch nợ (hoặc ghi credit dư)
    //      manual   — chưa khớp được → cần nhân viên xử lý tay
    //      ignored  — đã bỏ qua (VD: tiền ra, giao dịch của hệ thống)
    //    Không bao giờ xoá dòng nào → append-only.
    db.exec(`
      CREATE TABLE IF NOT EXISTS sepay_transactions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        sepay_id          TEXT NOT NULL UNIQUE,
        gateway           TEXT,
        account_number    TEXT,
        sub_account       TEXT,
        code              TEXT,
        content           TEXT,
        description       TEXT,
        transfer_type     TEXT NOT NULL DEFAULT 'in',
        transfer_amount   REAL NOT NULL DEFAULT 0,
        accumulated       REAL DEFAULT 0,
        reference_code    TEXT,
        transaction_date  TEXT,
        customer_id       INTEGER,
        debt_code         TEXT,
        status            TEXT NOT NULL DEFAULT 'pending',
        applied_amount    REAL DEFAULT 0,
        credit_amount     REAL DEFAULT 0,
        debt_transaction_id INTEGER,
        note              TEXT,
        raw_payload       TEXT,
        created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at      TEXT,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sepay_tx_status
      ON sepay_transactions(status, created_at DESC)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sepay_tx_customer
      ON sepay_transactions(customer_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sepay_tx_date
      ON sepay_transactions(transaction_date)
    `);

    // ── 3. sepay_settings — cấu hình (bảng riêng cho secret) ───────────────
    //    Lưu API token + webhook secret. Hiển thị trong UI Cài đặt (ADMIN).
    db.exec(`
      CREATE TABLE IF NOT EXISTS sepay_settings (
        id                INTEGER PRIMARY KEY CHECK (id = 1),
        api_token         TEXT,
        webhook_secret    TEXT,
        bank_accounts     TEXT,
        payment_code_prefix TEXT DEFAULT 'DH',
        auto_settle       INTEGER NOT NULL DEFAULT 1,
        updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT single_row CHECK (id = 1)
      )
    `);
    db.exec(`
      INSERT OR IGNORE INTO sepay_settings (id, auto_settle)
      VALUES (1, 1)
    `);

    // ── 4. Backfill mã khách cho khách hiện có ────────────────────────────
    //    Chỉ gán cho khách chưa có mã + chưa bị archive. Idempotent.
    try {
      const rows = db
        .prepare(
          `SELECT id FROM customers
            WHERE archived = 0 AND (debt_code IS NULL OR debt_code = '')
            ORDER BY id ASC`
        )
        .all();

      const update = db.prepare('UPDATE customers SET debt_code = ? WHERE id = ?');
      let seq = 0;
      // Bắt đầu từ max hiện có để không trùng khi chạy lại
      const maxRow = db
        .prepare(
          `SELECT debt_code FROM customers
            WHERE debt_code IS NOT NULL AND debt_code LIKE 'KH%'
            ORDER BY debt_code DESC LIMIT 1`
        )
        .get();
      if (maxRow && maxRow.debt_code) {
        const n = parseInt(String(maxRow.debt_code).replace(/\D/g, ''), 10);
        if (!Number.isNaN(n)) seq = n;
      }

      for (const row of rows) {
        seq += 1;
        update.run('KH' + String(seq).padStart(4, '0'), row.id);
      }
    } catch (e) {
      // best-effort — không chặn migration
    }
  },

  down: (db) => {
    try {
      db.exec('DROP TABLE IF EXISTS sepay_transactions');
      db.exec('DROP TABLE IF EXISTS sepay_settings');
      db.exec('DROP INDEX IF EXISTS idx_customers_debt_code');
      db.exec('ALTER TABLE customers DROP COLUMN debt_code');
    } catch (_) {
      /* rollback best-effort */
    }
  },
};

module.exports = migration;
