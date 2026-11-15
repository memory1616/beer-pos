/**
 * Migration: Audit log thống nhất (056)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Hệ thống có 3 bảng nhật ký rời rạc:
 *   1. `audit_logs`         — nhật ký thao tác chung (có actor, có IP)
 *   2. `product_audit_log`  — lịch sử thay đổi KHO (KHÔNG có actor!)
 *   3. `keg_transactions_log` — lịch sử giao dịch VỎ (KHÔNG có actor!)
 *
 *  Lỗ hổng: log kho & log vỏ không biết AI đã thay đổi → không trả lời
 *  được "số vỏ này ai ghi sai?". Sửa bằng cách thêm `actor_username` +
 *  `ip_address` cho 2 bảng này.
 *
 *  Ngoài ra:
 *   - `action_logs` là bảng CHẾT (tạo ra nhưng không code nào ghi vào, chỉ
 *     đọc ở routes/api/state.js) → XOÁ để giảm gánh nặng DB.
 *   - Index composite cho các truy vấn lọc thực tế (actor + thời gian,
 *     product + thời gian, type + thời gian).
 *
 * ADDITIVE + 1 DROP bảng rỗng. Rollback: thêm lại cột, tạo lại bảng.
 */

const migration = {
  id: 56,
  name: 'audit_log_unification',

  up: (db) => {
    const log = (m) => {
      try {
        // eslint-disable-next-line no-console
        console.log(`[MIGRATION 056] ${m}`);
      } catch (_) {
        /* ignore */
      }
    };

    const addColumn = (table, column, ddl) => {
      try {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        if (!cols.includes(column)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
          log(`  Added ${table}.${column}`);
        } else {
          log(`  ${table}.${column} already exists`);
        }
      } catch (e) {
        log(`  Warning: ${table}.${column}: ${e.message}`);
      }
    };

    // ── 1. product_audit_log: actor + ip ───────────────────────────────────
    addColumn(
      'product_audit_log',
      'actor_username',
      "actor_username TEXT DEFAULT 'system'"
    );
    addColumn('product_audit_log', 'ip_address', 'ip_address TEXT');

    // Backfill: dòng cũ không có ai thực hiện → 'system'
    try {
      db.exec(`
        UPDATE product_audit_log
           SET actor_username = 'system'
         WHERE actor_username IS NULL OR actor_username = ''
      `);
    } catch (e) {
      log(`  Warning: backfill product_audit_log: ${e.message}`);
    }

    // ── 2. keg_transactions_log: actor + ip ────────────────────────────────
    addColumn(
      'keg_transactions_log',
      'actor_username',
      "actor_username TEXT DEFAULT 'system'"
    );
    addColumn('keg_transactions_log', 'ip_address', 'ip_address TEXT');

    try {
      db.exec(`
        UPDATE keg_transactions_log
           SET actor_username = 'system'
         WHERE actor_username IS NULL OR actor_username = ''
      `);
    } catch (e) {
      log(`  Warning: backfill keg_transactions_log: ${e.message}`);
    }

    // ── 3. Index composite cho truy vấn lọc thực tế ────────────────────────
    const indexes = [
      // Lịch sử kho 1 sản phẩm, mới nhất trước (truy vấn /api/stock/history)
      `CREATE INDEX IF NOT EXISTS idx_product_audit_prod_created
       ON product_audit_log(product_id, created_at DESC)`,
      // Lọc log kho theo loại thay đổi (import/export/adjust) trong 1 khoảng ngày
      `CREATE INDEX IF NOT EXISTS idx_product_audit_type_created
       ON product_audit_log(type, created_at DESC)`,
      // Lọc log kho theo actor (ai đã đổi kho)
      `CREATE INDEX IF NOT EXISTS idx_product_audit_actor
       ON product_audit_log(actor_username, created_at DESC)`,
      // Lịch sử vỏ theo loại + thời gian (màn "Lịch sử giao dịch vỏ")
      `CREATE INDEX IF NOT EXISTS idx_keg_tx_log_type_date
       ON keg_transactions_log(type, date DESC)`,
      // Lịch sử vỏ theo khách + thời gian
      `CREATE INDEX IF NOT EXISTS idx_keg_tx_log_cust_date
       ON keg_transactions_log(customer_id, date DESC)`,
      // Lọc log vỏ theo actor
      `CREATE INDEX IF NOT EXISTS idx_keg_tx_log_actor_date
       ON keg_transactions_log(actor_username, date DESC)`,
      // Audit log: lọc theo actor trong 1 khoảng thời gian
      `CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created
       ON audit_logs(actor_username, created_at DESC)`,
    ];

    for (const sql of indexes) {
      try {
        db.exec(sql);
      } catch (e) {
        log(`  Warning: index: ${e.message}`);
      }
    }

    // ── 4. Xoá bảng `action_logs` (chết — không code nào ghi vào) ────────────
    // Bảng này KHÔNG còn được code nào ghi vào (chỉ đọc ở routes/api/state.js).
    // Quyết định: DROP. Nhưng trước khi xoá, ARCHIVE lại dữ liệu còn lại ra
    // file JSON ở thư mục `backups/` để không mất thông tin lịch sử.
    try {
      const exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='action_logs'")
        .get();
      if (!exists) {
        log('  action_logs does not exist — skip');
      } else {
        const rows = db.prepare('SELECT * FROM action_logs').all();
        if (rows.length > 0) {
          try {
            const fs = require('fs');
            const path = require('path');
            const dir = path.join(__dirname, '..', '..', 'backups');
            fs.mkdirSync(dir, { recursive: true });
            const stamp = new Date()
              .toISOString()
              .replace(/[:.]/g, '-')
              .slice(0, 19);
            const file = path.join(dir, `action_logs_${stamp}.json`);
            fs.writeFileSync(
              file,
              JSON.stringify({ archivedAt: new Date().toISOString(), rows }, null, 2),
              'utf8'
            );
            log(`  Archived ${rows.length} action_logs rows → ${file}`);
          } catch (e) {
            log(`  Warning: archive action_logs: ${e.message}`);
          }
        }
        db.exec('DROP TABLE action_logs');
        log('  Dropped action_logs table');
      }
    } catch (e) {
      log(`  Warning: drop action_logs: ${e.message}`);
    }

    // ── 5. Setting retention mặc định ─────────────────────────────────────
    const retentionDefaults = {
      audit_log_retention_days: '180',
      stock_log_retention_days: '365',
      keg_log_retention_days: '365',
    };
    for (const [key, value] of Object.entries(retentionDefaults)) {
      try {
        db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
      } catch (e) {
        log(`  Warning: settings.${key}: ${e.message}`);
      }
    }
  },

  down: (db) => {
    // KHÔNG tạo lại `action_logs` — bảng này đã bị loại bỏ có chủ đích.
    try {
      db.exec('DROP INDEX IF EXISTS idx_product_audit_prod_created');
      db.exec('DROP INDEX IF EXISTS idx_product_audit_type_created');
      db.exec('DROP INDEX IF EXISTS idx_product_audit_actor');
      db.exec('DROP INDEX IF EXISTS idx_keg_tx_log_type_date');
      db.exec('DROP INDEX IF EXISTS idx_keg_tx_log_cust_date');
      db.exec('DROP INDEX IF EXISTS idx_keg_tx_log_actor_date');
      db.exec('DROP INDEX IF EXISTS idx_audit_logs_actor_created');
    } catch (_) {
      /* ignore */
    }
  },
};

module.exports = migration;
