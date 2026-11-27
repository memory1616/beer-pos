const express = require('express');
const { requireApiKey, requireAnyScope } = require('../middleware/auth');
const { adminLimiter, sendLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/asyncHandler');
const { makeController: makeHealthController } = require('../controllers/healthController');
const { makeController: makeGroupController } = require('../controllers/groupController');
const { makeController: makeMessageController } = require('../controllers/messageController');
const { makeController: makeAccountController } = require('../controllers/accountController');

/**
 * Tao Express router cho Gateway.
 * @param {object} repos - repository (dung cho test)
 */
function createRouter(repos) {
  const router = express.Router();

  const health = makeHealthController(repos);
  const groups = makeGroupController(repos);
  const messages = makeMessageController(repos);
  const account = makeAccountController(repos);

  // ── Health (public) ───────────────────────────────────────────────────────
  router.get('/health', asyncHandler(health.health));

  // ── Account (admin) ───────────────────────────────────────────────────────
  router.get('/api/account/status', requireApiKey('admin'), asyncHandler(account.accountStatus));
  router.post(
    '/api/account/provider',
    requireApiKey('admin'),
    adminLimiter,
    asyncHandler(account.setProvider)
  );

  // ── Dashboard (admin) ─────────────────────────────────────────────────────
  router.get('/api/dashboard', requireApiKey('admin'), asyncHandler(account.dashboard));

  // ── Groups (admin) ────────────────────────────────────────────────────────
  router.get('/api/groups', requireApiKey('admin'), asyncHandler(groups.list));
  router.post('/api/groups', requireApiKey('admin'), adminLimiter, asyncHandler(groups.create));
  router.get('/api/groups/template.csv', requireApiKey('admin'), asyncHandler(groups.template));
  router.post(
    '/api/groups/import/preview',
    requireApiKey('admin'),
    adminLimiter,
    asyncHandler(groups.previewImport)
  );
  router.post(
    '/api/groups/import',
    requireApiKey('admin'),
    adminLimiter,
    asyncHandler(groups.importCsv)
  );
  router.get('/api/groups/:id', requireApiKey('admin'), asyncHandler(groups.getById));
  router.patch(
    '/api/groups/:id',
    requireApiKey('admin'),
    adminLimiter,
    asyncHandler(groups.update)
  );
  router.delete(
    '/api/groups/:id',
    requireApiKey('admin'),
    adminLimiter,
    asyncHandler(groups.remove)
  );

  // ── Messages ──────────────────────────────────────────────────────────────
  // CHI `/send` là độc quyền Integration (BeerPOS phát sinh thông báo).
  // Các endpoint đọc / quản lý job cho phép Admin (UI vận hành) lẫn Integration.
  router.post(
    '/api/messages/send',
    requireApiKey('integration'),
    sendLimiter,
    asyncHandler(messages.send)
  );
  router.get(
    '/api/messages/history',
    requireAnyScope(['admin', 'integration']),
    asyncHandler(messages.history)
  );
  router.get(
    '/api/messages/jobs/:id',
    requireAnyScope(['admin', 'integration']),
    asyncHandler(messages.jobDetail)
  );
  router.post(
    '/api/messages/jobs/:id/retry',
    requireAnyScope(['admin', 'integration']),
    sendLimiter,
    asyncHandler(messages.retry)
  );
  router.post(
    '/api/messages/jobs/:id/cancel',
    requireAnyScope(['admin', 'integration']),
    sendLimiter,
    asyncHandler(messages.cancel)
  );
  router.get(
    '/api/messages/queue/summary',
    requireAnyScope(['admin', 'integration']),
    asyncHandler(messages.queueSummary)
  );

  // ── Settings (admin) ──────────────────────────────────────────────────────
  router.get('/api/settings', requireApiKey('admin'), asyncHandler(account.listSettings));
  router.patch(
    '/api/settings',
    requireApiKey('admin'),
    adminLimiter,
    asyncHandler(account.updateSetting)
  );
  router.get('/api/audit-logs', requireApiKey('admin'), asyncHandler(account.auditLogs));

  return router;
}

module.exports = { createRouter };
