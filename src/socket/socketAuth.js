/**
 * Socket.IO Authentication Helpers — A4
 * ─────────────────────────────────────────────────────────────────────────────
 * Tách riêng khỏi socketServer.js để:
 *  - Test được logic xác thực handshake mà không cần mở socket thật.
 *  - socketServer.js giữ đúng vai trò "transport", không lẫn logic auth.
 *
 * Bối cảnh (vấn đề đang sửa):
 *  - Socket.IO server TRƯỚC ĐÂY cho phép mọi client kết nối không cần token.
 *  - Driver Portal gửi `mode=driver` nhưng client map thành room `admin`
 *    → tài xế nhận event `order:created` chứa cột `profit` (rò rỉ tài chính).
 *
 * Nguyên tắc:
 *  1. Role lấy từ SESSION trong DB — KHÔNG tin `mode` do client gửi.
 *  2. Token lấy từ `handshake.auth.token` → `handshake.query.token` → cookie.
 *  3. Payload gửi cho driver được sanitize (bỏ field tài chính).
 */

// ── Roles & Rooms ───────────────────────────────────────────────────────────
const ROLE_ADMIN = 'ADMIN';
const ROLE_DRIVER = 'DRIVER';

const ROOM_ADMIN = 'admin';
const ROOM_DRIVER = 'driver';
const ROOM_PUBLIC = 'public';

// Cookie chứa session token (httpOnly → JS không đọc được, browser tự gửi kèm
// handshake WebSocket cùng origin).
const SESSION_COOKIE_NAMES = ['session_token', 'driver_session_token'];

// Field bị loại khỏi payload gửi cho tài xế (ngoài FORBIDDEN_FIELDS của
// middleware/permissions.js).
const DRIVER_EXTRA_FORBIDDEN = new Set([
  'total',
  'total_amount',
  'total_debt',
  'debt',
  'amount',
  'sale_total',
  'revenue_total',
  'purchase_price',
  'margin',
  'margin_percent',
]);

// Dùng CHUNG bộ field nhạy cảm với middleware/permissions.js để không bị
// lệch nhau — mọi key mà REST API đã chặn thì WebSocket cũng phải chặn.
const { FORBIDDEN_FIELDS } = require('../../middleware/permissions');

/**
 * Key có chứa field tài chính nhạy cảm không (case-insensitive).
 * @param {string} key
 * @returns {boolean}
 */
function isSensitiveKey(key) {
  if (DRIVER_EXTRA_FORBIDDEN.has(key)) return true;
  // Bộ chung với REST API (cost, totalCost, returned_profit, …)
  if (FORBIDDEN_FIELDS.has(key)) return true;
  if (/profit/i.test(key)) return true;
  if (/cost_?price/i.test(key)) return true;
  if (/margin/i.test(key)) return true;
  if (/^revenue/i.test(key)) return true;
  return false;
}

// Field của bản ghi `sales` được phép gửi cho tài xế.
const DRIVER_SAFE_SALE_FIELDS = [
  'id',
  'date',
  'customer_id',
  'driver_username',
  'type',
  'status',
  'archived',
  'deliver_kegs',
  'return_kegs',
];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse header `Cookie` thành object.
 * @param {string|undefined} header
 * @returns {Record<string,string>}
 */
function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch (_) {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * Lấy token từ handshake theo thứ tự ưu tiên:
 *   1. handshake.auth.token   (client gửi chủ động)
 *   2. handshake.query.token   (fallback)
 *   3. cookie session_token / driver_session_token (browser tự gửi)
 *
 * @param {object} handshake
 * @returns {string|null}
 */
function extractToken(handshake) {
  const hs = handshake || {};

  const explicit = [hs.auth?.token, hs.query?.token];
  for (const t of explicit) {
    if (typeof t === 'string' && t.trim()) return t.trim();
  }

  const cookies = parseCookies(hs.headers?.cookie);
  for (const name of SESSION_COOKIE_NAMES) {
    if (cookies[name]) return cookies[name];
  }

  return null;
}

/**
 * Resolve session từ handshake.
 * @param {object} handshake
 * @returns {{username:string, role:string, appUserId:number|null}|null}
 */
function resolveSession(handshake) {
  const token = extractToken(handshake);
  if (!token) return null;
  try {
    // require động để tránh vòng require vòng (auth ↔ socketServer)
    const { getSession } = require('../../middleware/auth');
    return getSession(token) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Room tương ứng với role. Room do SERVER quyết định — client không thể
 * tự khai báo room admin bằng cách gửi `mode=admin`.
 *
 * @param {string} role
 * @returns {string}
 */
function roomForRole(role) {
  return role === ROLE_DRIVER ? ROOM_DRIVER : ROOM_ADMIN;
}

/**
 * Room RIÊNG của 1 tài xế: `driver:<username>`.
 * Dùng để đẩy thông báo "đơn giao mới" chỉ tới đúng tài xế được gán.
 *
 * @param {string} username
 * @returns {string}
 */
function driverRoom(username) {
  return `${ROOM_DRIVER}:${String(username || '').toLowerCase()}`;
}

/**
 * Loại bỏ mọi field tài chính khỏi payload (đệ quy).
 * @param {any} input
 * @param {number} [depth]
 * @returns {any}
 */
function sanitizeForDriver(input, depth = 0) {
  if (depth > 10) return null;
  if (Array.isArray(input)) return input.map((v) => sanitizeForDriver(v, depth + 1));
  if (input && typeof input === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (isSensitiveKey(key)) continue;
      out[key] = sanitizeForDriver(value, depth + 1);
    }
    return out;
  }
  return input;
}

/**
 * Rút gọn bản ghi `sales` xuống các field an toàn cho tài xế.
 * @param {object|null} sale
 * @returns {object}
 */
function driverSalePayload(sale) {
  if (!sale || typeof sale !== 'object') return {};
  const safe = {};
  for (const key of DRIVER_SAFE_SALE_FIELDS) {
    if (key in sale) safe[key] = sale[key];
  }
  return safe;
}

/**
 * Tạo payload `order:*` riêng cho tài xế.
 * @param {object} payload - payload gốc (vd: { sale })
 * @returns {object}
 */
function buildDriverOrderPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'sale') {
      out.sale = driverSalePayload(value);
      continue;
    }
    // Key nhạy cảm ở cấp ngoài cũng phải bị loại (vd: { profit: 12345 }).
    if (isSensitiveKey(key)) continue;
    out[key] = sanitizeForDriver(value);
  }
  return out;
}

module.exports = {
  ROLE_ADMIN,
  ROLE_DRIVER,
  ROOM_ADMIN,
  ROOM_DRIVER,
  ROOM_PUBLIC,
  SESSION_COOKIE_NAMES,
  parseCookies,
  extractToken,
  resolveSession,
  roomForRole,
  driverRoom,
  isSensitiveKey,
  sanitizeForDriver,
  driverSalePayload,
  buildDriverOrderPayload,
};
