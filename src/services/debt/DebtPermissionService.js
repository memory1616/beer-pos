/**
 * DebtPermissionService — Phân quyền module Sổ Công nợ
 * ─────────────────────────────────────────────────────────────────────────────
 * Vai trò:
 *   ADMIN  : toàn quyền (xem/ghi/điều chỉnh/đảo/quản lý nhóm/phân quyền/lịch sử)
 *   STAFF  : CHỈ ghi nhận thanh toán cho khách hàng được phân công
 *            + ghi nợ tay (lệnh `-`) cho khách được phân công
 *            + xem sổ công nợ của khách được phân công
 *            KHÔNG: xoá giao dịch, tự điều chỉnh công nợ, đổi mapping khách
 *   CUSTOMER: KHÔNG có quyền ghi giao dịch qua lệnh bot
 *
 * Nguồn dữ liệu phân công: bảng `debt_staff_permissions`
 *   (staff_id = username trong `app_users`, customer_id FK→customers)
 */

const db = require('../../../database');
const logger = require('../../utils/logger');
const { PERMISSION_STATUS } = require('./constants');

// ── Roles ───────────────────────────────────────────────────────────────────
const ROLE_ADMIN = 'ADMIN';
const ROLE_STAFF = 'STAFF';
const ROLE_DRIVER = 'DRIVER';
const ROLE_CUSTOMER = 'CUSTOMER';

// Hành động được phép
const ACTIONS = {
  VIEW_ALL: 'VIEW_ALL', // xem toàn bộ sổ công nợ
  VIEW_ASSIGNED: 'VIEW_ASSIGNED', // xem khách được phân công
  RECORD_PAYMENT: 'RECORD_PAYMENT', // ghi nhận thanh toán
  RECORD_MANUAL_DEBT: 'RECORD_MANUAL_DEBT', // ghi nợ tay (lệnh `-`)
  ADJUST: 'ADJUST', // điều chỉnh công nợ (ADMIN)
  REVERSE: 'REVERSE', // đảo giao dịch (ADMIN)
  MANAGE_GROUPS: 'MANAGE_GROUPS', // quản lý nhóm Zalo (ADMIN)
  MANAGE_PERMISSIONS: 'MANAGE_PERMISSIONS', // phân quyền (ADMIN)
  VIEW_AUDIT: 'VIEW_AUDIT', // xem lịch sử audit (ADMIN)
  RECONCILE: 'RECONCILE', // đối soát (ADMIN)
};

/**
 * Chuẩn hóa thông tin người dùng từ session.
 * @param {object} user - req.user
 * @returns {{username:string, role:string, isAdmin:boolean, isStaff:boolean, isDriver:boolean}}
 */
function normalizeUser(user) {
  const username = (user && (user.username || user.app_user_name)) || null;
  let role = (user && user.role) || null;

  // Không có role trong session → tra cứu `app_users`
  if (!role && username) {
    try {
      const row = db
        .prepare('SELECT role FROM app_users WHERE username = ? AND active = 1')
        .get(username);
      if (row) role = row.role;
    } catch (_) {
      /* ignore */
    }
  }

  role = role || ROLE_CUSTOMER;

  return {
    username,
    role,
    isAdmin: role === ROLE_ADMIN,
    isStaff: role === ROLE_STAFF,
    isDriver: role === ROLE_DRIVER,
  };
}

/**
 * Nhân viên có được phân công khách hàng này không?
 * @param {string} staffId - username
 * @param {number} customerId
 */
function isAssignedToCustomer(staffId, customerId) {
  if (!staffId || !customerId) return false;
  try {
    const row = db
      .prepare(
        `SELECT id FROM debt_staff_permissions
          WHERE staff_id = ? AND customer_id = ? AND status = ?`
      )
      .get(String(staffId), parseInt(customerId, 10), PERMISSION_STATUS.ACTIVE);
    return !!row;
  } catch (e) {
    logger.error('[DEBT_PERM] isAssignedToCustomer error', { error: e.message });
    return false;
  }
}

/**
 * Kiểm tra 1 nhân viên có quyền ghi nhận thanh toán cho khách hàng.
 * - ADMIN → luôn có (kể cả khi chưa được phân công).
 * - STAFF → phải được phân công (`can_record_payment = 1`).
 * - DRIVER / CUSTOMER → không.
 */
function canRecordPayment(user, customerId) {
  const u = normalizeUser(user);
  if (u.isAdmin) return true;
  if (!u.isStaff) return false;

  try {
    const row = db
      .prepare(
        `SELECT can_record_payment FROM debt_staff_permissions
          WHERE staff_id = ? AND customer_id = ? AND status = ?`
      )
      .get(String(u.username), parseInt(customerId, 10), PERMISSION_STATUS.ACTIVE);
    return !!row && Number(row.can_record_payment) === 1;
  } catch (e) {
    logger.error('[DEBT_PERM] canRecordPayment error', { error: e.message });
    return false;
  }
}

/**
 * Quyền ghi nợ tay (lệnh `-`): giống quyền ghi thanh toán (nhân viên được phân công).
 */
function canRecordManualDebt(user, customerId) {
  const u = normalizeUser(user);
  if (u.isAdmin) return true;
  return canRecordPayment(user, customerId);
}

/**
 * Quyền XEM khách hàng này.
 * - ADMIN → tất cả.
 * - STAFF → chỉ khách được phân công.
 */
function canViewCustomer(user, customerId) {
  const u = normalizeUser(user);
  if (u.isAdmin) return true;
  if (u.isStaff) return isAssignedToCustomer(u.username, customerId);
  return false;
}

/**
 * Ma trận quyền theo hành động.
 */
function hasAction(user, action) {
  const u = normalizeUser(user);

  if (u.isAdmin) return true;

  switch (action) {
    case ACTIONS.VIEW_ALL:
    case ACTIONS.ADJUST:
    case ACTIONS.REVERSE:
    case ACTIONS.MANAGE_GROUPS:
    case ACTIONS.MANAGE_PERMISSIONS:
    case ACTIONS.VIEW_AUDIT:
    case ACTIONS.RECONCILE:
      return false; // chỉ ADMIN

    case ACTIONS.VIEW_ASSIGNED:
      return u.isStaff;

    case ACTIONS.RECORD_PAYMENT:
    case ACTIONS.RECORD_MANUAL_DEBT:
      return u.isStaff; // còn cần kiểm tra phân công theo khách

    default:
      return false;
  }
}

/**
 * Danh sách khách hàng được phân công cho 1 nhân viên.
 */
function listAssignedCustomers(staffId) {
  if (!staffId) return [];
  try {
    return db
      .prepare(
        `SELECT c.id, c.name, c.phone, c.debt,
                p.can_record_payment, p.status AS permission_status
           FROM debt_staff_permissions p
           JOIN customers c ON c.id = p.customer_id
          WHERE p.staff_id = ? AND p.status = ?
          ORDER BY c.name ASC`
      )
      .all(String(staffId), PERMISSION_STATUS.ACTIVE);
  } catch (e) {
    logger.error('[DEBT_PERM] listAssignedCustomers error', { error: e.message });
    return [];
  }
}

/**
 * Phân công (hoặc thu hồi) quyền của nhân viên cho khách hàng.
 * @param {string} staffId
 * @param {number} customerId
 * @param {object} opts { canRecordPayment, status, actorId }
 */
function setPermission(staffId, customerId, opts = {}) {
  const staff = String(staffId || '');
  const custId = parseInt(customerId, 10);

  if (!staff || !custId || Number.isNaN(custId)) {
    return { success: false, error: 'Thiếu staffId hoặc customerId' };
  }

  const canPay = opts.canRecordPayment === false ? 0 : 1;
  const status = opts.status || PERMISSION_STATUS.ACTIVE;

  try {
    const existing = db
      .prepare(
        'SELECT id FROM debt_staff_permissions WHERE staff_id = ? AND customer_id = ?'
      )
      .get(staff, custId);

    if (existing) {
      db.prepare(
        `UPDATE debt_staff_permissions
            SET can_record_payment = ?, status = ?, created_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(canPay, status, existing.id);
    } else {
      db.prepare(
        `INSERT INTO debt_staff_permissions (staff_id, customer_id, can_record_payment, status)
         VALUES (?, ?, ?, ?)`
      ).run(staff, custId, canPay, status);
    }

    return { success: true, staffId: staff, customerId: custId, canRecordPayment: canPay, status };
  } catch (e) {
    logger.error('[DEBT_PERM] setPermission error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Thu hồi quyền của nhân viên với khách hàng.
 */
function revokePermission(staffId, customerId) {
  try {
    const info = db
      .prepare('DELETE FROM debt_staff_permissions WHERE staff_id = ? AND customer_id = ?')
      .run(String(staffId), parseInt(customerId, 10));
    return { success: true, removed: info.changes };
  } catch (e) {
    logger.error('[DEBT_PERM] revokePermission error', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Danh sách tất cả nhân viên có thể được phân quyền (app_users role STAFF/DRIVER).
 */
function listStaffUsers() {
  try {
    return db
      .prepare(
        `SELECT username, full_name, role, active FROM app_users
          WHERE role IN ('STAFF','DRIVER','ADMIN')
          ORDER BY role, username`
      )
      .all();
  } catch (e) {
    logger.error('[DEBT_PERM] listStaffUsers error', { error: e.message });
    return [];
  }
}

module.exports = {
  ROLE_ADMIN,
  ROLE_STAFF,
  ROLE_DRIVER,
  ROLE_CUSTOMER,
  ACTIONS,
  normalizeUser,
  isAssignedToCustomer,
  canRecordPayment,
  canRecordManualDebt,
  canViewCustomer,
  hasAction,
  listAssignedCustomers,
  listStaffUsers,
  setPermission,
  revokePermission,
};
