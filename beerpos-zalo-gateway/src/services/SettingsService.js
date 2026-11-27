const SettingsRepository = require('../database/repositories/SettingsRepository');
const AccountRepository = require('../database/repositories/AccountRepository');
const { createProvider } = require('../providers');

/**
 * SettingsService — doc/ghi cau hinh Gateway.
 * KHONG bao gio luu API key o day (key nam trong env).
 */
class SettingsService {
  constructor(repos) {
    this.settings = (repos && repos.settings) || new SettingsRepository();
    this.account = (repos && repos.account) || new AccountRepository();
  }

  getAll() {
    return this.settings.getAll();
  }

  get(key, fallback = null) {
    return this.settings.get(key, fallback);
  }

  set(key, value, opts = {}) {
    const result = this.settings.set(key, value);
    if (opts.audit !== false) {
      // eslint-disable-next-line global-require
      const AuditService = require('./AuditService');
      new AuditService().record({
        action: require('./AuditService').AUDIT_ACTIONS.SETTING_UPDATE,
        entityType: 'setting',
        entityId: key,
        details: { key, value },
      });
    }
    return result;
  }

  getInt(key, fallback) {
    const v = parseInt(this.settings.get(key, ''), 10);
    return Number.isFinite(v) ? v : fallback;
  }

  getBool(key, fallback) {
    const raw = this.settings.get(key, null);
    if (raw === null || raw === undefined || raw === '') return fallback;
    const v = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    return fallback;
  }

  getProviderName() {
    return String(this.settings.get('provider', 'mock')).trim().toLowerCase();
  }

  getMaxAttempts() {
    return this.getInt('worker_max_attempts', 4);
  }

  getRetryDelays() {
    const raw = this.settings.get('retry_delays_ms', '10000,30000,120000,300000');
    const list = String(raw)
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    return list.length ? list : [10000, 30000, 120000, 300000];
  }

  getMaxMessageLength() {
    return this.getInt('max_message_length', 2000);
  }

  /** Lay provider theo cau hinh hien tai. */
  getProvider(opts = {}) {
    return createProvider(this.getProviderName(), opts);
  }

  /** Trang thai tai khoan + provider. */
  async getAccountStatus() {
    const account = this.account.ensure();
    const provider = this.getProvider();
    const status = await provider.getStatus();
    return { account, provider: status };
  }

  /** Bat/tat MockProvider (doi provider hien tai). */
  async setProvider(name, opts = {}) {
    const n = String(name || '').trim().toLowerCase();
    if (!['mock', 'disabled'].includes(n) && n !== 'authorized') {
      throw new Error(`Provider "${n}" khong ho tro`);
    }

    const account = this.account.ensure();
    const isMock = n === 'mock';

    this.settings.set('provider', n);

    this.account.update({
      provider: n,
      connectionMode: isMock ? 'mock' : n === 'disabled' ? 'none' : 'authorized',
      status: n === 'disabled' ? 'disabled' : isMock ? 'not_configured' : 'connected',
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
    });

    if (opts.audit !== false) {
      // eslint-disable-next-line global-require
      const AuditService = require('./AuditService');
      const { AUDIT_ACTIONS } = AuditService;
      new AuditService().record({
        action: AUDIT_ACTIONS.PROVIDER_CHANGE,
        entityType: 'account',
        entityId: account.id,
        details: { from: account.provider, to: n },
      });
    }

    return this.getAccountStatus();
  }
}

module.exports = SettingsService;
