/**
 * Setup cho test Gateway.
 *
 * Moi test suite dung DB rieng (file tam trong thu muc data/).
 * KHONG bao gio cham vao database.sqlite cua BeerPOS.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DB_DIR = path.join(__dirname, '..', 'data', 'test');

if (!fs.existsSync(TEST_DB_DIR)) fs.mkdirSync(TEST_DB_DIR, { recursive: true });

const unique = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(TEST_DB_DIR, `gateway-test-${unique}.sqlite`);
process.env.ADMIN_API_KEY = 'test_admin_key';
process.env.INTEGRATION_API_KEY = 'test_integration_key';
process.env.MESSAGE_PROVIDER = 'mock';
process.env.WORKER_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';

afterAll(() => {
  // Dọn file DB test.
  const base = process.env.DATABASE_PATH;
  [base, `${base}-shm`, `${base}-wal`].forEach((f) => {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (_) {
      /* ignore */
    }
  });
  // eslint-disable-next-line global-require
  const { closeDb } = require('../src/database/connection');
  closeDb();
});
