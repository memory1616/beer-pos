/**
 * Migration: Debt Management — Sổ công nợ Gia Huy (053)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Hệ thống hiện chỉ lưu số dư nợ trên `customers.debt` (dữ liệu NHẬP TAY,
 *  không truy vết được đơn hàng). Bảng `order_debts` / `debt_transactions` cũ
 *  đã tồn tại trong schema nhưng đang RỖNG (0 dòng) — chưa từng dùng thật.
 *
 *  Migration này dựng SỔ CÁI (ledger) mới làm nguồn sự thật:
 *    debt_accounts          — 1 tài khoản công nợ / khách hàng
 *    debt_transactions      — sổ cái append-only (không bao giờ xoá)
 *    debt_customer_groups   — mapping nhóm Zalo ↔ khách hàng
 *    debt_staff_permissions — phân quyền nhân viên ghi thanh toán
 *    debt_audit_logs        — audit log riêng của sổ công nợ
 *    debt_processed_events  — chống xử lý lại event (webhook lặp, restart)
 *    debt_bridge_events     — nhật ký adapter (Zalo / UI) — tách riêng để
 *                             thay adapter không phải sửa Debt Service
 *
 *  ADDITIVE — KHÔNG sửa/xoá dữ liệu kinh doanh hiện có.
 *  Toàn bộ bảng mới có tiền tố `debt_` → không đụng bảng cũ.
 *  Rollback: chỉ gỡ 7 bảng mới, `customers`/`sales`/`order_debts`/`payments`
 *  được giữ nguyên.
 */

const migration = {
  id: 53,
  name: 'debt_management',

  up: (db) => {
    const log = (m) => {
      try {
        // eslint-disable-next-line no-console
        console.log(`[MIGRATION 053] ${m}`);
      } catch (_) {
        /* ignore */
      }
    };
    // ── 1. debt_accounts — 1 tài khoản công nợ / khách hàng ─────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS debt_accounts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id     INTEGER NOT NULL UNIQUE,
        opening_balance REAL NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'active',
        created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_accounts_customer
      ON debt_accounts(customer_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_accounts_status
      ON debt_accounts(status)
    `);

    // ── 2. debt_transactions — SỔ CÁI append-only ───────────────────────────
    // amount luôn > 0; DẤU (tăng/giảm công nợ) do `direction` quyết định:
    //   INCREASE : OPENING_BALANCE | ORDER_DEBT | MANUAL_DEBT | ADJUSTMENT(+)
    //   DECREASE : PAYMENT | ADJUSTMENT(-) | REVERSAL(đảo bút toán tăng)
    // REVERSAL mang amount của giao dịch bị đảo, cùng reference tới bút toán gốc.
    // ── 2. debt_transactions — SỔ CÁI append-only ───────────────────────────
    // amount luôn > 0; DẤU (tăng/giảm công nợ) do `direction` quyết định:
    //   INCREASE : OPENING_BALANCE | ORDER_DEBT | MANUAL_DEBT | ADJUSTMENT(+)
    //   DECREASE : PAYMENT | ADJUSTMENT(-) | REVERSAL(đảo bút toán tăng)
    // REVERSAL mang amount của giao dịch bị đảo, cùng reference tới bút toán gốc.
    //
    // ⚠️ XUNG ĐỘT LỊCH SỬ: bảng `debt_transactions` đã tồn tại từ migration
    // 004/048 với schema LEGACY (`type`, `sale_id`, `payment_id`, `note`).
    // Bảng legacy đang RỖNG (0 dòng) nhưng `src/services/DebtService.js` vẫn
    // ghi vào nó → nếu dùng `CREATE TABLE IF NOT EXISTS` thì schema MỚI sẽ
    // KHÔNG được tạo và mọi INSERT của ledger mới sẽ lỗi (thiếu cột).
    //
    // XỬ LÝ AN TOÀN (additive, không mất dữ liệu):
    //   - Nếu `debt_transactions` tồn tại với schema LEGACY → ĐỔI TÊN thành
    //     `debt_transactions_legacy` (giữ nguyên toàn bộ dữ liệu + index).
    //   - Sau đó tạo bảng `debt_transactions` mới theo schema sổ cái.
    //   - Bảng legacy vẫn tồn tại để rollback/đối soát, không bị xoá.
    const legacyTbl = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='debt_transactions'`
      )
      .get();

    if (legacyTbl) {
      const cols = db
        .prepare('PRAGMA table_info(debt_transactions)')
        .all()
        .map((c) => c.name);
      const isLegacy = cols.includes('type') && !cols.includes('transaction_type');

      if (isLegacy) {
        const legacyExists = db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='debt_transactions_legacy'`
          )
          .get();

        if (!legacyExists) {
          db.exec('ALTER TABLE debt_transactions RENAME TO debt_transactions_legacy');
          log('  Renamed legacy `debt_transactions` → `debt_transactions_legacy`');
        } else {
          // Cả hai đều tồn tại: bảng hiện tại vẫn là legacy → gộp phần còn lại
          // vào bảng legacy (không mất dữ liệu) rồi mới tạo bảng mới.
          db.exec(
            `INSERT INTO debt_transactions_legacy
               (id, customer_id, type, amount, balance_before, balance_after,
                sale_id, payment_id, note, created_at)
             SELECT id, customer_id, type, amount, balance_before, balance_after,
                    sale_id, payment_id, note, created_at
               FROM debt_transactions
              WHERE id NOT IN (SELECT id FROM debt_transactions_legacy)`
          );
          db.exec('DROP TABLE debt_transactions');
          log('  Merged legacy rows into `debt_transactions_legacy`');
        }
      }
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS debt_transactions (
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
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
        CHECK (amount > 0),
        CHECK (direction IN ('INCREASE','DECREASE')),
        CHECK (transaction_type IN (
          'OPENING_BALANCE','ORDER_DEBT','MANUAL_DEBT',
          'PAYMENT','ADJUSTMENT','REVERSAL'
        ))
      )
    `);
    // Truy vấn chính: lịch sử công nợ 1 khách (mới nhất trước)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_tx_customer_created
      ON debt_transactions(customer_id, created_at DESC)
    `);
    // Đối soát: gom theo transaction_type
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_tx_type
      ON debt_transactions(transaction_type)
    `);
    // Tra cứu theo đơn hàng (ORDER_DEBT / PAYMENT gắn với sale_id)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_tx_reference
      ON debt_transactions(reference_type, reference_id)
    `);
    // Truy vết nguồn ghi (POS / ZALO / MANUAL_UI / MIGRATION / RECONCILIATION)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_tx_source
      ON debt_transactions(source)
    `);

    // ── 3. debt_customer_groups — mapping nhóm Zalo ↔ khách hàng ────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS debt_customer_groups (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        platform    TEXT NOT NULL,
        group_id    TEXT NOT NULL,
        group_name  TEXT,
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
      )
    `);
    // Một group chỉ liên kết tới 1 khách (chống tra cứu mơ hồ)
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_groups_platform_gid
      ON debt_customer_groups(platform, group_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_groups_customer
      ON debt_customer_groups(customer_id)
    `);

    // ── 4. debt_staff_permissions — phân quyền nhân viên ────────────────────
    // staff_id = username trong `app_users` (quyết định đã chốt: app_users).
    db.exec(`
      CREATE TABLE IF NOT EXISTS debt_staff_permissions (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        staff_id           TEXT NOT NULL,
        customer_id        INTEGER NOT NULL,
        can_record_payment INTEGER NOT NULL DEFAULT 1,
        status             TEXT NOT NULL DEFAULT 'active',
        created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_perm_staff_cust
      ON debt_staff_permissions(staff_id, customer_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_perm_customer
      ON debt_staff_permissions(customer_id)
    `);

    // ── 5. debt_audit_logs — audit log riêng của sổ công nợ ─────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS debt_audit_logs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER,
        action         TEXT NOT NULL,
        actor_id       TEXT,
        before_data    TEXT,
        after_data     TEXT,
        created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_audit_transaction
      ON debt_audit_logs(transaction_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_audit_created
      ON debt_audit_logs(created_at DESC)
    `);

    // ── 6. debt_processed_events — chống xử lý lại ──────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS debt_processed_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type   TEXT NOT NULL,
        event_id     TEXT NOT NULL,
        processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (event_type, event_id)
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_events_processed
      ON debt_processed_events(processed_at)
    `);

    // ── 7. debt_bridge_events — nhật ký adapter (Zalo / UI) ─────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS debt_bridge_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        platform    TEXT NOT NULL,
        group_id    TEXT,
        sender_id   TEXT,
        message_id  TEXT,
        content     TEXT,
        received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status      TEXT NOT NULL DEFAULT 'received',
        result      TEXT
      )
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_bridge_msg
      ON debt_bridge_events(platform, message_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_bridge_group
      ON debt_bridge_events(group_id)
    `);

    // ── 8. Seed setting cho module sổ công nợ ──────────────────────────────
    const defaults = [
      // Đơn vị nhập lệnh `+`/`-` (nghìn đồng) — mặc định 1 nghìn = 1.000đ
      ['debt_command_unit', '1000'],
      // Giới hạn 1 lệnh (nghìn đồng) — 100.000 nghìn = 100.000.000đ
      ['debt_command_max_amount', '100000'],
      // Chính sách đơn giao một phần: 'NONE' (chỉ ghi khi DELIVERED sạch)
      //                            | 'PROPORTIONAL' (ghi theo tỉ lệ giao thực tế)
      ['debt_partial_delivery_policy', 'NONE'],
      // Cho phép ghi PAYMENT vượt số dư nợ — quyết định đã chốt: KHÔNG
      ['debt_allow_overpayment', '0'],
      // Trạng thái adapter Zalo cá nhân (NOT_AVAILABLE theo audit)
      ['debt_zalo_bridge_status', 'NOT_AVAILABLE'],
      // Tự động ghi nợ cho MỌI đơn đã giao (0 = chỉ đơn có cờ bán chịu)
      ['debt_auto_record_on_delivered', '0'],
    ];

    const insertSetting = db.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    defaults.forEach(([key, value]) => insertSetting.run(key, value));
  },

  down: (db) => {
    // Rollback an toàn: chỉ gỡ 7 bảng MỚI.
    // KHÔNG đụng customers / sales / order_debts / payments / debt_transactions(cũ).
    const tables = [
      'debt_bridge_events',
      'debt_processed_events',
      'debt_audit_logs',
      'debt_staff_permissions',
      'debt_customer_groups',
      'debt_transactions',
      'debt_accounts',
    ];
    for (const t of tables) {
      db.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    const stmt = db.prepare('DELETE FROM settings WHERE key = ?');
    [
      'debt_command_unit',
      'debt_command_max_amount',
      'debt_partial_delivery_policy',
      'debt_allow_overpayment',
      'debt_zalo_bridge_status',
      'debt_auto_record_on_delivered',
    ].forEach((key) => stmt.run(key));
  },
};

module.exports = migration;
