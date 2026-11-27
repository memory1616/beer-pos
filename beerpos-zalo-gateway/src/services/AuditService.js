const AuditRepository = require('../database/repositories/AuditRepository');

/** Cac action duoc audit. KHONG ghi API key / secret. */
const AUDIT_ACTIONS = {
  GROUP_CREATE: 'GROUP_CREATE',
  GROUP_UPDATE: 'GROUP_UPDATE',
  GROUP_DEACTIVATE: 'GROUP_DEACTIVATE',
  GROUP_DELETE: 'GROUP_DELETE',
  GROUP_IMPORT: 'GROUP_IMPORT',
  SETTING_UPDATE: 'SETTING_UPDATE',
  ACCOUNT_UPDATE: 'AUDIT_ACCOUNT_UPDATE',
  PROVIDER_CHANGE: 'PROVIDER_CHANGE',
  JOB_RETRY: 'JOB_RETRY',
  JOB_CANCEL: 'JOB_CANCEL',
  API_KEY_ROTATE: 'API_KEY_ROTATE',
};

const FORBIDDEN_KEYS = [
  'apikey',
  'api_key',
  'x-api-key',
  'authorization',
  'password',
  'secret',
  'token',
  'cookie',
];

/** Loai bo truong nhay cam khoi payload audit. */
function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') return details;
  const out = {};
  Object.entries(details).forEach(([k, v]) => {
    if (FORBIDDEN_KEYS.includes(k.toLowerCase())) return;
    out[k] = v;
  });
  return out;
}

class AuditService {
  constructor(repo) {
    this.repo = repo || new AuditRepository();
  }

  /**
   * Ghi 1 thao tac quan trong.
   * @param {object} opts { action, entityType, entityId, details }
   */
  record(opts = {}) {
    try {
      return this.repo.insert({
        action: opts.action,
        entityType: opts.entityType || null,
        entityId: opts.entityId === undefined ? null : opts.entityId,
        details: sanitizeDetails(opts.details),
      });
    } catch (_) {
      // Audit KHONG duoc lam fail luong chinh.
      return null;
    }
  }

  list(opts = {}) {
    return this.repo.list(opts);
  }
}

module.exports = AuditService;
module.exports.AUDIT_ACTIONS = AUDIT_ACTIONS;
module.exports.sanitizeDetails = sanitizeDetails;
