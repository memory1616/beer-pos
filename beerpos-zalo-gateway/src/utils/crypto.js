/**
 * Utils: so sanh chuoi timing-safe + helpers.
 */
const crypto = require('crypto');

/**
 * So sanh 2 chuoi trong thoi gian hang dinh (chong timing attack).
 * @param {string} a
 * @param {string} b
 */
function safeEqual(a, b) {
  const sa = Buffer.from(String(a || ''), 'utf8');
  const sb = Buffer.from(String(b || ''), 'utf8');
  if (sa.length !== sb.length) {
    // Van phai so sanh de tranh leak do dai qua thoi gian.
    crypto.timingSafeEqual(sa, sa);
    return false;
  }
  return crypto.timingSafeEqual(sa, sb);
}

/** Fingerprint khong loi cho log (khong lo API key). */
function fingerprint(key) {
  if (!key) return null;
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 8);
}

/** Chu hoa chuoi: trim + ep kieu string. */
function str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/** Cat ngan toi da. */
function truncate(v, max) {
  const s = str(v);
  return s.length > max ? s.slice(0, max) : s;
}

/** Parse so nguyen, tra null neu khong hop le. */
function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

module.exports = { safeEqual, fingerprint, str, truncate, toInt };
