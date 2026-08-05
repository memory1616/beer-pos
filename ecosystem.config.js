/**
 * PM2 ecosystem config cho Beer POS Pro+
 *
 * Docs:
 *   - https://pm2.keymetrics.io/docs/usage/application-declaration/
 *   - https://pm2.keymetrics.io/docs/usage/environment/
 *
 * Usage:
 *   pm2 start ecosystem.config.js              # start voi env production
 *   pm2 start ecosystem.config.js --env dev    # start voi env dev
 *   pm2 restart ecosystem.config.js
 *   pm2 reload ecosystem.config.js
 *   pm2 stop ecosystem.config.js
 *   pm2 delete ecosystem.config.js
 *
 * Neu chay local (khong co .env):
 *   pm2 start server.js --name beer-pos
 *
 * Moi truong production:
 *   - Tao file .env tu .env.example (npm install dotenv da co san)
 *   - Dat GITHUB_WEBHOOK_SECRET moi (KHONG dung secret cu da commit)
 *   - SESSION_SECRET = chuoi random >= 32 ky tu
 */

require('dotenv').config({ path: __dirname + '/.env' });

// Helper: fallback an toan neu thieu env
function envOr(key, fallback) {
  return process.env[key] && process.env[key].length > 0 ? process.env[key] : fallback;
}

// Session secret: BAT BUOC set trong production, neu khong co se canh bao
const sessionSecret = envOr('SESSION_SECRET', null);
if (!sessionSecret && (envOr('NODE_ENV', 'development') === 'production')) {
  console.error('[ecosystem] FATAL: SESSION_SECRET chua duoc set trong .env');
  console.error('[ecosystem]       Tao chuoi random: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

module.exports = {
  apps: [
    {
      name: 'beer-pos',
      script: './server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',

      // ── Default env (production) ─────────────────────────────────────
      env: {
        NODE_ENV: envOr('NODE_ENV', 'production'),
        PORT: envOr('PORT', '3000'),
        HOST: envOr('HOST', '0.0.0.0'),
        TZ: envOr('TZ', 'Asia/Ho_Chi_Minh'),
        ADMIN_DOMAIN: envOr('ADMIN_DOMAIN', 'admin.biatuoitayninh.store'),
        PUBLIC_DOMAIN: envOr('PUBLIC_DOMAIN', 'biatuoitayninh.store'),
        DISTRIBUTOR_NAME: envOr('DISTRIBUTOR_NAME', 'BeerPOS Pro+'),
        ALLOWED_ORIGINS: envOr('ALLOWED_ORIGINS', '*'),
        IS_CLOUD_SERVER: envOr('IS_CLOUD_SERVER', 'true'),
        CLOUD_MODE: envOr('CLOUD_MODE', 'true'),
        CLOUD_DOMAIN: envOr('CLOUD_DOMAIN', 'https://admin.biatuoitayninh.store'),
        SESSION_SECRET: sessionSecret || 'change-me-to-a-long-random-string-in-production',
        GITHUB_WEBHOOK_SECRET: envOr('GITHUB_WEBHOOK_SECRET', ''),
      },

      // ── Dev env (--env dev) ──────────────────────────────────────────
      env_dev: {
        NODE_ENV: 'development',
        PORT: '3000',
        HOST: '0.0.0.0',
        TZ: 'Asia/Ho_Chi_Minh',
        ADMIN_DOMAIN: 'localhost:3000',
        PUBLIC_DOMAIN: 'localhost:3000',
        DISTRIBUTOR_NAME: 'BeerPOS Dev',
        ALLOWED_ORIGINS: '*',
        IS_CLOUD_SERVER: 'false',
        CLOUD_MODE: 'false',
        SESSION_SECRET: 'dev-only-not-secure',
      },

      // ── Logging ─────────────────────────────────────────────────────
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // ── Process management ──────────────────────────────────────────
      max_memory_restart: '500M',
      autorestart: true,
      restart_delay: 4000,
      max_restarts: 10,
      exp_backoff_restart_delay: 100,
      kill_timeout: 5000,
      wait_ready: false,

      // ── Watch (chi enable khi dev) ──────────────────────────────────
      watch: false,
      ignore_watch: [
        'node_modules',
        'logs',
        'backup',
        'backups',
        'public',
        'views',
        'src',
        'routes',
        'middleware',
        'database',
        'docs',
        'scripts',
        'tests',
        'coverage',
        'database.sqlite',
        'database.sqlite-*',
        '*.log',
        '.env',
      ],
    },
  ],
};