/**
 * Migration: Debt Zalo Notify via OmiCall (062)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Khi sổ công nợ ghi nhận tiền khách trả (qua Sepay hoặc ghi nợ tay),
 *  chủ xe muốn TỰ ĐỘNG gửi tin nhắn vào nhóm Zalo của khách để thông báo
 *  "đã nhận X đồng, còn nợ Y đồng" — khách tự thấy ngay, không cần nhân
 *  viên gọi điện.
 *
 *  Giao tiếp qua **OmiCall** (https://omicall.com) — kênh Zalo Personal
 *  multi-channel: `POST {base}/omni_conv/message/send_text?lng=vi` với
 *  body `{ convId, text }`.
 *
 *  Migration này tạo:
 *   1. Bảng `debt_notifications` — nhật ký từng lần gửi (sent/failed/skipped)
 *      + nội dung tin nhắn + lỗi → để tra cứu & chẩn đoán.
 *   2. Seed settings cho OmiCall (API key, base URL, bật/tắt, kênh).
 *
 *  ADDITIVE — KHÔNG sửa/xoá dữ liệu kinh doanh hiện có.
 *  Rollback: chỉ gỡ bảng `debt_notifications` + các setting mới.
 */

const migration = {
  id: 62,
  name: 'debt_zalo_notify_omicall',

  up: (db) => {
    // ── 1. debt_notifications — nhật ký gửi tin nhắn Zalo ──────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS debt_notifications (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id       INTEGER,
        customer_name     TEXT,
        channel           TEXT NOT NULL DEFAULT 'omicall_zalo_personal',
        group_id          TEXT,
        event_type        TEXT NOT NULL DEFAULT 'payment',
        amount            REAL DEFAULT 0,
        applied_amount    REAL DEFAULT 0,
        credit_amount     REAL DEFAULT 0,
        balance_before    REAL DEFAULT 0,
        balance_after     REAL DEFAULT 0,
        content           TEXT,
        status            TEXT NOT NULL DEFAULT 'pending',
        error             TEXT,
        source            TEXT,
        transaction_id    INTEGER,
        created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        sent_at           TEXT,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_notifications_customer
      ON debt_notifications(customer_id, created_at DESC)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_notifications_status
      ON debt_notifications(status, created_at DESC)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_debt_notifications_created
      ON debt_notifications(created_at DESC)
    `);

    // ── 2. Seed settings OmiCall (INSERT OR IGNORE — không đè cấu hình cũ) ──
    const defaults = [
      // API key OmiCall (lấy ở omicall.com → Cài đặt → API)
      ['omicall_api_key', ''],
      // Base URL: production / staging
      ['omicall_base_url', 'https://public-v1.omicall.com'],
      // Bật/tắt gửi tin nhắn công nợ
      ['debt_notify_enabled', '0'],
      // Kênh: 'omicall_zalo_personal' | 'none'
      ['debt_notify_channel', 'omicall_zalo_personal'],
      // Bật/tắt thông báo "ghi nợ tay" (lệnh `-`)
      ['debt_notify_manual_debt', '0'],
      // Tên hiển thị trong tin nhắn
      ['debt_notify_title', 'BIA TƯƠI — Cập nhật công nợ'],
    ];

    const insertSetting = db.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    defaults.forEach(([key, value]) => insertSetting.run(key, value));
  },

  down: (db) => {
    try {
      db.exec('DROP TABLE IF EXISTS debt_notifications');
      const stmt = db.prepare('DELETE FROM settings WHERE key = ?');
      [
        'omicall_api_key',
        'omicall_base_url',
        'debt_notify_enabled',
        'debt_notify_channel',
        'debt_notify_manual_debt',
        'debt_notify_title',
      ].forEach((key) => stmt.run(key));
    } catch (_) {
      /* rollback best-effort */
    }
  },
};

module.exports = migration;
