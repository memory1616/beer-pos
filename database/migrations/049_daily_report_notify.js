/**
 * Migration: Daily Report Notification (049)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Hệ thống chưa có kênh báo cáo tự động. Chủ xe phải mở máy tính, vào
 *  /report, chọn ngày — mỗi ngày mất nhiều phút và thường bị bỏ qua.
 *
 *  Migration này tạo:
 *  1. Bảng `report_notifications` — lịch sử gửi báo cáo (idempotent).
 *  2. Seed sẵn các setting cho kênh Zalo OA (INSERT OR IGNORE, không đè
 *     giá trị người dùng đã cấu hình).
 *
 * ADDITIVE — KHÔNG sửa/xoá dữ liệu kinh doanh hiện có.
 * Rollback: chỉ gỡ bảng `report_notifications` + các setting mới.
 */

const migration = {
  id: 49,
  name: 'daily_report_notify',

  up: (db) => {
    // ── 1. report_notifications ─────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_date TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'zalo',
        recipient TEXT,
        title TEXT,
        summary TEXT,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        response_code INTEGER,
        error_message TEXT,
        sent_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_report_notifications_date
      ON report_notifications(report_date)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_report_notifications_status
      ON report_notifications(status)
    `);

    // ── 2. Seed settings cho kênh Zalo OA ──────────────────────────────────
    // INSERT OR IGNORE: nếu người dùng đã cấu hình thì giữ nguyên.
    const defaults = [
      // Bật/tắt tự động gửi
      ['report_notify_enabled', '0'],
      // 'zalo' | 'telegram' | 'webhook' | 'none'
      ['report_notify_channel', 'zalo'],
      // Giờ gửi (HH:mm, giờ VN) — cron sẽ đọc setting này
      ['report_notify_time', '21:30'],
      // Zalo OA — Access Token (lấy ở openapi.zalo.me → OA quản lý → Access Token)
      ['zalo_oa_access_token', ''],
      // Zalo OA — user_id người nhận (người chat với OA để nhận user_id)
      ['zalo_report_user_id', ''],
      // Tên hiển thị trong tin nhắn
      ['report_notify_title', 'Báo cáo bán hàng'],
    ];

    const insertSetting = db.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    defaults.forEach(([key, value]) => insertSetting.run(key, value));
  },
};

module.exports = migration;
