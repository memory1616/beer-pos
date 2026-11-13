/**
 * DebtAuditService — Nhật ký thay đổi của sổ công nợ
 * ─────────────────────────────────────────────────────────────────────────────
 * Nguyên tắc:
 *  1. FAIL-OPEN khi gọi ngoài transaction (lỗi log không làm hỏng nghiệp vụ).
 *  2. Khi gọi BÊN TRONG một `db.transaction()` → dữ liệu audit được ghi cùng
 *     lúc với bút toán (đảm bảo "mọi thay đổi đều có audit log").
 *  3. Không bao giờ ghi dữ liệu nhạy cảm (token/secret) — chỉ ghi before/after
 *     của các field nghiệp vụ công nợ.
 */

const db = require('../../../database');
const logger = require('../../utils/logger');
const { AUDIT_ACTIONS } = require('./constants');

// Ngưỡng cắt chuỗi — tránh log phình to vô ích
const MAX_STRING = 500;
const MAX_JSON = 8000;

/** Field KHÔNG BAO GIỜ được ghi vào audit log. */
const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'secret_key',
  'cookie',
  'session_token',
]);

function isSensitive(key) {
  if (!key) return false;
  const k = String(key);
  if (SENSITIVE_KEYS.has(k)) return true;
  const lower = k.toLowerCase();
  return (
    lower.includes('password') ||
    lower.includes('token') ||
    lower.includes('secret') ||
    lower.endsWith('_hash')
  );
}

/** Rút gọn giá trị an toàn để lưu vào log. */
function normalize(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(normalize);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitive(k)) {
        out[k] = '[REDACTED]';
        continue;
      }
      out[k] = normalize(v);
    }
    return out;
  }
  return String(value);
}

function serialize(data) {
  if (data === null || data === undefined) return null;
  try {
    const json = JSON.stringify(normalize(data));
    if (!json) return null;
    return json.length > MAX_JSON ? json.slice(0, MAX_JSON) + '…' : json;
  } catch (_) {
    return null;
  }
}

/**
 * Ghi một dòng audit log của sổ công nợ.
 *
 * @param {object} entry
 * @param {number} [entry.transactionId] - id bút toán liên quan
 * @param {string} entry.action - hằng trong AUDIT_ACTIONS
 * @param {string} [entry.actorId] - username nhân viên (null = hệ thống)
 * @param {object} [entry.beforeData]
 * @param {object} [entry.afterData]
 * @returns {number|null} id vừa ghi, null nếu lỗi
 */
function record(entry = {}) {
  try {
    const action = String(entry.action || '').trim();
    if (!action) return null;

    const info = db
      .prepare(
        `INSERT INTO debt_audit_logs
           (transaction_id, action, actor_id, before_data, after_data)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        entry.transactionId ?? null,
        action,
        entry.actorId || null,
        serialize(entry.beforeData),
        serialize(entry.afterData)
      );

    return info.lastInsertRowid;
  } catch (err) {
    // FAIL-OPEN: chỉ log, không ném — tránh làm hỏng thao tác chính.
    logger.error('[DEBT_AUDIT] Failed to write audit log', {
      action: entry.action,
      error: err.message,
    });
    return null;
  }
}

/** Lấy lịch sử audit của 1 khách (mới nhất trước). */
function listByCustomer(customerId, limit = 100) {
  try {
    return db
      .prepare(
        `SELECT dal.*, dt.transaction_type, dt.amount AS tx_amount
           FROM debt_audit_logs dal
           LEFT JOIN debt_transactions dt ON dt.id = dal.transaction_id
          WHERE dt.customer_id = ?
          ORDER BY dal.id DESC
          LIMIT ?`
      )
      .all(customerId, limit);
  } catch (err) {
    logger.error('[DEBT_AUDIT] listByCustomer error', { error: err.message });
    return [];
  }
}

module.exports = {
  record,
  listByCustomer,
  normalize,
  isSensitive,
  AUDIT_ACTIONS,
};
