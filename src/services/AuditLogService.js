/**
 * Audit Log Service — Nhật ký thao tác (A3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mục tiêu: trả lời được "AI đã làm gì, lúc nào, thay đổi gì" cho mọi thao
 * tác quan trọng trên hệ thống.
 *
 * Nguyên tắc thiết kế:
 *  1. GHI LẠI LUÔN — thao tác audit không được làm hỏng thao tác chính.
 *     Lỗi ghi log chỉ được log lại, không ném ra ngoài (fail-open).
 *  2. KHÔNG lưu dữ liệu bí mật — password, token, session… bị lọc bỏ.
 *  3. `changes` chỉ lưu field ĐÃ THAY ĐỔI, kèm giá trị cũ → mới, để admin
 *     thấy chính xác "cái gì đã bị đổi".
 *  4. Hỗ trợ cả ghi tay (explicit) và ghi tự động (middleware) — middleware
 *     chỉ ghi các route MUTATION (POST/PUT/PATCH/DELETE).
 */

const db = require('../../database');
const logger = require('../utils/logger');

// ── Danh mục action ─────────────────────────────────────────────────────────
const ACTIONS = {
  // Đăng nhập / phiên
  LOGIN: 'login',
  LOGIN_FAILED: 'login_failed',
  LOGOUT: 'logout',
  SESSION_REVOKED: 'session_revoked',
  PASSWORD_CHANGED: 'password_changed',
  USER_ACTIVATED: 'user_activated',
  USER_DEACTIVATED: 'user_deactivated',

  // Người dùng
  USER_CREATED: 'user_created',
  USER_UPDATED: 'user_updated',

  // Nghiệp vụ bán hàng
  SALE_CREATED: 'sale_created',
  SALE_UPDATED: 'sale_updated',
  SALE_DELETED: 'sale_deleted',
  PAYMENT_CREATED: 'payment_created',

  // Khách hàng / sản phẩm
  CUSTOMER_CREATED: 'customer_created',
  CUSTOMER_UPDATED: 'customer_updated',
  CUSTOMER_DELETED: 'customer_deleted',
  PRODUCT_CREATED: 'product_created',
  PRODUCT_UPDATED: 'product_updated',
  PRODUCT_DELETED: 'product_deleted',

  // Kho / vỏ
  STOCK_UPDATED: 'stock_updated',
  KEG_UPDATED: 'keg_updated',
  PURCHASE_CREATED: 'purchase_created',

  // Tài chính
  EXPENSE_CREATED: 'expense_created',
  EXPENSE_UPDATED: 'expense_updated',
  EXPENSE_DELETED: 'expense_deleted',

  // Cấu hình
  SETTINGS_UPDATED: 'settings_updated',
  PROMOTION_UPDATED: 'promotion_updated',

  // Hệ thống
  BACKUP_CREATED: 'backup_created',
  REPORT_SENT: 'report_sent',
};

// ── Field KHÔNG BAO GIỜ được ghi vào log ────────────────────────────────────
const SENSITIVE_FIELDS = new Set([
  'password',
  'password_hash',
  'passwordHash',
  'old_password',
  'oldPassword',
  'new_password',
  'newPassword',
  'token',
  'session_token',
  'driver_session_token',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'api_key',
  'apiKey',
  'secret',
  'authorization',
  'cookie',
  'otp',
  'pin',
  'cvv',
  'card_number',
  'zalo_oa_access_token',
  'telegram_bot_token',
  'report_notify_webhook_url',
]);

// Ngưỡng cắt chuỗi — tránh log phình to vô ích
const MAX_STRING = 500;
const MAX_CHANGES_JSON = 8000;

// ── Helpers ─────────────────────────────────────────────────────────────────

function isSensitive(key) {
  if (!key) return false;
  const k = String(key);
  if (SENSITIVE_FIELDS.has(k)) return true;
  const lower = k.toLowerCase();
  if (lower.includes('password')) return true;
  if (lower.includes('token')) return true;
  if (lower.includes('secret')) return true;
  if (lower.endsWith('_hash')) return true;
  return false;
}

/** Rút gọn giá trị để gọn và không lộ dữ liệu nhạy cảm. */
function normalizeValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  }
  if (Array.isArray(value)) {
    // Mảng dài chỉ ghi số lượng + vài phần tử đầu
    if (value.length > 20) {
      return { _truncated: true, length: value.length, sample: value.slice(0, 5) };
    }
    return value.map(normalizeValue);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitive(k)) {
        out[k] = '[REDACTED]';
        continue;
      }
      out[k] = normalizeValue(v);
    }
    return out;
  }
  return String(value);
}

/**
 * So sánh 2 object, trả về chỉ những field ĐÃ THAY ĐỔI.
 * @param {object} before
 * @param {object} after
 * @returns {object|null} { field: { from, to } } hoặc null nếu không đổi
 */
function diffObjects(before, after) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') {
    return null;
  }
  const changed = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (isSensitive(key)) continue;
    const b = before[key];
    const a = after[key];
    if (a === undefined && b === undefined) continue;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    changed[key] = { from: normalizeValue(b), to: normalizeValue(a) };
  }
  return Object.keys(changed).length ? changed : null;
}

/** Lấy IP thật của client (đã tính `trust proxy`). */
function clientIp(req) {
  if (!req) return null;
  try {
    return (req.ip || req.socket?.remoteAddress || null) || null;
  } catch (_) {
    return null;
  }
}

function clientUserAgent(req) {
  if (!req) return null;
  const ua = req.headers?.['user-agent'];
  return ua ? String(ua).slice(0, 300) : null;
}

// ── Ghi log ─────────────────────────────────────────────────────────────────

/**
 * Ghi một dòng nhật ký.
 *
 * FAIL-OPEN: lỗi ghi log KHÔNG được làm hỏng thao tác chính.
 *
 * @param {object} entry
 * @param {string} entry.action - hằng trong ACTIONS (hoặc chuỗi tự do)
 * @param {string} [entry.actorUsername]
 * @param {string} [entry.actorRole]
 * @param {string} [entry.entity] - loại đối tượng: 'sale', 'customer'…
 * @param {string|number} [entry.entityId]
 * @param {string} [entry.description] - mô tả ngắn cho người đọc
 * @param {object} [entry.changes] - diff { field: { from, to } }
 * @param {object} [entry.req] - Express request (để lấy IP + user-agent)
 * @param {string} [entry.status] - 'success' | 'failed'
 * @returns {number|null} id của dòng vừa ghi, null nếu lỗi
 */
function record(entry = {}) {
  try {
    const action = String(entry.action || 'unknown');
    if (!action || action === 'unknown') return null;

    let changesJson = null;
    if (entry.changes && typeof entry.changes === 'object') {
      const safe = {};
      for (const [k, v] of Object.entries(entry.changes)) {
        if (isSensitive(k)) continue;
        safe[k] = v;
      }
      if (Object.keys(safe).length) {
        changesJson = JSON.stringify(safe);
        if (changesJson.length > MAX_CHANGES_JSON) {
          changesJson = changesJson.slice(0, MAX_CHANGES_JSON) + '…';
        }
      }
    }

    const info = db.prepare(
      `INSERT INTO audit_logs
       (actor_username, actor_role, action, entity, entity_id, description,
        changes, ip_address, user_agent, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.actorUsername || null,
      entry.actorRole || null,
      action,
      entry.entity || null,
      entry.entityId !== undefined && entry.entityId !== null ? String(entry.entityId) : null,
      entry.description ? String(entry.description).slice(0, MAX_STRING) : null,
      changesJson,
      entry.ipAddress || clientIp(entry.req),
      entry.userAgent || clientUserAgent(entry.req),
      entry.status === 'failed' ? 'failed' : 'success'
    );

    return info.lastInsertRowid;
  } catch (err) {
    // FAIL-OPEN: chỉ log, không ném
    logger.error('[AUDIT] Failed to write audit log', {
      action: entry.action,
      error: err.message,
    });
    return null;
  }
}

/**
 * Ghi log từ Express request — tự lấy actor từ `req.user`.
 * @param {object} req
 * @param {string} action
 * @param {object} [extra]
 */
function recordFromRequest(req, action, extra = {}) {
  const user = req?.user || {};
  return record({
    action,
    actorUsername: extra.actorUsername || user.username || null,
    actorRole: extra.actorRole || user.role || null,
    entity: extra.entity,
    entityId: extra.entityId,
    description: extra.description,
    changes: extra.changes,
    status: extra.status,
    req,
  });
}

// ── Truy vấn ────────────────────────────────────────────────────────────────

/**
 * Lấy danh sách nhật ký có phân trang + lọc.
 *
 * @param {object} filters
 * @param {number} [filters.limit]
 * @param {number} [filters.offset]
 * @param {string} [filters.actor] - lọc theo username
 * @param {string} [filters.action] - lọc theo action
 * @param {string} [filters.entity] - lọc theo loại đối tượng
 * @param {string} [filters.entityId]
 * @param {string} [filters.from] - YYYY-MM-DD
 * @param {string} [filters.to] - YYYY-MM-DD
 * @param {string} [filters.search] - tìm trong description
 * @returns {{total:number, logs:object[]}}
 */
function list(filters = {}) {
  const where = [];
  const params = [];

  if (filters.actor) {
    where.push('actor_username = ?');
    params.push(String(filters.actor));
  }
  if (filters.action) {
    where.push('action = ?');
    params.push(String(filters.action));
  }
  if (filters.entity) {
    where.push('entity = ?');
    params.push(String(filters.entity));
  }
  if (filters.entityId) {
    where.push('entity_id = ?');
    params.push(String(filters.entityId));
  }
  if (filters.status) {
    where.push('status = ?');
    params.push(String(filters.status));
  }
  if (filters.from) {
    where.push('created_at >= ?');
    params.push(String(filters.from) + ' 00:00:00');
  }
  if (filters.to) {
    where.push('created_at <= ?');
    params.push(String(filters.to) + ' 23:59:59');
  }
  if (filters.search) {
    where.push('(description LIKE ? OR entity LIKE ? OR entity_id LIKE ?)');
    const like = `%${String(filters.search)}%`;
    params.push(like, like, like);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const limit = Math.min(500, Math.max(1, parseInt(filters.limit) || 50));
  const offset = Math.max(0, parseInt(filters.offset) || 0);

  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${clause}`).get(...params).c;

  const rows = db
    .prepare(
      `SELECT id, actor_username, actor_role, action, entity, entity_id,
              description, changes, ip_address, user_agent, status, created_at
       FROM audit_logs ${clause}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  return {
    total,
    limit,
    offset,
    logs: rows.map((r) => ({
      id: r.id,
      actor: r.actor_username,
      role: r.actor_role,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      description: r.description,
      changes: r.changes ? safeParse(r.changes) : null,
      ip: r.ip_address,
      userAgent: r.user_agent,
      status: r.status,
      createdAt: r.created_at,
    })),
  };
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

/** Thống kê nhanh: ai thao tác nhiều nhất trong khoảng thời gian. */
function stats(days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  try {
    const byActor = db
      .prepare(
        `SELECT actor_username AS actor, actor_role AS role, COUNT(*) AS count
         FROM audit_logs
         WHERE created_at >= ? AND actor_username IS NOT NULL
         GROUP BY actor_username
         ORDER BY count DESC
         LIMIT 10`
      )
      .all(since + ' 00:00:00');

    const byAction = db
      .prepare(
        `SELECT action, COUNT(*) AS count
         FROM audit_logs
         WHERE created_at >= ?
         GROUP BY action
         ORDER BY count DESC
         LIMIT 15`
      )
      .all(since + ' 00:00:00');

    const failed = db
      .prepare(
        `SELECT COUNT(*) AS c FROM audit_logs
         WHERE created_at >= ? AND status = 'failed'`
      )
      .get(since + ' 00:00:00').c;

    return { since, byActor, byAction, failed };
  } catch (err) {
    logger.error('[AUDIT] Failed to load stats', { error: err.message });
    return { since, byActor: [], byAction: [], failed: 0 };
  }
}

/** Xoá nhật ký cũ hơn N ngày (dọn dữ liệu). */
function purge(olderThanDays = 90) {
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    const info = db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff);
    logger.info('[AUDIT] Purged old logs', { olderThanDays, deleted: info.changes });
    return { deleted: info.changes, cutoff };
  } catch (err) {
    logger.error('[AUDIT] Failed to purge logs', { error: err.message });
    return { deleted: 0, error: err.message };
  }
}

module.exports = {
  ACTIONS,
  SENSITIVE_FIELDS,
  record,
  recordFromRequest,
  list,
  stats,
  purge,
  diffObjects,
  normalizeValue,
  isSensitive,
};
