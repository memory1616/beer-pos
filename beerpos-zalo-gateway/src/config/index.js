const path = require('path');
const fs = require('fs');

/** Doc .env don gian (khong them dependency dotenv). */
function loadDotEnv(file) {
  const p = file || path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq < 1) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  });
}

loadDotEnv();

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(value, fallback) {
  if (!value) return fallback;
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const isTest = NODE_ENV === 'test';

const config = {
  env: NODE_ENV,
  isTest,
  isProduction: NODE_ENV === 'production',
  port: int(process.env.PORT, 3100),
  /** Bind address. Production nen bind 127.0.0.1 (chi truy cap noi bo). */
  host: (process.env.HOST || '0.0.0.0').trim(),

  database: {
    path: path.resolve(
      __dirname,
      '..',
      '..',
      process.env.DATABASE_PATH || './data/gateway.sqlite'
    ),
  },

  auth: {
    adminKey: process.env.ADMIN_API_KEY || '',
    integrationKey: process.env.INTEGRATION_API_KEY || '',
    /** Cho phep nhieu key de rotate khong downtime (dau phay). */
    adminKeys: list(process.env.ADMIN_API_KEYS, null),
    integrationKeys: list(process.env.INTEGRATION_API_KEYS, null),
  },

  provider: {
    name: (process.env.MESSAGE_PROVIDER || 'mock').trim().toLowerCase(),
    mockScenario: (process.env.MOCK_SCENARIO || 'success').trim().toLowerCase(),
    mockDelayMs: int(process.env.MOCK_DELAY_MS, 10),
    timeoutMs: int(process.env.PROVIDER_TIMEOUT_MS, 10000),
  },

  worker: {
    enabled: bool(process.env.WORKER_ENABLED, true),
    concurrency: int(process.env.WORKER_CONCURRENCY, 1),
    pollIntervalMs: int(process.env.WORKER_POLL_INTERVAL, 2000),
    maxAttempts: int(process.env.WORKER_MAX_ATTEMPTS, 4),
    leaseMs: int(process.env.WORKER_LEASE_MS, 60000),
    batchSize: int(process.env.WORKER_BATCH_SIZE, 10),
  },

  retry: {
    delaysMs: list(process.env.RETRY_DELAYS_MS, [10000, 30000, 120000, 300000]).map((v) =>
      int(v, 10000)
    ),
  },

  limits: {
    maxMessageLength: int(process.env.MAX_MESSAGE_LENGTH, 2000),
    maxCustomerIdLength: int(process.env.MAX_CUSTOMER_ID_LENGTH, 64),
    maxGroupIdLength: int(process.env.MAX_GROUP_ID_LENGTH, 128),
    maxNameLength: int(process.env.MAX_NAME_LENGTH, 200),
    maxNoteLength: int(process.env.MAX_NOTE_LENGTH, 500),
    maxImportRows: int(process.env.MAX_IMPORT_ROWS, 5000),
  },

  rateLimit: {
    send: int(process.env.RATE_LIMIT_SEND, 300),
    admin: int(process.env.RATE_LIMIT_ADMIN, 600),
  },

  cors: {
    origins: list(process.env.CORS_ORIGINS, ['http://localhost:3100']),
  },
};

/** Kiem tra config bat buoc - chi chay khi khong phai test. */
function assertProductionSafety() {
  const problems = [];
  if (!config.auth.adminKey) problems.push('ADMIN_API_KEY chua duoc dat');
  if (!config.auth.integrationKey) problems.push('INTEGRATION_API_KEY chua duoc dat');
  if (config.auth.adminKey && config.auth.adminKey === config.auth.integrationKey) {
    problems.push('ADMIN_API_KEY va INTEGRATION_API_KEY phai khac nhau');
  }
  if (config.isProduction) {
    const weak = ['replace_with_secure_key', 'secret', 'changeme', 'test'];
    if (weak.includes(config.auth.adminKey)) problems.push('ADMIN_API_KEY qua yeu');
    if (weak.includes(config.auth.integrationKey)) problems.push('INTEGRATION_API_KEY qua yeu');
  }
  return problems;
}

module.exports = { config, assertProductionSafety };
