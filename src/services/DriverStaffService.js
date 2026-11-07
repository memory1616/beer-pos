/**
 * DriverStaffService — Quản lý tài xế & lương cứng theo tháng
 * ─────────────────────────────────────────────────────────────────────────────
 * Mô hình:
 *  - `driver_staff` = hồ sơ tài xế (thực thể RIÊNG, không dùng chung với
 *    bảng `sales_staff` của module Sales).
 *  - Liên kết 1-1 với `app_users` (tài khoản đăng nhập Driver Portal).
 *  - `driver_monthly_salary` = lương CỨNG theo tháng:
 *        total = base_salary + bonus - deduction
 *
 * Lưu ý bảo mật:
 *  - KHÔNG bao giờ trả `password_hash` ra ngoài.
 *  - Không có phép truy cập từ tài xế (DRIVER) — chỉ ADMIN.
 */

const db = require('../../database');
const UserService = require('./UserService');
const logger = require('../../src/utils/logger');

const ROLE_DRIVER = 'DRIVER';

const SALARY_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
};

class DriverStaffService {
  // ── Danh sách tài xế ─────────────────────────────────────────────────────
  static getAll({ includeInactive = false } = {}) {
    const where = includeInactive ? '' : 'WHERE ds.active = 1';
    return db
      .prepare(
        `SELECT ds.id, ds.app_user_id, ds.username, ds.full_name, ds.phone,
                ds.monthly_salary, ds.bank_account, ds.note, ds.active,
                ds.created_at, ds.updated_at,
                au.active AS account_active,
                au.last_login_at
         FROM driver_staff ds
         LEFT JOIN app_users au ON au.id = ds.app_user_id
         ${where}
         ORDER BY ds.active DESC, ds.full_name, ds.username`
      )
      .all();
  }

  /** Lấy 1 tài xế theo id */
  static getById(id) {
    return db
      .prepare(
        `SELECT ds.id, ds.app_user_id, ds.username, ds.full_name, ds.phone,
                ds.monthly_salary, ds.bank_account, ds.note, ds.active,
                ds.created_at, ds.updated_at,
                au.active AS account_active,
                au.last_login_at
         FROM driver_staff ds
         LEFT JOIN app_users au ON au.id = ds.app_user_id
         WHERE ds.id = ?`
      )
      .get(id);
  }

  /** Lấy tài xế theo username */
  static getByUsername(username) {
    const u = String(username || '').trim().toLowerCase();
    if (!u) return null;
    return db
      .prepare(
        `SELECT ds.id, ds.app_user_id, ds.username, ds.full_name, ds.phone,
                ds.monthly_salary, ds.bank_account, ds.note, ds.active
         FROM driver_staff ds
         WHERE ds.username = ?`
      )
      .get(u);
  }

  // ── Tạo tài xế (kèm tài khoản đăng nhập) ────────────────────────────────
  /**
   * Tạo HỒ SƠ tài xế. Nếu chưa có tài khoản đăng nhập → tạo luôn trong
   * `app_users` (role=DRIVER) để tài xế đăng nhập được ngay.
   *
   * @param {{username, password, fullName, phone, monthlySalary, bankAccount, note, createAccount}} data
   */
  static create(data) {
    const username = String(data.username || '').trim().toLowerCase();
    if (!username) return { success: false, error: 'Thiếu tên đăng nhập' };

    const existingProfile = DriverStaffService.getByUsername(username);
    if (existingProfile) {
      return { success: false, error: `Tài xế "${username}" đã tồn tại` };
    }

    const tx = db.transaction(() => {
      let appUserId = null;
      let createdAccount = false;

      const existingUser = db
        .prepare('SELECT id, role, active FROM app_users WHERE username = ?')
        .get(username);

      if (!existingUser) {
        if (!data.password) {
          throw new Error('Thiếu mật khẩu để tạo tài khoản đăng nhập cho tài xế');
        }
        const result = UserService.create({
          username,
          password: data.password,
          fullName: data.fullName || null,
          phone: data.phone || null,
          role: ROLE_DRIVER,
          mustChangePassword: data.mustChangePassword !== false,
        });
        if (!result.success) throw new Error(result.error);
        appUserId = result.id;
        createdAccount = true;
      } else {
        appUserId = existingUser.id;
      }

      const inserted = db
        .prepare(
          `INSERT INTO driver_staff
             (app_user_id, username, full_name, phone, monthly_salary, bank_account, note, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(
          appUserId,
          username,
          data.fullName || null,
          data.phone || null,
          Number(data.monthlySalary) || 0,
          data.bankAccount || null,
          data.note || null
        );

      return { id: inserted.lastInsertRowid, appUserId, createdAccount };
    });

    try {
      const result = tx();
      logger.info('[DriverStaffService] Created driver', { username });
      return {
        success: true,
        id: result.id,
        username,
        appUserId: result.appUserId,
        accountCreated: result.createdAccount,
      };
    } catch (err) {
      logger.error('[DriverStaffService] create error', { error: err.message });
      return { success: false, error: err.message };
    }
  }

  // ── Cập nhật hồ sơ tài xế ────────────────────────────────────────────────
  /**
   * @param {number} id
   * @param {{fullName, phone, monthlySalary, bankAccount, note, active, password}} data
   */
  static update(id, data) {
    const driver = DriverStaffService.getById(id);
    if (!driver) return { success: false, error: 'Không tìm thấy tài xế' };

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
    if (data.monthlySalary !== undefined) {
      const salary = Number(data.monthlySalary);
      if (Number.isNaN(salary) || salary < 0) {
        return { success: false, error: 'Mức lương tháng không hợp lệ' };
      }
      updates.push('monthly_salary = ?');
      params.push(salary);
    }
    if (data.bankAccount !== undefined) {
      updates.push('bank_account = ?');
      params.push(data.bankAccount);
    }
    if (data.note !== undefined) {
      updates.push('note = ?');
      params.push(data.note);
    }
    if (data.active !== undefined) {
      updates.push('active = ?');
      params.push(data.active ? 1 : 0);
    }

    try {
      if (updates.length) {
        updates.push("updated_at = datetime('now')");
        params.push(id);
        db.prepare(`UPDATE driver_staff SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }

      // Đồng bộ thông tin liên hệ + trạng thái tài khoản đăng nhập
      if (driver.app_user_id) {
        const userUpdates = [];
        const userParams = [];
        if (data.fullName !== undefined) {
          userUpdates.push('full_name = ?');
          userParams.push(data.fullName);
        }
        if (data.phone !== undefined) {
          userUpdates.push('phone = ?');
          userParams.push(data.phone);
        }
        if (data.active !== undefined) {
          userUpdates.push('active = ?');
          userParams.push(data.active ? 1 : 0);
        }
        if (userUpdates.length) {
          userParams.push(driver.app_user_id);
          db.prepare(`UPDATE app_users SET ${userUpdates.join(', ')} WHERE id = ?`).run(
            ...userParams
          );
          // Khoá tài khoản → huỷ session đang hoạt động
          if (data.active === false) {
            db.prepare('DELETE FROM auth_sessions WHERE app_user_id = ?').run(driver.app_user_id);
          }
        }
      }

      // Đổi mật khẩu (tuỳ chọn)
      if (data.password) {
        if (!driver.app_user_id) {
          return { success: false, error: 'Tài xế chưa có tài khoản đăng nhập để đổi mật khẩu' };
        }
        const pw = UserService.changePassword(driver.app_user_id, data.password, 'ADMIN');
        if (!pw.success) return { success: false, error: pw.error };
      }

      return { success: true, id };
    } catch (err) {
      logger.error('[DriverStaffService] update error', { error: err.message });
      return { success: false, error: err.message };
    }
  }

  // ── Xoá (soft delete) ───────────────────────────────────────────────────
  static remove(id) {
    const driver = DriverStaffService.getById(id);
    if (!driver) return { success: false, error: 'Không tìm thấy tài xế' };
    try {
      db.prepare("UPDATE driver_staff SET active = 0, updated_at = datetime('now') WHERE id = ?").run(id);
      if (driver.app_user_id) {
        db.prepare("UPDATE app_users SET active = 0, updated_at = datetime('now') WHERE id = ?").run(
          driver.app_user_id
        );
        db.prepare('DELETE FROM auth_sessions WHERE app_user_id = ?').run(driver.app_user_id);
      }
      logger.info('[DriverStaffService] Removed driver', { id });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // LƯƠNG CỨNG THEO THÁNG
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Lấy bảng lương tháng cho 1 tài xế.
   * Nếu chưa có bản ghi lương → trả về bản tính từ mức lương cố định.
   */
  static getMonthlySalary(driverId, year, month) {
    const record = db
      .prepare(
        `SELECT * FROM driver_monthly_salary
         WHERE driver_id = ? AND year = ? AND month = ?`
      )
      .get(driverId, year, month);

    if (record) return record;

    // Chưa có bản ghi → tính sơ bộ từ mức lương cố định của hồ sơ
    const driver = DriverStaffService.getById(driverId);
    const base = driver ? driver.monthly_salary || 0 : 0;
    return {
      id: null,
      driver_id: driverId,
      year,
      month,
      base_salary: base,
      bonus: 0,
      deduction: 0,
      total: base,
      status: SALARY_STATUS.PENDING,
      paid_at: null,
      note: null,
      isDraft: true,
    };
  }

  /**
   * Thiết lập / cập nhật lương tháng cho tài xế.
   *
   * Cập nhật một phần: chỉ trường được truyền mới bị ghi đè — các trường
   * khác giữ nguyên giá trị đã lưu (tránh mất dữ liệu khi sửa 1 ô).
   */
  static setMonthlySalary(driverId, year, month, payload) {
    const driver = DriverStaffService.getById(driverId);
    if (!driver) return { success: false, error: 'Không tìm thấy tài xế' };

    const existing = db
      .prepare(
        `SELECT id, base_salary, bonus, deduction, note, status FROM driver_monthly_salary
         WHERE driver_id = ? AND year = ? AND month = ?`
      )
      .get(driverId, year, month);

    // Fallback: bản ghi đã lưu → lương cố định của hồ sơ → 0
    const fallbackBase = existing ? existing.base_salary : driver.monthly_salary || 0;
    const fallbackBonus = existing ? existing.bonus : 0;
    const fallbackDeduction = existing ? existing.deduction : 0;

    const base =
      payload.baseSalary !== undefined && payload.baseSalary !== null && payload.baseSalary !== ''
        ? Number(payload.baseSalary)
        : fallbackBase;
    const bonus =
      payload.bonus !== undefined && payload.bonus !== null && payload.bonus !== ''
        ? Number(payload.bonus)
        : fallbackBonus;
    const deduction =
      payload.deduction !== undefined && payload.deduction !== null && payload.deduction !== ''
        ? Number(payload.deduction)
        : fallbackDeduction;

    if (Number.isNaN(base) || base < 0) {
      return { success: false, error: 'Lương cơ bản không hợp lệ' };
    }
    if (Number.isNaN(bonus) || bonus < 0) {
      return { success: false, error: 'Thưởng không hợp lệ' };
    }
    if (Number.isNaN(deduction) || deduction < 0) {
      return { success: false, error: 'Phạt/trừ không hợp lệ' };
    }

    const total = Math.round((base + bonus - deduction) * 100) / 100;
    const note = payload.note !== undefined ? payload.note || null : existing ? existing.note : null;

    try {
      if (existing) {
        // Giữ nguyên trạng thái đã trả nếu không chỉ định lại
        const status = payload.status || existing.status || SALARY_STATUS.PENDING;
        db.prepare(
          `UPDATE driver_monthly_salary
           SET base_salary = ?, bonus = ?, deduction = ?, total = ?, note = ?,
               status = ?,
               paid_at = CASE WHEN ? = 'paid' THEN COALESCE(paid_at, datetime('now')) ELSE paid_at END,
               updated_at = datetime('now')
           WHERE id = ?`
        ).run(base, bonus, deduction, total, note, status, status, existing.id);
      } else {
        db.prepare(
          `INSERT INTO driver_monthly_salary
             (driver_id, year, month, base_salary, bonus, deduction, total, status, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          driverId,
          year,
          month,
          base,
          bonus,
          deduction,
          total,
          payload.status || SALARY_STATUS.PENDING,
          note
        );
      }

      return { success: true, driverId, year, month, total };
    } catch (err) {
      logger.error('[DriverStaffService] setMonthlySalary error', { error: err.message });
      return { success: false, error: err.message };
    }
  }

  /**
   * Đánh dấu lương tháng đã trả (hoặc huỷ trạng thái đã trả).
   */
  static markSalaryPaid(driverId, year, month, paid = true) {
    try {
      const record = DriverStaffService.getMonthlySalary(driverId, year, month);
      if (!record || record.id === null) {
        // Chưa có bản ghi → tạo bản ghi từ lương cố định rồi đánh dấu trả
        const created = DriverStaffService.setMonthlySalary(driverId, year, month, {
          baseSalary: record.base_salary,
          bonus: record.bonus,
          deduction: record.deduction,
          status: paid ? SALARY_STATUS.PAID : SALARY_STATUS.PENDING,
        });
        if (!created.success) return created;
        return { success: true, status: paid ? SALARY_STATUS.PAID : SALARY_STATUS.PENDING };
      }

      const status = paid ? SALARY_STATUS.PAID : SALARY_STATUS.PENDING;
      db.prepare(
        `UPDATE driver_monthly_salary
         SET status = ?, paid_at = ?, updated_at = datetime('now')
         WHERE driver_id = ? AND year = ? AND month = ?`
      ).run(status, paid ? new Date().toISOString() : null, driverId, year, month);

      return { success: true, status };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Tổng hợp lương tất cả tài xế trong 1 tháng.
   */
  static getMonthlySalarySummary(year, month) {
    const drivers = DriverStaffService.getAll({ includeInactive: true });
    return drivers.map((d) => {
      const salary = DriverStaffService.getMonthlySalary(d.id, year, month);
      return {
        driverId: d.id,
        username: d.username,
        fullName: d.full_name || d.username,
        phone: d.phone,
        active: !!d.active,
        accountActive: d.account_active === null ? null : !!d.account_active,
        baseSalary: salary.base_salary,
        bonus: salary.bonus,
        deduction: salary.deduction,
        total: salary.total,
        status: salary.status,
        paidAt: salary.paid_at,
        isDraft: !!salary.isDraft,
        note: salary.note,
      };
    });
  }

  /**
   * Lịch sử lương của 1 tài xế.
   */
  static getSalaryHistory(driverId, limit = 24) {
    return db
      .prepare(
        `SELECT id, driver_id, year, month, base_salary, bonus, deduction, total,
                status, paid_at, note, created_at, updated_at
         FROM driver_monthly_salary
         WHERE driver_id = ?
         ORDER BY year DESC, month DESC
         LIMIT ?`
      )
      .all(driverId, limit);
  }
}

module.exports = DriverStaffService;
module.exports.SALARY_STATUS = SALARY_STATUS;
