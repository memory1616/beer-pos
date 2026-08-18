// Beer POS Pro v2 - Simple Server
// Webhook auto-deploy test: 2026-04-14 v4 (PM2 fix verification)
process.env.TZ = 'Asia/Ho_Chi_Minh';
require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const os = require('os');
const crypto = require('crypto');
const logger = require('./src/utils/logger');
const db = require('./database');
const socketServer = require('./src/socket/socketServer');
const { getSession, AUTH_CONFIG } = require('./middleware/auth');
const compression = require('compression');
const helmet = require('helmet');

// Error handling middleware
const { errorHandler, notFoundHandler, requestLogger } = require('./middleware/errorHandler');
const { cache } = require('./middleware/cache');

// ── Global error handlers — prevent silent crash ───────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', { reason, promise });
  // Don't exit — let PM2 restart if needed
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', { message: err.message, stack: err.stack });
  // Give PM2 a moment to log, then exit for restart
  setTimeout(() => process.exit(1), 100);
});

process.on('warning', (warning) => {
  logger.warn('Process warning:', { message: warning.message, name: warning.name });
});

// APP_VERSION: git hash or fallback to build timestamp (computed once at startup)
let APP_VERSION;
try {
  const { execSync } = require('child_process');
  APP_VERSION = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
} catch {
  APP_VERSION = String(Date.now()).slice(0, 10);
}

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Environment: 'admin' or 'public'
// Detected by nginx X-App-Mode header, or fallback by Host header
const ADMIN_DOMAIN = process.env.ADMIN_DOMAIN || 'admin.biatuoitayninh.store';
const PUBLIC_DOMAIN = process.env.PUBLIC_DOMAIN || 'biatuoitayninh.store';

function getAppMode(req) {
  // nginx sets this header to tell Express which app is being served
  if (req.headers['x-app-mode'] === 'admin') return 'admin';
  if (req.headers['x-app-mode'] === 'public') return 'public';
  // Fallback by Host header
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  // Support localhost development + production domains
  if (
    host === ADMIN_DOMAIN ||
    host.endsWith('.admin.' + PUBLIC_DOMAIN.replace('www.', '')) ||
    host === 'admin.localhost' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.startsWith('admin.')
  ) return 'admin';
  return 'public';
}

// Rate limiting — skip /api/discover (LAN scan pings) and /api/auth/me (login check)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Quá nhiều yêu cầu, vui lòng thử lại sau' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  skip: (req) => {
    return req.path === '/discover' || req.path === '/auth/me';
  },
});
app.use('/api', limiter);

// Lenient rate limit for auth/login endpoints — separate from general /api limit
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Quá nhiều yêu cầu, vui lòng thử lại sau' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});
app.use('/auth', authLimiter);

// CORS — allow cross-origin requests for cloud sync
// Allowlist configurable via ALLOWED_ORIGINS env var (comma-separated), default to known domains
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Version');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Security headers with Helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
      styleSrcElem: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
      imgSrc: ["'self'", 'data:', 'https:', 'https://img.vietqr.io', 'https://*.basemaps.cartocdn.com'],
      connectSrc: ["'self'", 'http://103.75.183.57:3000', 'https://103.75.183.57:3000', 'https://admin.biatuoitayninh.store', 'https://biatuoitayninh.store', 'https://img.vietqr.io', 'https://unpkg.com', 'https://cdn.jsdelivr.net', 'https://*.basemaps.cartocdn.com'],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Request logging
app.use(requestLogger);

// ============================================================
// DEPLOY WEBHOOK - Gộp cả 2 endpoint (/deploy và /webhook/deploy)
// ============================================================
// - GitHub webhook: POST /deploy  (verify HMAC SHA256 + x-hub-signature-256)
// - Custom token:  POST /webhook/deploy  (Bearer token)
// - Status:        GET /deploy/status  (trạng thái deploy hiện tại)
// - Log tail:      GET /deploy/log     (xem 100 dòng log gần nhất)
//
// Tính năng:
//   - Lock file chống concurrent deploy (PID tracking)
//   - Idempotency: cùng X-Deploy-ID bỏ qua trong vòng 5 phút
//   - Rate limit: 1 deploy / 30 giây
//   - Tự động chạy deploy.sh ở background, trả lời webhook ngay
//   - Log deploy ra logs/deploy-webhook.log
//
// Note: 'fs', 'path' đã được require ở đầu file.
//       Không require lại để tránh SyntaxError duplicate identifier.
//       'execFile' lấy từ child_process (đã require ở đầu file).
// ============================================================
const fsPromises = fs.promises;

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';
const DEPLOY_WEBHOOK_SECRET = process.env.DEPLOY_WEBHOOK_SECRET || null;
const DEPLOY_LOCK_FILE = '/tmp/beerpos-deploy.lock';
const DEPLOY_STATE_FILE = path.join(__dirname, 'logs', 'deploy-state.json');
const DEPLOY_LOG_FILE = path.join(__dirname, 'logs', 'deploy-webhook.log');
const DEPLOY_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 phút
const DEPLOY_RATE_LIMIT_MS = 30 * 1000; // 30 giây

// ── Deploy state (in-memory + persisted to file) ────────────────
let deployState = {
  status: 'idle',       // idle | running | success | failed
  pid: null,
  started_at: null,
  finished_at: null,
  trigger: null,        // github | token | manual
  ref: null,
  commit: null,
  message: null,
  error: null,
  last_deploy_id: null,
  last_deploy_at: null,
  rate_limit_until: null,
};

async function loadDeployState() {
  try {
    const raw = await fsPromises.readFile(DEPLOY_STATE_FILE, 'utf8');
    deployState = { ...deployState, ...JSON.parse(raw) };
  } catch {
    // First run - state file may not exist yet
  }
}

async function saveDeployState() {
  try {
    await fsPromises.mkdir(path.dirname(DEPLOY_STATE_FILE), { recursive: true });
    await fsPromises.writeFile(DEPLOY_STATE_FILE, JSON.stringify(deployState, null, 2));
  } catch (e) {
    logger.error('Cannot save deploy state', { error: e.message });
  }
}

async function appendDeployLog(line) {
  try {
    await fsPromises.mkdir(path.dirname(DEPLOY_LOG_FILE), { recursive: true });
    await fsPromises.appendFile(
      DEPLOY_LOG_FILE,
      `[${new Date().toISOString()}] ${line}\n`
    );
  } catch (e) {
    logger.error('Cannot append deploy log', { error: e.message });
  }
}

function verifyGithubSignature256(payloadBuf, signatureHeader) {
  if (!signatureHeader || !GITHUB_WEBHOOK_SECRET) return false;
  const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(payloadBuf).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

async function isConcurrentDeployRunning() {
  try {
    const pidStr = await fsPromises.readFile(DEPLOY_LOCK_FILE, 'utf8');
    const pid = parseInt(pidStr.trim(), 10);
    if (pid && !isNaN(pid)) {
      try {
        process.kill(pid, 0); // signal 0 = test existence
        return true;
      } catch {
        // Process not running - stale lock
        return false;
      }
    }
  } catch {
    // Lock file doesn't exist
  }
  return false;
}

function checkRateLimit() {
  if (deployState.rate_limit_until && Date.now() < deployState.rate_limit_until) {
    const waitMs = deployState.rate_limit_until - Date.now();
    return { allowed: false, wait_ms: waitMs };
  }
  return { allowed: true };
}

async function runDeploySh(trigger, ref, message, deployId) {
  const deployScript = path.join(__dirname, 'deploy', 'deploy.sh');
  if (!fs.existsSync(deployScript)) {
    throw new Error(`Deploy script not found: ${deployScript}`);
  }

  deployState = {
    ...deployState,
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    trigger,
    ref,
    message,
    error: null,
    last_deploy_id: deployId,
    last_deploy_at: new Date().toISOString(),
  };
  await saveDeployState();
  await appendDeployLog(`DEPLOY STARTED - trigger=${trigger} ref=${ref || 'n/a'} id=${deployId}`);

  return new Promise((resolve) => {
    execFile('bash', [deployScript], { cwd: __dirname, maxBuffer: 10 * 1024 * 1024 }, async (err, stdout, stderr) => {
      const finishedAt = new Date().toISOString();
      if (err) {
        deployState.status = 'failed';
        deployState.error = err.message;
        deployState.finished_at = finishedAt;
        await saveDeployState();
        await appendDeployLog(`DEPLOY FAILED - ${err.message}`);
        logger.error('Deploy failed', { error: err.message, deployId });
        if (stdout) logger.error('Deploy stdout', { output: stdout.slice(-2000) });
        if (stderr) logger.error('Deploy stderr', { output: stderr.slice(-2000) });
        return resolve({ success: false, error: err.message });
      }
      deployState.status = 'success';
      deployState.finished_at = finishedAt;
      deployState.rate_limit_until = Date.now() + DEPLOY_RATE_LIMIT_MS;
      await saveDeployState();
      await appendDeployLog(`DEPLOY SUCCESS in ${Date.now() - new Date(deployState.started_at).getTime()}ms`);
      logger.info('Deploy completed', { deployId, duration_ms: Date.now() - new Date(deployState.started_at).getTime() });
      if (stdout) logger.info('Deploy output', { output: stdout.slice(-1000) });
      if (stderr) logger.warn('Deploy stderr', { output: stderr.slice(-1000) });
      resolve({ success: true });
    });
  });
}

// ── Webhook handler (gộp cả GitHub + token-based) ───────────────
async function handleDeployWebhook(req, res, opts = {}) {
  const { trigger, rawBody, githubEvent, githubSignature, token } = opts;

  // 1. Authenticate
  if (trigger === 'github') {
    if (!GITHUB_WEBHOOK_SECRET) {
      return res.status(503).json({ error: 'NO_SECRET', message: 'GITHUB_WEBHOOK_SECRET not configured' });
    }
    if (!verifyGithubSignature256(rawBody, githubSignature)) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid GitHub webhook signature',
      });
    }
    if (githubEvent && githubEvent !== 'push') {
      return res.json({ ok: true, ignored_event: githubEvent });
    }
  } else if (trigger === 'token') {
    if (DEPLOY_WEBHOOK_SECRET && token !== DEPLOY_WEBHOOK_SECRET) {
      logger.warn('Webhook deploy rejected: invalid token');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // 2. Parse payload (for GitHub)
  let payload = {};
  if (trigger === 'github' && rawBody) {
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }
    if (payload.ref && payload.ref !== 'refs/heads/main') {
      return res.json({ ok: true, ignored_ref: payload.ref });
    }
  } else if (trigger === 'token' && req.body) {
    payload = req.body;
  }

  const ref = payload.ref || (payload.ref_override || 'manual');
  const message = payload.message || payload.head_commit?.message || 'Manual deploy';
  const commit = payload.head_commit?.id || payload.commit || null;
  const deployId = payload.deploy_id || req.get('x-deploy-id') || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 3. Idempotency check (same deployId within TTL = skip)
  if (deployState.last_deploy_id === deployId) {
    const ageMs = Date.now() - new Date(deployState.last_deploy_at || 0).getTime();
    if (ageMs < DEPLOY_IDEMPOTENCY_TTL_MS) {
      logger.info('Idempotent deploy skipped', { deployId, age_ms: ageMs });
      return res.json({ ok: true, idempotent: true, deploy_id: deployId, state: deployState });
    }
  }

  // 4. Rate limit check
  const rate = checkRateLimit();
  if (!rate.allowed) {
    return res.status(429).json({
      error: 'Rate limited',
      retry_after_seconds: Math.ceil(rate.wait_ms / 1000),
    });
  }

  // 5. Concurrent deploy check
  if (await isConcurrentDeployRunning()) {
    return res.status(409).json({
      error: 'Deploy already in progress',
      state: deployState,
    });
  }

  // 6. Respond immediately, run deploy in background
  res.json({
    ok: true,
    message: 'Deploy started',
    deploy_id: deployId,
    trigger,
    ref,
    state: { ...deployState, status: 'running', started_at: new Date().toISOString() },
  });

  // 7. Run deploy.sh async (don't await - response already sent)
  runDeploySh(trigger, ref, message, deployId).catch((e) => {
    logger.error('runDeploySh threw', { error: e.message });
  });
}

// ── GitHub webhook: POST /deploy ────────────────────────────────
app.post(
  '/deploy',
  express.raw({ type: ['application/json', 'application/*+json'], limit: '10mb' }),
  (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf)) {
      return res.status(400).json({ error: 'Invalid body' });
    }
    handleDeployWebhook(req, res, {
      trigger: 'github',
      rawBody: buf,
      githubEvent: req.get('x-github-event'),
      githubSignature: req.get('x-hub-signature-256'),
    }).catch((e) => {
      logger.error('GitHub webhook error', { error: e.message });
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    });
  }
);

// ── Token webhook: POST /webhook/deploy ─────────────────────────
app.post('/webhook/deploy', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace(/^Bearer\s+/i, '') || req.body?.token || req.query?.token;
  await handleDeployWebhook(req, res, { trigger: 'token', token });
});

// ── Deploy status: GET /deploy/status ───────────────────────────
// (Khong can auth cho status - chi la thong tin deploy)
// Neu can protect, them check bearer token o day.
app.get('/deploy/status', (req, res) => {
  res.json({
    ok: true,
    state: deployState,
    server: {
      hostname: os.hostname(),
      uptime_seconds: Math.floor(process.uptime()),
      node_version: process.version,
    },
  });
});

// ── Deploy log: GET /deploy/log ─────────────────────────────────
app.get('/deploy/log', async (req, res) => {
  const lines = Math.min(parseInt(req.query.lines || '100', 10), 500);
  try {
    const data = await fsPromises.readFile(DEPLOY_LOG_FILE, 'utf8');
    const arr = data.split('\n').filter(Boolean);
    const tail = arr.slice(-lines).join('\n');
    res.type('text/plain').send(tail || '(log empty)');
  } catch {
    res.type('text/plain').send('(log file not found - no deploy has been triggered yet)');
  }
});

// Middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(compression());
// Dynamic JSON "page data" — must not be cached by browsers/CDN (PWA SW used to cache these)
app.use((req, res, next) => {
  const fullPath = req.baseUrl ? req.baseUrl + req.path : req.path;
  // /data endpoints + all /api/* routes must never be cached
  if (req.method === 'GET' && (fullPath.endsWith('/data') || fullPath.startsWith('/api/'))) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
// B20: Auto no-cache cho HTML pages để browser không giữ bản cũ.
//     Hook res.writeHead để set headers NGAY KHI response bắt đầu ghi (trước cả sendFile).
//     Tránh trường hợp user phải hard reload (Ctrl+F5) mỗi lần deploy code mới.
//     Áp dụng cho: HTML pages + JS/CSS được load trực tiếp (không qua /public).
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const p = req.path;
  const isHtml = /\.html?$/.test(p) || (!path.extname(p) && !p.startsWith('/api/') && !p.startsWith('/data'));
  if (isHtml) {
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = function(statusCode, statusMessage, headers) {
      try {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      } catch (e) { /* ignore */ }
      return origWriteHead(statusCode, statusMessage, headers);
    };
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Favicon — always serve icon
app.get('/favicon.ico', (req, res) => {
  res.type('image/png');
  res.sendFile(path.join(__dirname, 'public', 'icon-192.png'));
});

// OpenAPI / Swagger UI — serve doc tĩnh từ docs/openapi.yaml
// Doc: https://swagger.io/specification/
app.get('/api/openapi.yaml', (req, res) => {
  res.type('text/yaml');
  res.sendFile(path.join(__dirname, 'docs', 'openapi.yaml'));
});

app.get('/api/docs', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.type('text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <title>Beer POS Pro+ API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/api/openapi.yaml',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis
        ]
      });
    };
  </script>
</body>
</html>`);
});

// Service Worker v2 — always fresh, never cache
// B21: Đổi tên file từ sw.js → sw.v2.js để force browser download SW mới trên mobile.
//      Browser cache SW theo URL, đổi path = cache miss = download mới.
app.get('/sw.v2.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.v2.js'));
});

// sw.js cũ — redirect sang v2 để cleanup
app.get('/sw.js', (req, res) => {
  res.redirect('/sw.v2.js');
});

// PWA manifest — add headers for installability on iOS
app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('application/json');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

// Inject global app context into every HTML page served by Express
// - window.APP_MODE: 'admin' | 'public'
// - window.BASE_PATH: '/' (admin) | null (public)
// - window.APP_VERSION: git hash or timestamp for cache busting
app.use((req, res, next) => {
  const mode = getAppMode(req);
  const origSendFile = res.sendFile.bind(res);

  res.sendFile = function(filepath, options, callback) {
    if (String(filepath).endsWith('.html')) {
      const isAdmin = mode === 'admin';
      const basePath = isAdmin ? '/' : null;

      return fs.readFile(filepath, 'utf8', (err, html) => {
        if (err) return origSendFile(filepath, options, callback);

        // Inject base tag for admin (all relative links resolve correctly)
        if (isAdmin && !html.includes('<base')) {
          html = html.replace('<head>', '<head><base href="/">');
        }

        // Inject version busting: append/replace ?v=APP_VERSION to JS and CSS files
        html = html.replace(/(<\s*(?:script|img|link)\s+[^>]*(?:src|href)\s*=\s*["'])(\/[^"']+)(")/gi, (match, prefix, path, suffix) => {
          // Only bust version for local /js/ and /css/ assets
          if (path.startsWith('/js/') || path.startsWith('/css/') || path === '/sw.js') {
            // Remove existing ?v= param to avoid double ?v=...&v=...
            const cleanPath = path.replace(/\?v=[^&]*/, '');
            return `${prefix}${cleanPath}?v=${APP_VERSION}${suffix}`;
          }
          return match;
        });

        // Inject app context globals
        const ctxScript = `<script>
window.APP_MODE = '${mode}';
window.BASE_PATH = ${basePath ? `'${basePath}'` : 'null'};
window.APP_VERSION = '${APP_VERSION}';
</script>`;

        if (!html.includes('window.APP_MODE')) {
          html = html.replace('</head>', ctxScript + '</head>');
        }

        // No-cache for HTML to ensure fresh content on refresh
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        res.type('text/html').send(html);
      });
    }
    return origSendFile(filepath, options, callback);
  };
  next();
});

// Request logger — log slow requests (>500ms) or errors
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (ms > 500 || res.statusCode >= 400) {
      logger.http(`${req.method} ${req.url} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// View engine
app.set('view engine', 'html');
app.engine('html', require('ejs').renderFile);

// Constants
const DISTRIBUTOR_NAME = process.env.DISTRIBUTOR_NAME || 'Bia Tươi Gia Huy';

function formatVND(amount) {
  if (amount === null || amount === undefined || amount === '') return '0 đ';
  const num = Number(amount);
  if (isNaN(num)) return '0 đ';
  return new Intl.NumberFormat('vi-VN').format(num) + ' đ';
}

app.locals.formatVND = formatVND;
app.locals.DISTRIBUTOR_NAME = DISTRIBUTOR_NAME;

// ==================== AUTO BACKUP ====================
async function createBackup(options = {}) {
  const backupDir = path.join(__dirname, 'backup');
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');

  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const dbPath = path.join(__dirname, 'database.sqlite');
  const timestamp = `${today}-${hour}${minute}`;
  const backupFile = path.join(backupDir, `backup-${timestamp}.db`);

  try {
    await fs.promises.copyFile(dbPath, backupFile);

    // === Integrity check: try to open backup with SQLite ===
    let integrityOk = false;
    try {
      const BackupDb = require('better-sqlite3');
      const testDb = new BackupDb(backupFile, { readonly: true });
      const result = testDb.prepare('PRAGMA integrity_check').get();
      testDb.close();
      integrityOk = result && result.integrity_check === 'ok';
    } catch (_) {
      const stat = await fs.promises.stat(backupFile);
      integrityOk = stat.size > 10 * 1024;
    }

    if (!integrityOk) {
      logger.warn(`Backup file may be corrupted: ${backupFile}, attempting re-copy...`);
      const corruptPath = backupFile.replace('.db', '.corrupt.db');
      try {
        await fs.promises.rename(backupFile, corruptPath);
      } catch (_) {}
      await fs.promises.copyFile(dbPath, backupFile);
      logger.info('Backup re-copied successfully');
    }

    logger.info(`Auto backup: backup-${timestamp}.db (integrity: ${integrityOk ? 'OK' : 'RECHECKED'})`);
    cleanupOldBackupsAsync(backupDir);
    return { success: true, file: backupFile, integrity: integrityOk };
  } catch (e) {
    logger.error('Backup failed', { error: e.message });
    return { success: false, error: e.message };
  }
}

async function cleanupOldBackupsAsync(backupDir) {
  try {
    const files = await fs.promises.readdir(backupDir);
    const withStats = [];
    for (const f of files) {
      if (!f.startsWith('backup-') || !f.endsWith('.db')) continue;
      try {
        const stats = await fs.promises.stat(path.join(backupDir, f));
        withStats.push({ name: f, path: path.join(backupDir, f), time: stats.mtime.getTime() });
      } catch (_) {}
    }
    withStats.sort((a, b) => b.time - a.time);
    const toDelete = withStats.slice(30);
    for (const f of toDelete) {
      try {
        await fs.promises.unlink(f.path);
      } catch (_) {}
    }
  } catch (e) {
    logger.error('Cleanup error', { error: e.message });
  }
}

cron.schedule('0 23 * * *', async () => {
  await createBackup({ daily: true });
}, {
  timezone: 'Asia/Ho_Chi_Minh',
});

// ==================== WAL CHECKPOINT (keep WAL file small) ====================
cron.schedule('0 */6 * * *', async () => {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    logger.info('WAL checkpoint completed (TRUNCATE mode)');
  } catch (e) {
    logger.error('WAL checkpoint failed', { error: e.message });
  }
}, {
  timezone: 'Asia/Ho_Chi_Minh',
});

// ==================== MONTHLY REWARDS RESET (B17) ====================
// Chạy 00:05 ngày 1 hàng tháng: tạo customer_monthly_stats row cho tháng mới
// để đảm bảo đồng bộ purchased_liters, reward_claimed đúng cho mỗi khách.
cron.schedule('5 0 1 * *', async () => {
  try {
    if (PromotionService && typeof PromotionService.resetMonthlyRewards === 'function') {
      PromotionService.resetMonthlyRewards();
      logger.info('Monthly rewards reset completed');
    } else {
      logger.warn('PromotionService.resetMonthlyRewards not available');
    }
  } catch (e) {
    logger.error('Monthly rewards reset failed', { error: e.message });
  }
}, {
  timezone: 'Asia/Ho_Chi_Minh',
});

// ==================== WEB ROUTES ====================

// Landing page — public domain
app.get('/', (req, res) => {
  const mode = getAppMode(req);
  if (mode === 'admin') {
    // Admin subdomain: serve admin dashboard
    return res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
  }
  // Public domain: serve landing page
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Admin app pages — all at root for admin subdomain
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// ── HTML page routes — no-cache to prevent stale views (PWA SW caches too aggressively) ──
function sendPageNoCache(req, res, viewName) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'views', viewName));
}

app.get('/dashboard', (req, res) => sendPageNoCache(req, res, 'dashboard.html'));
app.get('/customers', (req, res) => sendPageNoCache(req, res, 'customers.html'));
app.get('/customer/:id', (req, res) => sendPageNoCache(req, res, 'customer-detail.html'));
app.get('/stock', (req, res) => sendPageNoCache(req, res, 'stock.html'));
app.get('/promo-settings', (req, res) => sendPageNoCache(req, res, 'promo-settings.html'));
app.get('/qr-settings', (req, res) => sendPageNoCache(req, res, 'qr-settings.html'));
app.get('/purchases', (req, res) => sendPageNoCache(req, res, 'purchases.html'));
app.get('/kegs', (req, res) => sendPageNoCache(req, res, 'kegs.html'));
// /report is handled by routes/report.js (serves full HTML page)
app.get('/backup', (req, res) => sendPageNoCache(req, res, 'backup.html'));
// /report is handled by routes/report.js (serves full HTML page)
app.get('/backup', (req, res) => res.sendFile(path.join(__dirname, 'views', 'backup.html')));
// analytics, delivery, products, devices, expenses: HTML do routes/*.js (không dùng views/*.html)

// Redirect legacy /admin/* paths to clean paths
app.use('/admin', (req, res) => res.redirect(req.path === '/admin' ? '/' : req.path));

// ==================== API ROUTES ====================
app.use('/api/customers', require('./routes/api/customers'));
app.use('/api/products', require('./routes/api/products'));
app.use('/api/sales', require('./routes/api/sales'));
app.use('/api/orders', require('./routes/api/orders'));
app.use('/api/payments', require('./routes/api/payments'));
app.use('/api/stock', require('./routes/api/stock'));
app.use('/api/kegs', require('./routes/api/kegs'));
app.use('/api/analytics', require('./routes/api/analytics'));
app.use('/api/purchases', require('./routes/api/purchases'));
app.use('/api/backup', require('./routes/api/backup'));
app.use('/api/settings', require('./routes/api/settings'));
app.use('/api/devices', require('./routes/api/devices'));
app.use('/api/expenses', require('./routes/api/expenses'));
app.use('/api/session', require('./routes/api/session'));
app.use('/api/sync', require('./routes/api/sync'));
app.use('/api/state', require('./routes/api/state'));
app.use('/api/routing', require('./routes/api/routing'));

// Business Features APIs
app.use('/api/batch', require('./routes/api/batch'));
app.use('/api/debts', require('./routes/api/debts'));
app.use('/api/promotions', require('./routes/api/promotions'));
app.use('/api/segments', require('./routes/api/segments'));
app.use('/api/sales-staff', require('./routes/api/sales-staff'));

// ==================== AUTH ====================
app.use('/auth', require('./routes/login'));

// ==================== PAGE DATA ROUTES ====================
app.use('/customers', require('./routes/customers'));
app.use('/sale', require('./routes/sales'));
app.use('/stock', require('./routes/stock'));
app.use('/purchases', require('./routes/purchases'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/analytics', require('./routes/analytics'));
app.use('/delivery', require('./routes/delivery'));
app.use('/products', require('./routes/products'));
app.use('/devices', require('./routes/devices'));
// Serve expenses HTML
app.get('/expenses', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'expenses.html'));
});
app.use('/expenses', require('./routes/expenses'));
// Serve report HTML (data loaded client-side via /report/data)
app.get('/report', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'report.html'));
});

// Serve walkin-kegs HTML
app.get('/walkin-kegs', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'walkin-kegs.html'));
});

// Serve sales-staff HTML
app.get('/sales-staff', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'sales-staff.html'));
});

// Report data API — moved to routes/reportData.js for modularity
app.use('/report', require('./routes/reportData'));
app.use('/report', require('./routes/report'));

// ==================== AUTH CHECK ====================
app.get('/api/auth/me', (req, res) => {
  const cookieToken = req.cookies?.[AUTH_CONFIG.cookieName];
  const headerToken = req.headers.authorization?.replace('Bearer ', '');
  const token = cookieToken || headerToken;
  if (!token) return res.status(401).json({ loggedIn: false });
  const session = getSession(token);
  if (!session) return res.status(401).json({ loggedIn: false });
  res.json({ loggedIn: true, username: session.username });
});

// ==================== WEBHOOK DEPLOY (moved above) ====================
// Both /deploy and /webhook/deploy are registered above (before bodyParser).
// See handleDeployWebhook() for the unified implementation.

// ==================== HEALTH CHECK ====================
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ==================== COMPREHENSIVE HEALTH CHECK ====================
app.get('/health', (req, res) => {
  const checks = { ok: true, timestamp: new Date().toISOString(), checks: {} };
  const status = { http: 200 };

  // DB check
  try {
    const row = db.prepare('SELECT 1 as ping').get();
    checks.checks.database = { ok: row && row.ping === 1, mode: db.pragma('journal_mode')[0].journal_mode };
  } catch (e) {
    checks.checks.database = { ok: false, error: e.message };
    checks.ok = false;
    status.http = 503;
  }

  // WAL size check (should be < 5MB under normal operation)
  try {
    const walPath = path.join(__dirname, 'database.sqlite-wal');
    if (fs.existsSync(walPath)) {
      const walSize = fs.statSync(walPath).size;
      checks.checks.wal = { ok: walSize < 5 * 1024 * 1024, size_bytes: walSize };
    } else {
      checks.checks.wal = { ok: true, note: 'no WAL file' };
    }
  } catch (e) {
    checks.checks.wal = { ok: false, error: e.message };
  }

  // Backup check — most recent backup age
  // Supports both legacy backup/ (pattern: backup-*.db) and current backups/ (pattern: database_*.sqlite.gz)
  try {
    const projectRoot = __dirname;
    const candidateDirs = [
      path.join(projectRoot, 'backups'),
      path.join(projectRoot, 'backup'),
    ];
    const allFiles = [];
    for (const dir of candidateDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          // Accept legacy pattern (backup-YYYY-MM-DD-HHMM.db) or current pattern (database_YYYYMMDD_HHMMSS.sqlite.gz)
          const isLegacy = f.startsWith('backup-') && f.endsWith('.db');
          const isCurrent = f.startsWith('database_') && (f.endsWith('.sqlite') || f.endsWith('.sqlite.gz') || f.endsWith('.db'));
          if (isLegacy || isCurrent) {
            allFiles.push({ name: f, dir, time: st.mtime });
          }
        } catch (_) {}
      }
    }
    allFiles.sort((a, b) => b.time - a.time);
    if (allFiles.length > 0) {
      const latest = allFiles[0];
      const ageHours = (Date.now() - latest.time.getTime()) / (1000 * 60 * 60);
      checks.checks.backup = {
        ok: ageHours < 26,
        last_file: latest.name,
        last_dir: path.basename(latest.dir),
        age_hours: Math.round(ageHours * 10) / 10,
      };
      if (ageHours > 26) { checks.ok = false; status.http = 503; }
    } else {
      checks.checks.backup = { ok: false, note: 'no backup files found' };
      checks.ok = false;
    }
  } catch (e) {
    checks.checks.backup = { ok: false, error: e.message };
    checks.ok = false;
  }

  // Auto-deploy info (for monitoring)
  checks.checks.deploy = {
    status: deployState.status,
    last_at: deployState.last_deploy_at,
    last_commit: deployState.commit,
    trigger: deployState.trigger,
    rate_limit_active: deployState.rate_limit_until ? Date.now() < deployState.rate_limit_until : false,
  };

  // Memory usage
  const mem = process.memoryUsage();
  checks.checks.memory = {
    heapUsed_mb: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotal_mb: Math.round(mem.heapTotal / 1024 / 1024),
    rss_mb: Math.round(mem.rss / 1024 / 1024),
  };

  res.status(status.http).json(checks);
});

// ==================== CLOUD DISCOVERY ====================
app.get('/api/discover', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  const { deviceId } = req.query;
  const isCloudServer = process.env.IS_CLOUD_SERVER === 'true' || process.env.CLOUD_MODE === 'true';

  const interfaces = os.networkInterfaces();
  const lanIPs = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        lanIPs.push(iface.address);
      }
    }
  }

  if (isCloudServer && deviceId) {
    try {
      db.prepare(`INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)`)
        .run(`device_last_seen_${deviceId}`, new Date().toJSON());
    } catch {}
  }

  const cloudDomain = process.env.CLOUD_DOMAIN || null;
  const primaryUrl = cloudDomain || (lanIPs.length > 0 ? `http://${lanIPs[0]}:${PORT}` : null);

  res.json({
    cloud: true,
    name: DISTRIBUTOR_NAME,
    lanIPs,
    url: primaryUrl,
    domain: cloudDomain,
    isCloudServer,
    serverTime: new Date().toISOString()
  });
});

// ==================== ERROR HANDLER ====================
app.use((err, req, res, next) => {
  logger.error('Unhandled server error', { message: err.message, stack: err.stack });
  if (err.message?.includes('SQLITE_CANTOPEN')) {
    return res.status(503).json({ error: 'Database not available' });
  }
  const wantsHtml = req.method === 'GET' && !req.path.startsWith('/api') && req.accepts('html');
  if (wantsHtml) {
    res.type('html');
    return res.status(500).send(
      '<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Lỗi máy chủ</title></head><body style="font-family:system-ui;padding:1.5rem;max-width:32rem">' +
        '<h1 style="color:#b91c1c">Lỗi máy chủ (500)</h1>' +
        '<p>Vui lòng thử lại sau hoặc gửi log cho admin.</p>' +
        '<pre style="background:#f3f4f6;padding:12px;border-radius:8px;overflow:auto;font-size:12px">' +
        String(err.message || err).replace(/</g, '&lt;') +
        '</pre></body></html>'
    );
  }
  res.status(500).json({ success: false, error: 'Server error' });
});

// Global error handler - must be last middleware
app.use(errorHandler);

// 404 handler - must be before errorHandler
app.use(notFoundHandler);

// ==================== START ====================
const isCloudServer = process.env.IS_CLOUD_SERVER === 'true' || process.env.CLOUD_MODE === 'true';
if (isCloudServer) {
  process.env.IS_CLOUD_SERVER = 'true';
  logger.info('Cloud server mode ENABLED');
}

function getNetworkIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, ip: iface.address });
      }
    }
  }
  return ips;
}

// Load deploy state from previous run (if any)
loadDeployState().then(() => {
  logger.info('Deploy state loaded', { status: deployState.status });
}).catch((e) => {
  logger.warn('Deploy state load failed', { error: e.message });
});

const server = app.listen(PORT, HOST, () => {
  // Initialize real-time WebSocket server (Socket.IO)
  // Socket.IO is integrated with the Express HTTP server and works through Nginx
  // with the proper Upgrade headers on the /socket.io/ location.
  socketServer.init(server);

  const networkIPs = getNetworkIPs();
  logger.info('Beer POS Pro v2 started');
  logger.info(`Mode: ${isCloudServer ? 'Cloud Server' : 'Standard'}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  const urls = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
  networkIPs.forEach(({ ip }) => urls.push(`http://${ip}:${PORT}`));
  logger.info(`Access URLs: ${urls.join(', ')}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use!`);
    process.exit(1);
  }
  throw err;
});
