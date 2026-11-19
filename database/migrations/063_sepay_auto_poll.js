/**
 * Migration: Sepay auto-poll (063)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Gạch nợ tự động hiện đang phụ thuộc 100% vào webhook SePay
 *  (`POST /webhook/sepay`). Nếu webhook chưa cấu hình / cấu hình sai /
 *  SePay gửi lỗi → hệ thống KHÔNG tự gạch nợ, phải bấm tay
 *  "🔄 Đối soát tay (API)".
 *
 *  Migration này thêm cột cấu hình cho cơ chế **auto-poll**:
 *   - `auto_poll_enabled`         : bật/tắt đối soát định kỳ (mặc định BẬT).
 *   - `auto_poll_interval_min`    : chu kỳ đối soát (phút, mặc định 5).
 *   - `auto_poll_lookback_days`   : số ngày lùi lần đầu (mặc định 3).
 *
 *  Nhờ đó hệ thống LUÔN tự gạch nợ trong vòng vài phút kể từ lúc khách
 *  chuyển tiền, kể cả khi webhook hỏng.
 *
 *  ADDITIVE — chỉ thêm cột (mặc định NULL → đọc được nhờ fallback trong
 *  `DebtSepayService.getSettings()`).
 */

const migration = {
  id: 63,
  name: 'sepay_auto_poll',

  up: (db) => {
    const cols = db.prepare('PRAGMA table_info(sepay_settings)').all().map((c) => c.name);

    const addColumn = (name, ddl) => {
      if (cols.includes(name)) return;
      db.exec(`ALTER TABLE sepay_settings ADD COLUMN ${name} ${ddl}`);
    };

    addColumn('auto_poll_enabled', 'INTEGER NOT NULL DEFAULT 1');
    addColumn('auto_poll_interval_min', 'INTEGER NOT NULL DEFAULT 5');
    addColumn('auto_poll_lookback_days', 'INTEGER NOT NULL DEFAULT 3');

    // Seed row nếu chưa có (để đọc được mặc định).
    db.prepare(
      `INSERT OR IGNORE INTO sepay_settings (id, auto_settle, auto_poll_enabled, auto_poll_interval_min, auto_poll_lookback_days)
       VALUES (1, 1, 1, 5, 3)`
    ).run();
  },

  down: (db) => {
    // SQLite >= 3.35 hỗ trợ DROP COLUMN; nếu không thì giữ nguyên (vô hại).
    try {
      db.exec('ALTER TABLE sepay_settings DROP COLUMN auto_poll_lookback_days');
      db.exec('ALTER TABLE sepay_settings DROP COLUMN auto_poll_interval_min');
      db.exec('ALTER TABLE sepay_settings DROP COLUMN auto_poll_enabled');
    } catch (_) {
      /* rollback best-effort */
    }
  },
};

module.exports = migration;
