/**
 * Migration: Zalo OA OAuth v4 + user management (052)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bối cảnh:
 *  Migration 049 đã seed các setting cho kênh Zalo OA, nhưng chưa có:
 *   - `zalo_oa_refresh_token` : dùng để làm mới access token (hết hạn 25h)
 *   - `zalo_oa_app_id`       : App ID để gọi OAuth
 *   - `zalo_oa_secret_key`   : Secret key của app
 *
 *  Ngoài ra hệ thống chuyển từ API v2.0 (đã shutdown) sang v3.0 và cần
 *  quyền "Quản lý thông tin người dùng" để tra cứu user_id người nhận.
 *
 * ADDITIVE — chỉ seed setting mới, KHÔNG đụng dữ liệu kinh doanh.
 */

const migration = {
  id: 52,
  name: 'zalo_oa_oauth_v4',

  up: (db) => {
    const defaults = [
      // OAuth v4 — refresh token (hết hạn 3 tháng, dùng 1 lần rồi phải lưu token mới)
      ['zalo_oa_refresh_token', ''],
      // OAuth v4 — App ID
      ['zalo_oa_app_id', ''],
      // OAuth v4 — Secret key
      ['zalo_oa_secret_key', ''],
    ];

    const insertSetting = db.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    defaults.forEach(([key, value]) => insertSetting.run(key, value));
  },

  down: (db) => {
    const stmt = db.prepare('DELETE FROM settings WHERE key = ?');
    [
      'zalo_oa_refresh_token',
      'zalo_oa_app_id',
      'zalo_oa_secret_key',
    ].forEach((key) => stmt.run(key));
  },
};

module.exports = migration;
