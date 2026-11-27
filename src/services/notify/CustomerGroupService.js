/**
 * CustomerGroupService — Quản lý liên kết 1 khách ↔ 1 nhóm Zalo
 * ─────────────────────────────────────────────────────────────────────────────
 * QUY TẮC NGHIỆP VỤ (bất di bất dịch):
 *  - 1 khách hàng = 1 nhóm Zalo = 1 Group ID duy nhất.
 *  - 1 Group ID chỉ thuộc về 1 khách hàng.
 *  - KHÔNG dùng "chọn nhóm mới nhất" để giải quyết dữ liệu trùng.
 *  - Không xoá vật lý bản ghi (giữ dấu vết lịch sử) → chỉ đổi `status`.
 *
 * Ràng buộc được ép ở TẦNG DB (unique index) + kiểm tra trước ở tầng service
 * để trả về lỗi rõ ràng cho UI.
 */

const db = require('../../../database');
const logger = require('../../utils/logger');
const { PLATFORMS, GROUP_STATUS } = require('../debt/constants');

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeGroupId(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  return s;
}

function normalizeGroupName(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  return s || null;
}

/**
 * Kiểm tra khách hàng tồn tại.
 */
function customerExists(customerId) {
  try {
    const row = db.prepare('SELECT id, name, archived FROM customers WHERE id = ?').get(customerId);
    return !!row;
  } catch (_) {
    return false;
  }
}

/**
 * Chuẩn hóa & kiểm tra platform.
 *
 * ⚠️ Chỉ chấp nhận đúng giá trị canonical `PLATFORMS.ZALO_PERSONAL`
 *    ('zalo_personal'). Nếu cho phép platform tùy ý, người dùng có thể tạo
 *    dòng 'zalo' mà mọi truy vấn theo platform chuẩn đều KHÔNG thấy →
 *    mapping "mất hút", vi phạm quy tắc 1 khách = 1 nhóm.
 *
 * @returns {{ok: true, value: string} | {ok: false, error: string, code: string}}
 */
function normalizePlatform(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
  if (!raw) return { ok: true, value: PLATFORMS.ZALO_PERSONAL };

  // Cho phép 1 số bí danh thông dụng → quy về giá trị canonical.
  const ALIASES = {
    zalo: PLATFORMS.ZALO_PERSONAL,
    zalo_personal: PLATFORMS.ZALO_PERSONAL,
    zalo_group: PLATFORMS.ZALO_PERSONAL,
    'zalo-group': PLATFORMS.ZALO_PERSONAL,
  };

  const mapped = ALIASES[raw];
  if (!mapped) {
    return {
      ok: false,
      error:
        `Platform "${raw}" không hợp lệ. Module này chỉ hỗ trợ ` +
        `"${PLATFORMS.ZALO_PERSONAL}" (nhóm Zalo cá nhân).`,
      code: 'UNSUPPORTED_PLATFORM',
    };
  }
  return { ok: true, value: mapped };
}

/**
 * Tìm liên kết hiện tại của khách (bất kể status) theo platform.
 */
function findByCustomer(customerId, platform = PLATFORMS.ZALO_PERSONAL) {
  try {
    return (
      db
        .prepare(
          `SELECT g.*, c.name AS customer_name
             FROM debt_customer_groups g
             LEFT JOIN customers c ON c.id = g.customer_id
            WHERE g.customer_id = ? AND g.platform = ?
            ORDER BY g.id ASC
            LIMIT 1`
        )
        .get(customerId, platform) || null
    );
  } catch (_) {
    return null;
  }
}

/**
 * Tìm liên kết theo group id.
 */
function findByGroupId(groupId, platform = PLATFORMS.ZALO_PERSONAL) {
  try {
    return (
      db
        .prepare(
          `SELECT g.*, c.name AS customer_name
             FROM debt_customer_groups g
             LEFT JOIN customers c ON c.id = g.customer_id
            WHERE g.platform = ? AND g.group_id = ?
            LIMIT 1`
        )
        .get(platform, String(groupId)) || null
    );
  } catch (_) {
    return null;
  }
}

/**
 * Liệt kê tất cả liên kết (cho UI).
 *
 * @param {object} opts { includeInactive, customerId, platform }
 */
function list(opts = {}) {
  try {
    const plat = normalizePlatform(opts.platform);
    const platform = plat.ok ? plat.value : PLATFORMS.ZALO_PERSONAL;
    const where = ['g.platform = ?'];
    const params = [platform];

    if (!opts.includeInactive) where.push("g.status = 'active'");
    if (opts.customerId) {
      where.push('g.customer_id = ?');
      params.push(parseInt(opts.customerId, 10));
    }

    const rows = db
      .prepare(
        `SELECT g.*, c.name AS customer_name, c.phone AS customer_phone
           FROM debt_customer_groups g
           LEFT JOIN customers c ON c.id = g.customer_id
          WHERE ${where.join(' AND ')}
          ORDER BY c.name COLLATE NOCASE, g.group_name`
      )
      .all(...params);
    return rows;
  } catch (e) {
    logger.error('[CUSTOMER_GROUP] list error', { error: e.message });
    return [];
  }
}

/**
 * Tạo hoặc cập nhật liên kết nhóm cho 1 khách hàng.
 *
 * @param {object} opts
 *   - customerId, groupId, groupName, platform, status
 *   - allowChange (boolean): cho phép ĐỔI group id của nhóm đang liên kết.
 *        Mặc định false → nếu khách đang có 1 nhóm active khác → từ chối
 *        (đúng quy tắc "1 khách không thể liên kết 2 nhóm").
 * @returns {{success:boolean, error?:string, code?:string, data?:object}}
 */
function upsert(opts = {}) {
  const plat = normalizePlatform(opts.platform);
  if (!plat.ok) {
    return { success: false, error: plat.error, code: plat.code };
  }
  const platform = plat.value;
  const custId = parseInt(opts.customerId, 10);
  const groupId = normalizeGroupId(opts.groupId);
  const allowChange = opts.allowChange === true;

  if (!custId || Number.isNaN(custId) || custId <= 0) {
    return { success: false, error: 'customerId không hợp lệ', code: 'INVALID_CUSTOMER_ID' };
  }
  if (!groupId) {
    return {
      success: false,
      error: 'Group ID không được để trống',
      code: 'EMPTY_GROUP_ID',
    };
  }
  if (!customerExists(custId)) {
    return {
      success: false,
      error: 'Không tìm thấy khách hàng',
      code: 'CUSTOMER_NOT_FOUND',
    };
  }

  const groupName = normalizeGroupName(opts.groupName);
  const status = opts.status === GROUP_STATUS.INACTIVE ? GROUP_STATUS.INACTIVE : GROUP_STATUS.ACTIVE;

  try {
    // 1. Group ID đã thuộc khách KHÁC → lỗi rõ ràng (không tự ý ghi đè).
    const byGroup = findByGroupId(groupId, platform);
    if (byGroup && byGroup.customer_id !== custId) {
      return {
        success: false,
        error: `Group ID này đã được liên kết cho khách "${byGroup.customer_name || byGroup.customer_id}"`,
        code: 'GROUP_ID_TAKEN',
        data: { conflictCustomerId: byGroup.customer_id },
      };
    }

    // 2. Khách đang có 1 nhóm khác → KHÔNG cho tạo nhóm thứ 2.
    //    → cần gỡ (inactive) nhóm cũ trước, hoặc dùng chính endpoint này
    //      để ĐỔI group id của nhóm đang active (allowChange).
    const byCustomer = findByCustomer(custId, platform);
    if (byCustomer && String(byCustomer.group_id) !== groupId) {
      const hasActive = byCustomer.status === GROUP_STATUS.ACTIVE;
      if (hasActive && !allowChange) {
        return {
          success: false,
          error:
            'Khách hàng đang được liên kết với 1 nhóm Zalo khác. ' +
            'Quy tắc 1 khách = 1 nhóm: hãy gỡ liên kết cũ trước khi liên kết nhóm mới.',
          code: 'CUSTOMER_ALREADY_HAS_GROUP',
          data: { existing: byCustomer },
        };
      }
    }

    // 3. Ghi
    let rowId;
    if (byCustomer) {
      // ĐỔI group id / tên / trạng thái của nhóm đang có.
      db.prepare(
        `UPDATE debt_customer_groups
            SET group_id = ?, group_name = ?, status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(groupId, groupName, status, byCustomer.id);
      rowId = byCustomer.id;
    } else {
      const info = db
        .prepare(
          `INSERT INTO debt_customer_groups (customer_id, platform, group_id, group_name, status)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(custId, platform, groupId, groupName, status);
      rowId = info.lastInsertRowid;
    }

    return { success: true, data: findByCustomer(custId, platform) || { id: rowId } };
  } catch (e) {
    // Unique index (platform, customer_id) / (platform, group_id) có thể bắt
    // race condition → trả lỗi thân thiện thay vì 500.
    if (/UNIQUE constraint/i.test(e.message)) {
      logger.warn('[CUSTOMER_GROUP] Upsert bị chặn bởi ràng buộc 1:1', { error: e.message });
      return {
        success: false,
        error: 'Vi phạm ràng buộc 1 khách ↔ 1 nhóm Zalo (group id hoặc khách đã bị trùng)',
        code: 'DUPLICATE_MAPPING',
      };
    }
    logger.error('[CUSTOMER_GROUP] upsert error', { error: e.message });
    return { success: false, error: e.message, code: 'DB_ERROR' };
  }
}

/**
 * Ngắt liên kết (KHÔNG xoá vật lý — giữ dấu vết lịch sử).
 */
function unlink(id, opts = {}) {
  const rowId = parseInt(id, 10);
  if (!rowId || Number.isNaN(rowId)) {
    return { success: false, error: 'id không hợp lệ', code: 'INVALID_ID' };
  }
  try {
    const existing = db.prepare('SELECT * FROM debt_customer_groups WHERE id = ?').get(rowId);
    if (!existing) {
      return { success: false, error: 'Không tìm thấy liên kết', code: 'NOT_FOUND' };
    }
    db.prepare(
      `UPDATE debt_customer_groups
          SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(GROUP_STATUS.INACTIVE, rowId);
    return {
      success: true,
      data: { ...existing, status: GROUP_STATUS.INACTIVE },
      reason: opts.reason || null,
    };
  } catch (e) {
    logger.error('[CUSTOMER_GROUP] unlink error', { error: e.message });
    return { success: false, error: e.message, code: 'DB_ERROR' };
  }
}

/**
 * Bật/tắt trạng thái liên kết.
 */
function setStatus(id, status) {
  const rowId = parseInt(id, 10);
  if (!rowId || Number.isNaN(rowId)) {
    return { success: false, error: 'id không hợp lệ', code: 'INVALID_ID' };
  }
  const next = status === GROUP_STATUS.ACTIVE ? GROUP_STATUS.ACTIVE : GROUP_STATUS.INACTIVE;
  try {
    const existing = db.prepare('SELECT * FROM debt_customer_groups WHERE id = ?').get(rowId);
    if (!existing) {
      return { success: false, error: 'Không tìm thấy liên kết', code: 'NOT_FOUND' };
    }
    db.prepare(
      `UPDATE debt_customer_groups
          SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(next, rowId);
    return { success: true, data: { ...existing, status: next } };
  } catch (e) {
    logger.error('[CUSTOMER_GROUP] setStatus error', { error: e.message });
    return { success: false, error: e.message, code: 'DB_ERROR' };
  }
}

/**
 * Kiểm tra trùng trước khi lưu (dùng cho UI cảnh báo).
 *
 * @returns {{duplicateCustomer:boolean, duplicateGroup:boolean,
 *            customerGroup:object|null, groupOwner:object|null}}
 */
function checkConflicts(opts = {}) {
  const plat = normalizePlatform(opts.platform);
  const platform = plat.ok ? plat.value : PLATFORMS.ZALO_PERSONAL;
  const custId = parseInt(opts.customerId, 10);
  const groupId = normalizeGroupId(opts.groupId);

  const byCustomer = custId ? findByCustomer(custId, platform) : null;
  const byGroup = groupId ? findByGroupId(groupId, platform) : null;

  return {
    duplicateCustomer: !!(byCustomer && byCustomer.group_id !== groupId),
    duplicateGroup: !!(byGroup && byGroup.customer_id !== custId),
    customerGroup: byCustomer,
    groupOwner: byGroup,
  };
}

module.exports = {
  list,
  upsert,
  unlink,
  setStatus,
  checkConflicts,
  findByCustomer,
  findByGroupId,
  customerExists,
  normalizePlatform,
};
