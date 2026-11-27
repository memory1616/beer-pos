const os = require('os');
const { config } = require('../config');
const { getDb } = require('../database/connection');
const SettingsService = require('../services/SettingsService');

/**
 * Health check - KHONG can API key, KHONG lo thong tin nhay cam.
 */
function makeController() {
  return {
    async health(req, res) {
      const payload = {
        status: 'ok',
        version: require('../../package.json').version,
        uptime: Math.floor(process.uptime()),
        environment: config.env,
        database: { ok: false },
        worker: { enabled: config.worker.enabled, running: false },
        provider: { provider: config.provider.name, available: false, simulated: true },
      };

      try {
        const db = getDb();
        db.prepare('SELECT 1').get();
        payload.database.ok = true;
      } catch (e) {
        payload.status = 'degraded';
        payload.database.ok = false;
      }

      // Worker status (neu app da khoi dong).
      if (req.app.locals.worker) {
        const st = req.app.locals.worker.getStatus();
        payload.worker = {
          enabled: config.worker.enabled,
          running: st.state === 'running',
          state: st.state,
          processed: st.stats.processed,
        };
      }

      try {
        const status = await new SettingsService().getAccountStatus();
        payload.provider = {
          provider: status.provider.provider,
          available: status.provider.available,
          simulated: status.provider.simulated === true,
        };
      } catch (_) {
        payload.provider = {
          provider: config.provider.name,
          available: false,
          simulated: true,
        };
      }

      payload.host = os.hostname();
      res.json(payload);
    },
  };
}

module.exports = { makeController };
