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
const DriverSalaryCalculator = require('./DriverSalaryCalculator');

const ROLE_DRIVER = 'DRIVER';

const SALARY_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
};

/**
 * Chuẩn hoá ngày vào làm về dạng YYYY-MM-DD.
 * Trả về null nếu rỗng / sai định dạng.
 */
function normalizeStartDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  // Kiểm tra ngày có tồn tại thật không (vd 2026-02-31 → invalid)
  const d = new Date(raw + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return null;
  return raw;
}

class DriverStaffService {
  // ── Danh sách tài xế ─────────────────────────────────────────────────────
  static getAll({ includeInactive = false } = {}) {
    const where = includeInactive ? '' : 'WHERE ds.active = 1';
    return db
      .prepare(
        `SELECT ds.id, ds.app_user_id, ds.username, ds.full_name, ds.phone,
                ds.monthly_salary, ds.bank_account, ds.note, ds.active,
                ds.start_date, ds.created_at, ds.updated_at,
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
                ds.start_date, ds.created_at, ds.updated_at,
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
                ds.monthly_salary, ds.bank_account, ds.note, ds.active,
                ds.start_date
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
             (app_user_id, username, full_name, phone, monthly_salary, bank_account, note, active, start_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
        )
        .run(
          appUserId,
          username,
          data.fullName || null,
          data.phone || null,
          Number(data.monthlySalary) || 0,
          data.bankAccount || null,
          data.note || null,
          DriverStaffService.normalizeStartDate(data.startDate) || null
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
    if (data.startDate !== undefined) {
      const sd = normalizeStartDate(data.startDate);
      if (data.startDate !== null && data.startDate !== '' && !sd) {
        return { success: false, error: 'Ngày vào làm không hợp lệ (YYYY-MM-DD)' };
      }
      updates.push('start_date = ?');
      params.push(sd);
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
   *
   * Luôn kèm thông tin TÍNH LƯƠNG THEO NGÀY LÀM:
   *   workDays    — số ngày làm thực tế trong kỳ (không tính Chủ Nhật)
   *   dailyRate   — lương 1 ngày = base_salary ÷ 26
   *   proratedBase— (base_salary ÷ 26) × workDays
   */
  static getMonthlySalary(driverId, year, month) {
    const record = db
      .prepare(
        `SELECT * FROM driver_monthly_salary
         WHERE driver_id = ? AND year = ? AND month = ?`
      )
      .get(driverId, year, month);

    const driver = DriverStaffService.getById(driverId);

    if (record) {
      return DriverStaffService.attachProration(record, driver, year, month);
    }

    // Chưa có bản ghi → tính sơ bộ từ mức lương cố định của hồ sơ
    const base = driver ? driver.monthly_salary || 0 : 0;
    const draft = {
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
      work_days: null,
      daily_rate: null,
      isDraft: true,
    };
    return DriverStaffService.attachProration(draft, driver, year, month);
  }

  /**
   * Gắn thông tin tính lương theo ngày làm vào một bản ghi lương.
   *
   * - `work_days` trong DB = giá trị admin SỬA TAY (ghi đè tay) → dùng luôn.
   * - `work_days` NULL → tự động tính từ ngày vào làm đến ngày hiện tại.
   */
  static attachProration(record, driver, year, month) {
    const manualWorkDays =
      record && record.work_days !== null && record.work_days !== undefined
        ? record.work_days
        : null;

    const calc = DriverSalaryCalculator.calculate(driver, year, month, {
      baseSalary: record ? record.base_salary : (driver ? driver.monthly_salary : 0),
      manualWorkDays,
    });

    const base = Number(record ? record.base_salary : 0) || 0;
    const bonus = Number(record ? record.bonus : 0) || 0;
    const deduction = Number(record ? record.deduction : 0) || 0;

    return {
      ...record,
      // Thông tin ngày làm
      start_date: calc.startDate,
      period_start: calc.periodStart,
      period_end: calc.periodEnd,
      is_current_month: calc.isCurrentMonth,
      work_days: calc.workDays,
      work_days_manual: manualWorkDays !== null,
      standard_work_days: calc.standardWorkDays,
      daily_rate: calc.dailyRate,
      prorated_base: calc.proratedBase,
      // Lương cơ bản DÙNG ĐỂ TÍNH = giá trị đã prorate theo ngày làm
      effective_base: calc.proratedBase,
      bonus,
      deduction,
      total: calc.proratedBase + bonus - deduction,
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
        `SELECT id, base_salary, bonus, deduction, note, status, work_days
         FROM driver_monthly_salary
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

    // ── Tính lương theo ngày làm ──────────────────────────────────────────
    // `work_days` lưu trong DB là giá trị admin SỬA TAY (NULL = tự tính).
    const manualWorkDays =
      payload.workDays !== undefined
        ? (payload.workDays === null || payload.workDays === ''
            ? null
            : Math.max(0, Math.floor(Number(payload.workDays) || 0)))
        : (existing && existing.work_days !== null && existing.work_days !== undefined
            ? existing.work_days
            : null);

    const calc = DriverSalaryCalculator.calculate(driver, year, month, {
      baseSalary: base,
      manualWorkDays,
    });

    // TỔNG = lương theo ngày làm + thưởng − phạt
    const proratedBase = calc.proratedBase;
    const finalTotal = Math.round((proratedBase + bonus - deduction) * 100) / 100;

    try {
      if (existing) {
        // Giữ nguyên trạng thái đã trả nếu không chỉ định lại
        const status = payload.status || existing.status || SALARY_STATUS.PENDING;
        db.prepare(
          `UPDATE driver_monthly_salary
           SET base_salary = ?, bonus = ?, deduction = ?, total = ?, note = ?,
               status = ?,
               work_days = ?,
               daily_rate = ?,
               paid_at = CASE WHEN ? = 'paid' THEN COALESCE(paid_at, datetime('now')) ELSE paid_at END,
               updated_at = datetime('now')
           WHERE id = ?`
        ).run(base, bonus, deduction, finalTotal, note, status, manualWorkDays, calc.dailyRate, status, existing.id);
      } else {
        db.prepare(
          `INSERT INTO driver_monthly_salary
             (driver_id, year, month, base_salary, bonus, deduction, total, status, note, work_days, daily_rate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          driverId,
          year,
          month,
          base,
          bonus,
          deduction,
          finalTotal,
          payload.status || SALARY_STATUS.PENDING,
          note,
          manualWorkDays,
          calc.dailyRate
        );
      }

      return {
        success: true,
        driverId,
        year,
        month,
        total: finalTotal,
        workDays: calc.workDays,
        dailyRate: calc.dailyRate,
        proratedBase,
      };
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
   *
   * Mỗi dòng kèm thông tin tính lương theo ngày làm:
   *   startDate     — ngày vào làm
   *   workDays     — số ngày làm thực tế (không tính Chủ Nhật)
   *   dailyRate    — lương 1 ngày (= lương cơ bản ÷ 26)
   *   proratedBase — lương theo ngày làm
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
        startDate: salary.start_date || d.start_date || null,
        baseSalary: salary.base_salary,
        bonus: salary.bonus,
        deduction: salary.deduction,
        total: salary.total,
        status: salary.status,
        paidAt: salary.paid_at,
        isDraft: !!salary.isDraft,
        note: salary.note,
        // ── Tính lương theo ngày làm ──
        workDays: salary.work_days,
        workDaysManual: !!salary.work_days_manual,
        standardWorkDays: salary.standard_work_days,
        dailyRate: salary.daily_rate,
        proratedBase: salary.prorated_base,
        effectiveBase: salary.effective_base,
        isCurrentMonth: !!salary.is_current_month,
        periodStart: salary.period_start,
        periodEnd: salary.period_end,
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
                status, paid_at, note, work_days, daily_rate, created_at, updated_at
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
module.exports.normalizeStartDate = normalizeStartDate;
