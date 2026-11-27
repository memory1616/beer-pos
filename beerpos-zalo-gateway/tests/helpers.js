/**
 * Helper dung chung cho test.
 */
const { migrate } = require('../src/database/migrator');
const { getDb, closeDb } = require('../src/database/connection');
const { createApp } = require('../src/app');

const ADMIN_KEY = 'test_admin_key';
const INTEGRATION_KEY = 'test_integration_key';

/** Chay migration 1 lan (idempotent). */
function ensureSchema() {
  migrate();
  return getDb();
}

/** Xoa du lieu (giu schema). */
function truncateAll() {
  const db = getDb();
  db.exec(`
    DELETE FROM gateway_messages;
    DELETE FROM gateway_jobs;
    DELETE FROM gateway_groups;
    DELETE FROM gateway_audit_logs;
  `);
}

/** Tao app + supertest. */
async function makeApp() {
  ensureSchema();
  const app = createApp();
  // eslint-disable-next-line global-require
  const request = require('supertest');
  return { app, request };
}

const adminHeaders = () => ({ 'X-API-Key': ADMIN_KEY });
const integrationHeaders = (idempotencyKey) => ({
  'X-API-Key': INTEGRATION_KEY,
  ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
});

module.exports = {
  ADMIN_KEY,
  INTEGRATION_KEY,
  ensureSchema,
  truncateAll,
  makeApp,
  adminHeaders,
  integrationHeaders,
  closeDb,
};
