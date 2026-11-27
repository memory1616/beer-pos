const { safeEqual, fingerprint } = require('../utils/crypto');
const { unauthorized, forbidden } = require('../utils/errors');
const { config } = require('../config');
const logger = require('../logger');

/**
 * Lay API key tu request.
 * Uu tien header `X-API-Key`, fallback `Authorization: Bearer <key>`.
 */
function extractKey(req) {
  const header = req.headers['x-api-key'];
  if (header) return String(header).trim();
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

function keyMatches(candidate, expected) {
  if (!candidate || !expected) return false;
  if (Array.isArray(expected)) {
    return expected.some((k) => k && safeEqual(candidate, k));
  }
  return safeEqual(candidate, expected);
}

/**
 * Middleware xac thuc theo nhieu nhom quyen (OR).
 * Dung khi mot endpoint phai doc (lich su, hang doi) ma ca Admin va Integration
 * deu can xem; chi endpoint "gui tin" moi duoc gioi han rieng cho Integration.
 * @param {Array<'admin'|'integration'>} scopes
 */
function requireAnyScope(scopes) {
  return (req, res, next) => {
    const key = extractKey(req);
    if (!key) return next(unauthorized('Thieu API key', 'UNAUTHORIZED'));

    const all = {
      admin: [config.auth.adminKey, ...(config.auth.adminKeys || [])],
      integration: [config.auth.integrationKey, ...(config.auth.integrationKeys || [])],
    };

    for (const scope of scopes) {
      if (keyMatches(key, all[scope])) {
        req.apiKeyFingerprint = fingerprint(key);
        req.apiScope = scope;
        return next();
      }
    }

    logger.warn('[AUTH] Tu choi truy cap', {
      scopes,
      keyFingerprint: fingerprint(key),
      path: req.originalUrl,
    });

    // Key hop le cua nhom KHAC -> 403 (khong phai 401).
    for (const scope of scopes) {
      const other = scope === 'admin' ? 'integration' : 'admin';
      if (keyMatches(key, all[other])) {
        return next(
          forbidden(
            `API key nay chi duoc dung cho phien "${other}", khong dung cho phien "${scope}"`,
            'FORBIDDEN'
          )
        );
      }
    }

    return next(unauthorized('API key khong hop le', 'UNAUTHORIZED'));
  };
}

/**
 * Middleware xac thuc theo nhom quyen.
 * @param {'admin'|'integration'} scope
 */
function requireApiKey(scope) {
  return (req, res, next) => {
    const key = extractKey(req);

    if (!key) {
      return next(unauthorized('Thieu API key', 'UNAUTHORIZED'));
    }

    const allowed =
      scope === 'admin'
        ? [config.auth.adminKey, ...(config.auth.adminKeys || [])]
        : [config.auth.integrationKey, ...(config.auth.integrationKeys || [])];

    if (!keyMatches(key, allowed)) {
      logger.warn('[AUTH] Tu choi truy cap', {
        scope,
        keyFingerprint: fingerprint(key),
        path: req.originalUrl,
      });
      // Key hop le cua nhom KHAC -> 403 (khong phai 401).
      const otherScope = scope === 'admin' ? 'integration' : 'admin';
      const otherAllowed =
        otherScope === 'admin'
          ? [config.auth.adminKey, ...(config.auth.adminKeys || [])]
          : [config.auth.integrationKey, ...(config.auth.integrationKeys || [])];

      if (keyMatches(key, otherAllowed)) {
        return next(
          forbidden(
            `API key nay chi duoc dung cho phien "${otherScope}", khong dung cho phien "${scope}"`,
            'FORBIDDEN'
          )
        );
      }

      // Key khong hop le hoan toan.
      return next(
        scope === 'admin'
          ? forbidden('API key khong co quyen quan tri', 'FORBIDDEN')
          : unauthorized('API key khong hop le', 'UNAUTHORIZED')
      );
    }

    // KHONG luu key vao req (tranh ro trong log).
    req.apiKeyFingerprint = fingerprint(key);
    req.apiScope = scope;
    return next();
  };
}

module.exports = { requireApiKey, requireAnyScope, extractKey };
