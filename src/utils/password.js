/**
 * Password Hashing Utility — Driver Portal
 * ─────────────────────────────────────────────────────────────────────────────
 * Dùng crypto.scrypt của Node.js (built-in, không cần dependency ngoài).
 *
 * Format lưu trong DB:  scrypt$N$r$p$<saltHex>$<hashHex>
 * - salt: 16 bytes random
 * - hash: 64 bytes (derived key length)
 *
 * KHÔNG BAO GIỜ lưu mật khẩu dạng plaintext.
 */

const crypto = require('crypto');

const SALT_BYTES = 16;
const KEY_LENGTH = 64;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const MAXMEM = 64 * 1024 * 1024;

/**
 * Hash password with random salt
 * @param {string} password - plain password
 * @returns {string} encoded hash string
 */
function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password required');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verify password against encoded hash (timing-safe)
 * @param {string} password - plain password
 * @param {string} encoded - stored hash string
 * @returns {boolean}
 */
function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || !encoded || typeof encoded !== 'string') return false;

  const parts = encoded.split('$');
  // format: scrypt$N$r$p$salt$hash
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  if (!N || !r || !p) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'hex');
    expected = Buffer.from(parts[5], 'hex');
  } catch (_) {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: MAXMEM,
    });
  } catch (_) {
    return false;
  }

  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Password strength check (minimum policy for driver accounts)
 * @returns {{valid: boolean, error: string|null}}
 */
function validatePasswordStrength(password) {
  if (!password || typeof password !== 'string' || password.length < 8) {
    return { valid: false, error: 'Mật khẩu phải có ít nhất 8 ký tự' };
  }
  if (password.length > 200) {
    return { valid: false, error: 'Mật khẩu quá dài' };
  }
  return { valid: true, error: null };
}

module.exports = { hashPassword, verifyPassword, validatePasswordStrength };
