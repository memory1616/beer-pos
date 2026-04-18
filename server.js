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
  max: 100,
  message: { error: 'Quá nhiều yêu cầu, vui lòng thử lại sau' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/discover' || req.path === '/api/auth/me',
  validate: { xForwardedForHeader: false },
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
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  // Allow all origins for cloud sync (devices from different locations)
  // In production, you can restrict to specific domains if needed
  res.setHeader('Access-Control-Allow-Origin', '*');
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
      scriptSrcAttr: ["'unsafe-inline'"], // Allow inline event handlers
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:', 'https:', 'https://img.vietqr.io'],
      connectSrc: ["'self'", 'http://103.75.183.57:3000', 'https://admin.biatuoitayninh.store', 'https://biatuoitayninh.store', 'https://img.vietqr.io', 'https://unpkg.com', 'https://cdn.jsdelivr.net'],
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

// ── GitHub webhook: POST /deploy (khớp Payload URL trên GitHub)
// Phải dùng raw body + đặt TRƯỚC bodyParser.json để verify HMAC đúng.
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';

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

app.post(
  '/deploy',
  express.raw({ type: ['application/json', 'application/*+json'], limit: '10mb' }),
  (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf)) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    const sig = req.get('x-hub-signature-256');
    const computedSecret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!computedSecret) {
      res.status(503).json({ error: 'NO_SECRET' });
      return;
    }
    if (!verifyGithubSignature256(buf, sig)) {
      res.status(401).json({
        error: 'Unauthorized',
        debug: {
          hasSecret: !!computedSecret,
          secretLen: computedSecret.length,
          hasSig: !!sig,
          sigHeader: sig,
          bodyLen: buf.length,
          bodyPreview: buf.toString('utf8').substring(0, 50)
        }
      });
      return;
    }

    const event = req.get('x-github-event') || '';
    if (event === 'ping') {
      return res.json({ ok: true, message: 'pong' });
    }
    if (event && event !== 'push') {
      return res.json({ ok: true, ignored: event });
    }

    let payload;
    try {
      payload = JSON.parse(buf.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const ref = payload.ref;
    if (ref && ref !== 'refs/heads/main') {
      return res.json({ ok: true, ignored_ref: ref });
    }

    const deployScript = path.join(__dirname, 'deploy', 'deploy.sh');
    if (!fs.existsSync(deployScript)) {
      return res.status(500).json({ error: 'Deploy script not found' });
    }

    logger.info('POST /deploy: push main — chạy deploy/deploy.sh');

    const { exec } = require('child_process');
    exec(`bash "${deployScript}"`, { cwd: __dirname }, (err, stdout, stderr) => {
      if (err) logger.error('Deploy failed', { error: err.message });
      else {
        if (stdout) logger.info('Deploy output: ' + stdout.trim());
        if (stderr) logger.warn('Deploy stderr: ' + stderr.trim());
        logger.info('Deploy completed successfully');
      }
    });

    return res.json({ ok: true, message: 'Deploy started' });
  }
);

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
app.use(express.static(path.join(__dirname, 'public')));

// Favicon — always serve icon
app.get('/favicon.ico', (req, res) => {
  res.type('image/png');
  res.sendFile(path.join(__dirname, 'public', 'icon-192.png'));
});

// Service Worker — always fresh, never cache
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
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
function createBackup(options = {}) {
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
    fs.copyFileSync(dbPath, backupFile);

    // === Integrity check: try to open backup with SQLite ===
    let integrityOk = false;
    try {
      const BackupDb = require('better-sqlite3');
      const testDb = new BackupDb(backupFile, { readonly: true });
      const result = testDb.prepare('PRAGMA integrity_check').get();
      testDb.close();
      integrityOk = result && result.integrity_check === 'ok';
    } catch (_) {
      // Fallback: check file size is reasonable (> 10KB)
      const stat = fs.statSync(backupFile);
      integrityOk = stat.size > 10 * 1024;
    }

    if (!integrityOk) {
      logger.warn(`Backup file may be corrupted: ${backupFile}, attempting re-copy...`);
      // Re-copy with a corrupt marker
      fs.renameSync(backupFile, backupFile.replace('.db', '.corrupt.db'));
      fs.copyFileSync(dbPath, backupFile);
      logger.info('Backup re-copied successfully');
    }

    logger.info(`Auto backup: backup-${timestamp}.db (integrity: ${integrityOk ? 'OK' : 'RECHECKED'})`);
    cleanupOldBackups(backupDir);
    return { success: true, file: backupFile, integrity: integrityOk };
  } catch (e) {
    logger.error('Backup failed', { error: e.message });
    return { success: false, error: e.message };
  }
}

function cleanupOldBackups(backupDir) {
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('backup-') && f.endsWith('.db'))
      .map(f => ({ name: f, path: path.join(backupDir, f), time: fs.statSync(path.join(backupDir, f)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time);
    files.slice(30).forEach(f => {
      fs.unlinkSync(f.path);
      logger.info(`Deleted old backup: ${f.name}`);
    });
  } catch (e) {
    logger.error('Cleanup error', { error: e.message });
  }
}

cron.schedule('0 23 * * *', () => createBackup({ daily: true }));

// ==================== WAL CHECKPOINT (keep WAL file small) ====================
// Run every 6 hours to checkpoint WAL → main DB, keeping WAL file small
cron.schedule('0 */6 * * *', () => {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    logger.info('WAL checkpoint completed (TRUNCATE mode)');
  } catch (e) {
    logger.error('WAL checkpoint failed', { error: e.message });
  }
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

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
app.get('/customers', (req, res) => res.sendFile(path.join(__dirname, 'views', 'customers.html')));
app.get('/customer/:id', (req, res) => res.sendFile(path.join(__dirname, 'views', 'customer-detail.html')));
app.get('/stock', (req, res) => res.sendFile(path.join(__dirname, 'views', 'stock.html')));
app.get('/purchases', (req, res) => res.sendFile(path.join(__dirname, 'views', 'purchases.html')));
app.get('/kegs', (req, res) => res.sendFile(path.join(__dirname, 'views', 'kegs.html')));
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

// Report data API — must be BEFORE app.use('/report') to take priority
// Supports both formats:
//   - Dashboard format: ?mode=quick&period=today|week|month
//   - Report page format: ?type=month&month=4&year=2026
app.get('/report/data', (req, res) => {
  try {
    var now = new Date();
    var vn = new Date(now.getTime() + 7 * 3600000);
    var year = String(vn.getUTCFullYear());
    var month = String(vn.getUTCMonth() + 1).padStart(2, '0');
    var day = String(vn.getUTCDate()).padStart(2, '0');
    var today = year + '-' + month + '-' + day;
    var startDate, endDate;

    // Report page format: ?type=month&month=4&year=2026
    var type = req.query.type;
    if (type) {
      var rYear = parseInt(req.query.year) || vn.getUTCFullYear();
      var rMonth = parseInt(req.query.month);
      if (type === 'month' && rMonth) {
        var lastDay = new Date(rYear, rMonth, 0).getDate();
        startDate = rYear + '-' + String(rMonth).padStart(2, '0') + '-01';
        endDate = rYear + '-' + String(rMonth).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');
      } else if (type === 'year') {
        startDate = rYear + '-01-01';
        endDate = rYear + '-12-31';
      } else if (type === 'custom' && req.query.startDate && req.query.endDate) {
        startDate = req.query.startDate;
        endDate = req.query.endDate;
      } else {
        // all
        startDate = '1970-01-01';
        endDate = '2100-12-31';
      }
    } else {
      // Dashboard format: ?mode=quick&period=today|week|month
      var mode = req.query.mode || 'quick';
      var period = req.query.period || 'today';
      var fromParam = req.query.from;
      var toParam = req.query.to;

      if (mode === 'custom' && fromParam && toParam) {
        startDate = fromParam;
        endDate = toParam;
      } else if (period === 'today') {
        startDate = today;
        endDate = today;
      } else if (period === 'week') {
        var wa = new Date(vn); wa.setUTCDate(wa.getUTCDate() - 7);
        startDate = wa.getUTCFullYear() + '-' + String(wa.getUTCMonth()+1).padStart(2,'0') + '-' + String(wa.getUTCDate()).padStart(2,'0');
        endDate = today;
      } else {
        // month (default)
        startDate = year + '-' + month + '-01';
        endDate = today;
      }
    }

    var db2 = require('./database');

    // Detect which date column exists in sales table for backward compatibility
    // Production DB has `date`, legacy DBs may have `created_at` instead
    var dateCol = 's.date';
    try {
      var cols = db2.prepare("PRAGMA table_info(sales)").all().map(r => r.name);
      if (!cols.includes('date')) {
        if (cols.includes('created_at')) {
          dateCol = 's.created_at';
        } else {
          dateCol = 's.date'; // will throw at query level, but at least we tried
        }
      }
    } catch(_) {}

    // Sales.date is stored as YYYY-MM-DD (getVietnamDateStr). String compare against
    // 'YYYY-MM-DD 00:00:00' fails in SQLite ('2026-04-05' < '2026-04-05 00:00:00').
    // Use date() so plain dates and ISO timestamps both match the range.
    var startDay = startDate.split(' ')[0];
    var endDay = endDate.split(' ')[0];
    var dateCond = 'date(' + dateCol + ') >= date(?) AND date(' + dateCol + ') <= date(?)';
    var dateParams = [startDay, endDay];
    var salesDateBare = dateCol.indexOf('created_at') !== -1 ? 'created_at' : 'date';

    var sales = db2.prepare(
      "SELECT s.id, s.customer_id, s.date, s.total, s.profit, s.type, s.deliver_kegs, s.return_kegs, COALESCE(c.name, 'Khách lẻ') as customer_name, (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si WHERE si.sale_id = s.id) as quantity FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.archived = 0 AND (s.status IS NULL OR s.status != 'returned') AND " + dateCond +
      " ORDER BY datetime(" + dateCol + ") DESC LIMIT 50"
    ).all(...dateParams);

    var revR = db2.prepare('SELECT COALESCE(SUM(total), 0) as t FROM sales WHERE archived = 0 AND (status IS NULL OR status != \'returned\') AND type = \'sale\' AND date(' + salesDateBare + ') >= date(?) AND date(' + salesDateBare + ') <= date(?)').get(...dateParams);
    var profR = db2.prepare('SELECT COALESCE(SUM(profit), 0) as t FROM sales WHERE archived = 0 AND (status IS NULL OR status != \'returned\') AND type = \'sale\' AND date(' + salesDateBare + ') >= date(?) AND date(' + salesDateBare + ') <= date(?)').get(...dateParams);
    var ordR = db2.prepare('SELECT COUNT(*) as t FROM sales WHERE archived = 0 AND (status IS NULL OR status != \'returned\') AND type = \'sale\' AND date(' + salesDateBare + ') >= date(?) AND date(' + salesDateBare + ') <= date(?)').get(...dateParams);
    var totalRevenue = revR ? revR.t : 0;
    var totalProfit = profR ? profR.t : 0;
    var totalOrders = ordR ? ordR.t : 0;
    var totalExpense = 0;
    try { var expR = db2.prepare('SELECT COALESCE(SUM(amount), 0) as t FROM expenses WHERE date >= ? AND date <= ?').get(startDay, endDay); totalExpense = expR ? expR.t : 0; } catch(_){}

    var daily = db2.prepare(
      "SELECT date(" + dateCol + ") as date, COALESCE(SUM(s.total), 0) as revenue, COALESCE(SUM(s.profit), 0) as profit, COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE date(e.date) = date(" + dateCol + ")), 0) as expense FROM sales s WHERE s.archived = 0 AND (s.status IS NULL OR s.status != 'returned') AND " + dateCond +
      " GROUP BY date(" + dateCol + ") ORDER BY date DESC LIMIT 30"
    ).all(...dateParams);

    var profitByProduct = db2.prepare(
      'SELECT p.id, p.name, p.type, SUM(si.quantity) as quantity_sold, COUNT(DISTINCT si.sale_id) as order_count, SUM(si.quantity * si.price) as revenue, SUM(si.quantity * si.cost_price) as cost, SUM(si.profit) as profit FROM sale_items si JOIN products p ON p.id = si.product_id JOIN sales s ON s.id = si.sale_id WHERE s.archived = 0 AND (s.status IS NULL OR s.status != \'returned\') AND ' + dateCond +
      ' GROUP BY p.id ORDER BY SUM(si.profit) DESC LIMIT 20'
    ).all(...dateParams);

    // profitByCustomer — quantity = tổng lít (số trong tên SP VD "Bia 30L" × số lượng dòng)
    function litersFromProductName(name) {
      if (!name) return 1;
      var m = String(name).match(/(\d+)\s*[Ll]/);
      return m ? parseInt(m[1], 10) : 1;
    }
    var profitByCustomer = db2.prepare(
      'SELECT c.id, c.name, COUNT(s.id) as order_count, SUM(s.total) as revenue, SUM(s.profit) as profit ' +
      'FROM sales s JOIN customers c ON c.id = s.customer_id WHERE s.archived = 0 AND s.type = \'sale\' AND ' + dateCond +
      ' GROUP BY c.id ORDER BY profit DESC LIMIT 20'
    ).all(...dateParams);

    var literRows = db2.prepare(
      'SELECT s.customer_id, p.name as product_name, si.quantity ' +
      'FROM sale_items si ' +
      'JOIN sales s ON s.id = si.sale_id ' +
      'JOIN products p ON p.id = si.product_id ' +
      "WHERE s.archived = 0 AND s.type = 'sale' AND (s.status IS NULL OR s.status != 'returned') AND " + dateCond
    ).all(...dateParams);
    var literByCustomerId = {};
    for (var lr = 0; lr < literRows.length; lr++) {
      var cid = literRows[lr].customer_id;
      if (cid == null) continue;
      var L = litersFromProductName(literRows[lr].product_name) * (Number(literRows[lr].quantity) || 0);
      literByCustomerId[cid] = (literByCustomerId[cid] || 0) + L;
    }
    profitByCustomer = profitByCustomer.map(function (row) {
      return Object.assign({}, row, { quantity: literByCustomerId[row.id] || 0 });
    });

    // Purchases report: get all purchase records in date range
    var purchases = [];
    try {
      var purchaseCols = db2.prepare("PRAGMA table_info(purchases)").all().map(r => r.name);
      var purchaseDateCol = purchaseCols.includes('date') ? 'date' : (purchaseCols.includes('created_at') ? 'created_at' : 'date');
      var purchaseDateCond = 'date(' + purchaseDateCol + ') >= date(?) AND date(' + purchaseDateCol + ') <= date(?)';
      purchases = db2.prepare(
        "SELECT p.id, p.date, p.total_amount as total, COALESCE(p.note, '') as note, " +
        "(SELECT COUNT(*) FROM purchase_items WHERE purchase_id = p.id) as item_count " +
        "FROM purchases p WHERE " + purchaseDateCond + " ORDER BY datetime(" + purchaseDateCol + ") DESC"
      ).all(...dateParams);

      // Add purchase items detail
      for (var pi = 0; pi < purchases.length; pi++) {
        purchases[pi].items = db2.prepare(
          "SELECT pi.product_id, pr.name as product_name, pi.quantity, pi.unit_price, pi.total_price " +
          "FROM purchase_items pi JOIN products pr ON pr.id = pi.product_id WHERE pi.purchase_id = ?"
        ).all(purchases[pi].id);
      }
    } catch(e) {
      console.error('[REPORT] Purchases query error:', e.message);
    }

    var totalPurchaseAmount = purchases.reduce(function(s, p) { return s + (p.total || 0); }, 0);

    res.json({ sales, totalRevenue, totalProfit, totalOrders, totalExpense, daily, profitByProduct, profitByCustomer, purchases, totalPurchaseAmount });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// routes/report.js handles remaining /report/* paths (profit by customer, etc.)
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

// ==================== WEBHOOK DEPLOY ====================
// POST /webhook/deploy - Trigger auto-deploy (protected by secret token)
const DEPLOY_WEBHOOK_SECRET = process.env.DEPLOY_WEBHOOK_SECRET || null;

app.post('/webhook/deploy', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace(/^Bearer\s+/i, '') || req.body?.token || req.query?.token;
  
  // If secret is configured, validate it
  if (DEPLOY_WEBHOOK_SECRET && token !== DEPLOY_WEBHOOK_SECRET) {
    logger.warn('Webhook deploy rejected: invalid token');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { exec } = require('child_process');
  const deployScript = path.join(__dirname, 'deploy', 'deploy.sh');
  
  if (!fs.existsSync(deployScript)) {
    return res.status(500).json({ error: 'Deploy script not found' });
  }
  
  logger.info('Webhook deploy triggered');
  
  // Run deploy script asynchronously
  exec(`bash "${deployScript}"`, { cwd: __dirname }, (err, stdout, stderr) => {
    if (err) {
      logger.error('Deploy failed', { error: err.message });
      return; // Don't respond to webhook request after timeout
    }
    if (stdout) logger.info('Deploy output: ' + stdout.trim());
    if (stderr) logger.warn('Deploy stderr: ' + stderr.trim());
    logger.info('Deploy completed successfully');
  });
  
  // Respond immediately to avoid timeout
  res.json({ ok: true, message: 'Deploy started' });
});

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
  try {
    const backupDir = path.join(__dirname, 'backup');
    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('backup-') && f.endsWith('.db'))
        .map(f => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtime }))
        .sort((a, b) => b.time - a.time);
      if (files.length > 0) {
        const ageHours = (Date.now() - files[0].time.getTime()) / (1000 * 60 * 60);
        checks.checks.backup = { ok: ageHours < 26, last_file: files[0].name, age_hours: Math.round(ageHours * 10) / 10 };
        if (ageHours > 26) { checks.ok = false; status.http = 503; }
      } else {
        checks.checks.backup = { ok: false, note: 'no backup files found' };
        checks.ok = false;
      }
    } else {
      checks.checks.backup = { ok: false, note: 'no backup dir' };
      checks.ok = false;
    }
  } catch (e) {
    checks.checks.backup = { ok: false, error: e.message };
    checks.ok = false;
  }

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
