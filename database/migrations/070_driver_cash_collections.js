/**
 * Migration: Thu tiền mặt của tài xế tại điểm giao (070)
 * ─────────────────────────────────────────────────────────────────────────────
 * BỐI CẢNH:
 *  Khi khách trả tiền mặt cho tài xế tại điểm giao:
 *   1. Tài xế nhận tiền mặt → ghi nhận vào sổ công nợ (bút toán PAYMENT,
 *      nguồn `DRIVER_CASH`; phần trả vượt → bút toán CREDIT).
 *   2. Cuối ngày cần biết tài xế đã thu bao nhiêu tiền mặt → báo cáo
 *      tổng hợp theo ngày nghiệp vụ.
 *
 * BẢNG MỚI:
 *  `driver_cash_collections` — mỗi lần tài xế nhận tiền mặt:
 *     • `collection_no` mã phiếu (TT-YYYYMMDD-XXXX) — chống ghi trùng.
 *     • `idempotency_key` UNIQUE — chống double-click / retry.
 *     • `applied_amount` / `credit_amount` — phần gạch nợ / phần khách
 *       trả vượt (tiền nộp trước).
 *     • `balance_before` / `balance_after` — số dư công nợ trước / sau.
 *     • `business_date` — ngày NGHIỆP VỤ (cutoff 19:00) để khớp KPI.
 *
 * ADDITIVE — KHÔNG sửa/xoá dữ liệu kinh doanh hiện có.
 * Rollback: chỉ gỡ bảng mới (an toàn, không mất lịch sử giao dịch).
 */

const migration = {
  id: 70,
  name: 'driver_cash_collections',

  up: (db) => {
    const log = (m) => {
      try {
        // eslint-disable-next-line no-console
        console.log(`[MIGRATION 070] ${m}`);
      } catch (_) {
        /* ignore */
      }
    };

    // ══════════════════════════════════════════════════════════════════════
    // driver_cash_collections — các lần thu tiền mặt của tài xế
    // ══════════════════════════════════════════════════════════════════════
    db.exec(`
      CREATE TABLE IF NOT EXISTS driver_cash_collections (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_no       TEXT NOT NULL UNIQUE,
        driver_username     TEXT NOT NULL,
        customer_id         INTEGER,
        customer_name       TEXT,
        sale_id             INTEGER,
        delivery_id         INTEGER,
        -- Số tiền mặt tài xế nhận (VND)
        amount              REAL NOT NULL DEFAULT 0,
        -- Phần được gạch vào công nợ (min(amount, số dư nợ trước))
        applied_amount      REAL NOT NULL DEFAULT 0,
        -- Phần khách trả vượt → bút toán CREDIT (tiền khách nộp trước)
        credit_amount       REAL NOT NULL DEFAULT 0,
        debt_transaction_id INTEGER,
        credit_transaction_id INTEGER,
        balance_before      REAL NOT NULL DEFAULT 0,
        balance_after       REAL NOT NULL DEFAULT 0,
        -- Ngày NGHIỆP VỤ (cutoff 19:00) — khớp KPI & báo cáo cuối ngày
        business_date       TEXT NOT NULL,
        note                TEXT,
        status              TEXT NOT NULL DEFAULT 'recorded',
        idempotency_key     TEXT UNIQUE,
        created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_driver_cash_collections_driver_date
      ON driver_cash_collections(driver_username, business_date)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_driver_cash_collections_customer
      ON driver_cash_collections(customer_id, created_at DESC)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_driver_cash_collections_sale
      ON driver_cash_collections(sale_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_driver_cash_collections_delivery
      ON driver_cash_collections(delivery_id)
    `);

    // ══════════════════════════════════════════════════════════════════════
    // Settings mặc định
    // ══════════════════════════════════════════════════════════════════════
    const defaults = [
      // Cho phép tài xế tự ghi nhận tiền mặt tại điểm giao (1 = bật)
      ['driver_cash_collection_enabled', '1'],
    ];

    const insertSetting = db.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    defaults.forEach(([key, value]) => insertSetting.run(key, value));

    log('✅ driver_cash_collections đã sẵn sàng');
  },

  down: (db) => {
    try {
      db.exec('DROP INDEX IF EXISTS idx_driver_cash_collections_delivery');
      db.exec('DROP INDEX IF EXISTS idx_driver_cash_collections_sale');
      db.exec('DROP INDEX IF EXISTS idx_driver_cash_collections_customer');
      db.exec('DROP INDEX IF EXISTS idx_driver_cash_collections_driver_date');
      db.exec('DROP TABLE IF EXISTS driver_cash_collections');

      const stmt = db.prepare('DELETE FROM settings WHERE key = ?');
      stmt.run('driver_cash_collection_enabled');
    } catch (_) {
      /* rollback best-effort */
    }
  },
};

module.exports = migration;
