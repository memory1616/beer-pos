const SettingsService = require('../services/SettingsService');
const AuditService = require('../services/AuditService');
const GroupService = require('../services/GroupService');
const QueueService = require('../services/QueueService');
const { badRequest } = require('../utils/errors');

function makeController(repos) {
  const settings = (repos && repos.settings) || new SettingsService();
  const audit = (repos && repos.audit) || new AuditService();
  const groups = (repos && repos.groups) || new GroupService();
  const queue = (repos && repos.queue) || new QueueService();

  return {
    /** Trang thai tai khoan + provider. */
    async accountStatus(req, res) {
      const status = await settings.getAccountStatus();
      res.json({
        success: true,
        account: {
          provider: status.account.provider,
          displayName: status.account.display_name,
          status: status.account.status,
          connectionMode: status.account.connection_mode,
          lastCheckedAt: status.account.last_checked_at,
          lastError: status.account.last_error,
        },
        provider: status.provider,
      });
    },

    /** Bat/tat MockProvider / doi provider. */
    async setProvider(req, res) {
      const provider = String(req.body?.provider || '').trim().toLowerCase();
      if (!provider) {
        throw badRequest('Thieu truong provider', 'VALIDATION_ERROR');
      }
      const status = await settings.setProvider(provider);
      res.json({
        success: true,
        account: {
          provider: status.account.provider,
          status: status.account.status,
          connectionMode: status.account.connection_mode,
        },
        provider: status.provider,
      });
    },

    /** Danh sach cau hinh (khong nhay cam). */
    async listSettings(req, res) {
      res.json({ success: true, settings: settings.getAll() });
    },

    async updateSetting(req, res) {
      const { key, value } = req.body || {};
      if (!key) throw badRequest('Thieu key', 'VALIDATION_ERROR');

      const forbidden = ['api_key', 'apikey', 'secret', 'password', 'token'];
      if (forbidden.includes(String(key).toLowerCase())) {
        throw badRequest('Khong cho phep luu thong tin bi mat trong settings', 'FORBIDDEN');
      }

      settings.set(key, value);
      res.json({ success: true, key, value: settings.get(key) });
    },

    /** Dashboard summary. */
    async dashboard(req, res) {
      const status = await settings.getAccountStatus();
      const counts = queue.countsByStatus();

      res.json({
        success: true,
        gateway: {
          status: 'ok',
          version: require('../../package.json').version,
          environment: require('../config').config.env,
        },
        account: {
          provider: status.account.provider,
          displayName: status.account.display_name,
          status: status.account.status,
          connectionMode: status.account.connection_mode,
          lastCheckedAt: status.account.last_checked_at,
          lastError: status.account.last_error,
        },
        provider: status.provider,
        groups: {
          total: groups.repo.countAll(),
          active: groups.repo.countActive(),
          customers: groups.repo.countActive(),
        },
        jobs: counts,
      });
    },

    /** Audit log. */
    async auditLogs(req, res) {
      const result = audit.list({
        action: req.query.action,
        entityType: req.query.entityType,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json({ success: true, ...result });
    },
  };
}

module.exports = { makeController };
