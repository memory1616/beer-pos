/**
 * Migration: Ngày nghiệp vụ (business day) — cutoff 19:00 (055)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Quy tắc nghiệp vụ: "những đơn hàng được tạo sau 19h hằng ngày, được tính
 *  là đơn hàng ngày mai". Cài đặt bằng cách GHI NGÀY NGHIỆP VỤ vào cột
 *  `sales.date` ngay lúc tạo đơn → mọi truy vấn doanh thu/báo cáo hiện có
 *  (đang lọc theo `sales.date`) tự động đúng, KHÔNG phải sửa hàng loạt SQL.
 *
 *  Vì vậy cần thêm 2 cột:
 *   1. `sales.created_on` — ngày LỊCH THỰC (YYYY-MM-DD giờ VN) của lúc tạo
 *      đơn. Driver Portal dùng cột này để GIỮ HIỆN đơn tạo sau 19:00 trong
 *      danh sách giao hàng của NGÀY ĐÓ (quyết định "keep-visible").
 *   2. `debt_transactions.business_date` — ngày nghiệp vụ của bút toán công
 *      nợ. KPI "Nợ phát sinh hôm nay" / "Tiền thu hôm nay" lọc theo cột này
 *      → đơn sau 19:00 không tính vào hôm nay mà lùi sang ngày mai.
 *
 *  ADDITIVE: chỉ thêm cột + index + 1 setting. KHÔNG sửa/xoá dữ liệu nào.
 *  Rollback: `ALTER TABLE ... DROP COLUMN` (SQLite ≥ 3.35), an toàn.
 */

const migration = {
  id: 55,
  name: 'business_day_cutoff',

  up: (db) => {
    const log = (m) => {
      try {
        // eslint-disable-next-line no-console
        console.log(`[MIGRATION 055] ${m}`);
      } catch (_) {
        /* ignore */
      }
    };

    // ── 1. sales.created_on — ngày lịch thực tạo đơn ────────────────────────
    try {
      const cols = db.prepare('PRAGMA table_info(sales)').all().map((c) => c.name);
      if (!cols.includes('created_on')) {
        db.exec('ALTER TABLE sales ADD COLUMN created_on TEXT');
        log('  Added sales.created_on');
      } else {
        log('  sales.created_on already exists');
      }
      // Backfill: đơn cũ chưa có cột này → ngày lịch thực = `sales.date`
      // (trước khi áp dụng cutoff, `sales.date` CHÍNH LÀ ngày lịch thực).
      db.exec(`
        UPDATE sales
           SET created_on = date(date)
         WHERE created_on IS NULL
           AND date IS NOT NULL
      `);
    } catch (e) {
      log(`  Warning: sales.created_on: ${e.message}`);
    }

    // ── 2. debt_transactions.business_date — ngày nghiệp vụ bút toán ────────
    try {
      const cols = db.prepare('PRAGMA table_info(debt_transactions)').all().map((c) => c.name);
      if (!cols.includes('business_date')) {
        db.exec('ALTER TABLE debt_transactions ADD COLUMN business_date TEXT');
        log('  Added debt_transactions.business_date');
      } else {
        log('  debt_transactions.business_date already exists');
      }
      // Backfill: bút toán cũ → ngày lịch thực theo giờ VN (+7h) của created_at.
      // (created_at lưu UTC nên phải cộng 7h mới đúng ngày VN.)
      db.exec(`
        UPDATE debt_transactions
           SET business_date = date(datetime(created_at, '+7 hours'))
         WHERE business_date IS NULL
      `);
    } catch (e) {
      log(`  Warning: debt_transactions.business_date: ${e.message}`);
    }

    // ── 3. Index ───────────────────────────────────────────────────────────
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_created_on ON sales(created_on)`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_debt_tx_business_date
         ON debt_transactions(business_date)`
      );
    } catch (e) {
      log(`  Warning: index: ${e.message}`);
    }

    // ── 4. Setting giờ chốt ngày nghiệp vụ ───────────────────────────────
    // 19 = đơn tạo từ 19:00 trở đi thuộc ngày hôm sau.
    try {
      db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(
        'business_day_cutoff_hour',
        '19'
      );
    } catch (e) {
      log(`  Warning: settings.business_day_cutoff_hour: ${e.message}`);
    }
  },

  down: (db) => {
    try {
      db.exec('DROP INDEX IF EXISTS idx_sales_created_on');
      db.exec('DROP INDEX IF EXISTS idx_debt_tx_business_date');
      db.prepare("DELETE FROM settings WHERE key = 'business_day_cutoff_hour'").run();

      const saleCols = db.prepare('PRAGMA table_info(sales)').all().map((c) => c.name);
      if (saleCols.includes('created_on')) {
        db.exec('ALTER TABLE sales DROP COLUMN created_on');
      }
      const txCols = db.prepare('PRAGMA table_info(debt_transactions)').all().map((c) => c.name);
      if (txCols.includes('business_date')) {
        db.exec('ALTER TABLE debt_transactions DROP COLUMN business_date');
      }
    } catch (e) {
      // SQLite cũ không hỗ trợ DROP COLUMN → bỏ qua, cột vô hại
    }
  },
};

module.exports = migration;
