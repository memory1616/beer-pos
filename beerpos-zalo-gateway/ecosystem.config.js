/**
 * PM2 ecosystem config cho beerpos-zalo-gateway (service Zalo messaging rieng).
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 restart ecosystem.config.js --update-env
 *   pm2 logs beerpos-zalo-gateway
 *
 * Env doc tu `beerpos-zalo-gateway/.env` (KHONG commit file nay).
 * Mac dinh bind 127.0.0.1 — chi truy cap noi bo qua nginx/BeerPOS.
 */
const path = require('path');

const ROOT = __dirname;

require('dotenv').config({ path: path.join(ROOT, '.env') });

function envOr(key, fallback) {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

module.exports = {
  apps: [
    {
      name: 'beerpos-zalo-gateway',
      script: './src/server.js',
      cwd: ROOT,
      instances: 1,
      exec_mode: 'fork',

      env: {
        NODE_ENV: envOr('NODE_ENV', 'production'),
        PORT: envOr('PORT', '3100'),
        // Chi bind loopback: gateway khong mo ra internet.
        HOST: envOr('HOST', '127.0.0.1'),
        TZ: envOr('TZ', 'Asia/Ho_Chi_Minh'),
        DATABASE_PATH: envOr('DATABASE_PATH', './data/gateway.sqlite'),
        ADMIN_API_KEY: envOr('ADMIN_API_KEY', ''),
        INTEGRATION_API_KEY: envOr('INTEGRATION_API_KEY', ''),
        MESSAGE_PROVIDER: envOr('MESSAGE_PROVIDER', 'mock'),
        WORKER_ENABLED: envOr('WORKER_ENABLED', 'true'),
        WORKER_CONCURRENCY: envOr('WORKER_CONCURRENCY', '1'),
        WORKER_POLL_INTERVAL: envOr('WORKER_POLL_INTERVAL', '2000'),
        WORKER_MAX_ATTEMPTS: envOr('WORKER_MAX_ATTEMPTS', '4'),
        WORKER_LEASE_MS: envOr('WORKER_LEASE_MS', '60000'),
        WORKER_BATCH_SIZE: envOr('WORKER_BATCH_SIZE', '10'),
        RETRY_DELAYS_MS: envOr('RETRY_DELAYS_MS', '10000,30000,120000,300000'),
        MAX_MESSAGE_LENGTH: envOr('MAX_MESSAGE_LENGTH', '2000'),
        RATE_LIMIT_SEND: envOr('RATE_LIMIT_SEND', '300'),
        RATE_LIMIT_ADMIN: envOr('RATE_LIMIT_ADMIN', '600'),
        CORS_ORIGINS: envOr('CORS_ORIGINS', 'http://localhost:3100'),
      },

      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      max_memory_restart: '300M',
      autorestart: true,
      restart_delay: 4000,
      max_restarts: 10,
      exp_backoff_restart_delay: 100,
      kill_timeout: 5000,
      watch: false,
      ignore_watch: ['node_modules', 'logs', 'data', 'tests', 'docs'],
    },
  ],
};
