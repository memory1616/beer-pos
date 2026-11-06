/**
 * UserService — Quản lý tài khoản & phân quyền
 * ─────────────────────────────────────────────────────────────────────────────
 * Dùng cho:
 *  - Admin tạo / sửa / khoá tài khoản tài xế
 *  - Driver Portal đăng nhập
 *  - CLI script scripts/create-driver.js
 *
 * Bảo mật:
 *  - Mật khẩu luôn hash bằng scrypt, KHÔNG bao giờ lưu plaintext.
 *  - Role chỉ nhận 'ADMIN' | 'DRIVER'. Driver KHÔNG thể tự nâng role.
 */

const db = require('../../database');
const { hashPassword, verifyPassword, validatePasswordStrength } = require('../../src/utils/password');
const logger = require('../../src/utils/logger');

const ROLE_ADMIN = 'ADMIN';
const ROLE_DRIVER = 'DRIVER';
const VALID_ROLES = [ROLE_ADMIN, ROLE_DRIVER];

class UserService {
  /**
   * Tạo tài khoản mới.
   * @param {{username, password, role, fullName, phone}} data
   */
  static create(data) {
    const username = String(data.username || '').trim().toLowerCase();
    const role = String(data.role || ROLE_DRIVER).toUpperCase();
    const password = data.password;

    if (!username) return { success: false, error: 'Thiếu tên đăng nhập' };
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
      return {
        success: false,
        error: 'Tên đăng nhập phải 3-32 ký tự, chỉ gồm chữ thường, số, dấu . _ -',
      };
    }
    if (!VALID_ROLES.includes(role)) {
      return { success: false, error: `Role không hợp lệ (chỉ nhận ${VALID_ROLES.join(' / ')})` };
    }
    const strength = validatePasswordStrength(password);
    if (!strength.valid) return { success: false, error: strength.error };

    const exists = db.prepare('SELECT id FROM app_users WHERE username = ?').get(username);
    if (exists) return { success: false, error: 'Tên đăng nhập đã tồn tại' };

    const passwordHash = hashPassword(password);

    try {
      const result = db
        .prepare(`
          INSERT INTO app_users
            (username, password_hash, full_name, phone, role, active, must_change_password)
          VALUES (?, ?, ?, ?, ?, 1, ?)
        `)
        .run(
          username,
          passwordHash,
          data.fullName || null,
          data.phone || null,
          role,
          data.mustChangePassword ? 1 : 0
        );

      logger.info('[UserService] Created user', { username, role });
      return { success: true, id: result.lastInsertRowid, username, role };
    } catch (e) {
      logger.error('[UserService] create error', { error: e.message });
      return { success: false, error: e.message };
    }
  }

  /**
   * Cập nhật tài khoản. Role chỉ đổi được khi actor là admin.
   */
  static update(id, data, actorRole = ROLE_ADMIN) {
    const user = db.prepare('SELECT * FROM app_users WHERE id = ?').get(id);
    if (!user) return { success: false, error: 'Không tìm thấy tài khoản' };

    const updates = [];
    const params = [];

    if (data.fullName !== undefined) {
      updates.push('full_name = ?');
      params.push(data.fullName);
    }
    if (data.phone !== undefined) {
      updates.push('phone = ?');
      params.push(data.phone);
    }
    if (data.active !== undefined) {
      updates.push('active = ?');
      params.push(data.active ? 1 : 0);
    }
    if (data.password) {
      const strength = validatePasswordStrength(data.password);
      if (!strength.valid) return { success: false, error: strength.error };
      updates.push('password_hash = ?');
      params.push(hashPassword(data.password));
    }
    if (data.role !== undefined) {
      // Chỉ ADMIN mới được đổi role — driver không thể tự nâng quyền
      if (actorRole !== ROLE_ADMIN) {
        return { success: false, error: 'Không có quyền thay đổi role' };
      }
      const role = String(data.role).toUpperCase();
      if (!VALID_ROLES.includes(role)) return { success: false, error: 'Role không hợp lệ' };
      updates.push('role = ?');
      params.push(role);
    }

    if (updates.length === 0) return { success: true, id, unchanged: true };

    updates.push("updated_at = datetime('now')");
    params.push(id);

    try {
      db.prepare(`UPDATE app_users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      logger.info('[UserService] Updated user', { id, actorRole });
      return { success: true, id };
    } catch (e) {
      logger.error('[UserService] update error', { error: e.message });
      return { success: false, error: e.message };
    }
  }

  /** Đổi mật khẩu (bởi chính user hoặc admin) */
  static changePassword(id, newPassword, actorRole = ROLE_ADMIN) {
    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) return { success: false, error: strength.error };
    try {
      db.prepare("UPDATE app_users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
        .run(hashPassword(newPassword), id);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /** Khoá / mở khoá tài khoản */
  static setActive(id, active) {
    try {
      db.prepare("UPDATE app_users SET active = ?, updated_at = datetime('now') WHERE id = ?")
        .run(active ? 1 : 0, id);
      // Huỷ mọi session đang hoạt động của user bị khoá
      if (!active) {
        db.prepare('DELETE FROM auth_sessions WHERE app_user_id = ?').run(id);
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /** Xoá tài khoản (soft: set active = 0 để giữ audit trail) */
  static remove(id) {
    return UserService.setActive(id, false);
  }

  /** Lấy danh sách user (không kèm password_hash) */
  static list(filter = {}) {
    let sql = `SELECT id, username, full_name, phone, role, active, must_change_password,
                      last_login_at, created_at, updated_at
               FROM app_users`;
    const params = [];
    const where = [];
    if (filter.role) {
      where.push('role = ?');
      params.push(String(filter.role).toUpperCase());
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY role, username';
    return db.prepare(sql).all(...params);
  }

  /** Lấy 1 user (không kèm password_hash) */
  static getById(id) {
    return db
      .prepare(`SELECT id, username, full_name, phone, role, active, must_change_password,
                       last_login_at, created_at, updated_at
                FROM app_users WHERE id = ?`)
      .get(id);
  }

  static getByUsername(username) {
    return db
      .prepare(`SELECT id, username, full_name, phone, role, active, must_change_password,
                       last_login_at, created_at, updated_at
                FROM app_users WHERE username = ?`)
      .get(String(username || '').trim().toLowerCase());
  }

  /** Đổi mật khẩu bằng mật khẩu cũ (dùng trong app) */
  static changeOwnPassword(username, oldPassword, newPassword) {
    const row = db.prepare('SELECT * FROM app_users WHERE username = ?').get(username);
    if (!row) return { success: false, error: 'Không tìm thấy tài khoản' };
    if (!verifyPassword(oldPassword, row.password_hash)) {
      return { success: false, error: 'Mật khẩu cũ không đúng' };
    }
    return UserService.changePassword(row.id, newPassword, row.role);
  }
}

module.exports = UserService;
module.exports.ROLE_ADMIN = ROLE_ADMIN;
module.exports.ROLE_DRIVER = ROLE_DRIVER;
module.exports.VALID_ROLES = VALID_ROLES;
