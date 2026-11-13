/**
 * Migration: Driver Push Notifications (051)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Admin tạo đơn hàng → tài xế đang chạy xe, màn hình khoá / app đóng →
 *  không biết có đơn mới. Cần "đẩy" thông báo tới máy tài xế.
 *
 *  Migration này tạo:
 *  1. Bảng `push_subscriptions` — lưu Web Push subscription của từng thiết bị.
 *  2. Bảng `push_notifications` — lịch sử gửi push (để admin tra + debug).
 *  3. Seed settings cho VAPID keypair + bật/tắt tính năng.
 *
 * ADDITIVE — KHÔNG sửa/xoá dữ liệu kinh doanh hiện có.
 * Rollback: chỉ gỡ 2 bảng mới.
 */

const migration = {
  id: 51,
  name: 'driver_push_notifications',

  up: (db) => {
    // ── 1. push_subscriptions ───────────────────────────────────────────────
    // Mỗi thiết bị (trình duyệt) của tài xế = 1 subscription.
    // `endpoint` là khóa chính (duy nhất) — browser tạo endpoint mới mỗi lần đăng ký.
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        push_enabled INTEGER NOT NULL DEFAULT 1,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_used_at TEXT
      )
    `);

    // Truy vấn chính: lấy subscription của 1 tài xế
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_username
      ON push_subscriptions(username)
    `);

    // Dọn subscription chết (410/404) — lọc nhanh
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_enabled
      ON push_subscriptions(push_enabled, username)
    `);

    // ── 2. push_notifications ───────────────────────────────────────────────
    // Lịch sử gửi. Giữ để admin biết đơn nào đã đẩy thành công / thất bại.
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER,
        driver_username TEXT,
        title TEXT,
        body TEXT,
        data TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        sent_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        sent_at TEXT
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_push_notifications_created
      ON push_notifications(created_at DESC)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_push_notifications_sale
      ON push_notifications(sale_id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_push_notifications_driver
      ON push_notifications(driver_username)
    `);

    // ── 3. Seed settings ────────────────────────────────────────────────────
    // VAPID keypair được sinh tự động lần đầi bởi PushService (nếu admin
    // chưa cấu hình) → lưu vào settings để không đổi mỗi lần restart.
    const defaults = [
      // Bật/tắt toàn hệ thống push đơn giao
      ['push_enabled', '0'],
      // VAPID keypair (public/private) — sinh tự động nếu trống
      ['push_vapid_public_key', ''],
      ['push_vapid_private_key', ''],
      ['push_vapid_subject', 'mailto:admin@biatuoitayninh.store'],
      // Mẫu nội dung thông báo
      ['push_title_template', '🔔 Đơn giao mới'],
    ];

    const insertSetting = db.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    defaults.forEach(([key, value]) => insertSetting.run(key, value));
  },
};

module.exports = migration;
