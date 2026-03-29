// Beer POS Pro v2 - Simple Server
process.env.TZ = 'Asia/Ho_Chi_Minh';
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const os = require('os');
const logger = require('./src/utils/logger');
const db = require('./database');
const { getSession, AUTH_CONFIG } = require('./middleware/auth');

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
  if (host === ADMIN_DOMAIN || host.endsWith('.admin.' + PUBLIC_DOMAIN.replace('www.', ''))) return 'admin';
  return 'public';
}

// Rate limiting — skip /api/discover (LAN scan pings)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Quá nhiều yêu cầu, vui lòng thử lại sau' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/discover',
});
app.use('/api', limiter);

// CORS — allow admin subdomain to call API from public domain (for sync)
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  // Allow admin subdomain and localhost for dev
  const allowedOrigins = [
    `https://${ADMIN_DOMAIN}`,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ];
  if (allowedOrigins.includes(origin) || origin === '*') {
    res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
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

        // Inject app context globals
        const ctxScript = `<script>
window.APP_MODE = '${mode}';
window.BASE_PATH = ${basePath ? `'${basePath}'` : 'null'};
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
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
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
    logger.info(`Auto backup: backup-${timestamp}.db`);
    cleanupOldBackups(backupDir);
    return { success: true, file: backupFile };
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
app.get('/sale', (req, res) => res.sendFile(path.join(__dirname, 'views', 'sales.html')));
app.get('/stock', (req, res) => res.sendFile(path.join(__dirname, 'views', 'stock.html')));
app.get('/analytics', (req, res) => res.sendFile(path.join(__dirname, 'views', 'analytics.html')));
app.get('/delivery', (req, res) => res.sendFile(path.join(__dirname, 'views', 'delivery.html')));
app.get('/products', (req, res) => res.sendFile(path.join(__dirname, 'views', 'products.html')));
app.get('/purchases', (req, res) => res.sendFile(path.join(__dirname, 'views', 'purchases.html')));
app.get('/kegs', (req, res) => res.sendFile(path.join(__dirname, 'views', 'kegs.html')));
app.get('/report', (req, res) => res.sendFile(path.join(__dirname, 'views', 'report.html')));
app.get('/backup', (req, res) => res.sendFile(path.join(__dirname, 'views', 'backup.html')));
app.get('/devices', (req, res) => res.sendFile(path.join(__dirname, 'views', 'devices.html')));
app.get('/expenses', (req, res) => res.sendFile(path.join(__dirname, 'views', 'expenses.html')));

// Redirect legacy /admin/* paths to clean paths
app.use('/admin', (req, res) => res.redirect(req.path === '/admin' ? '/' : req.path));

// ==================== API ROUTES ====================
app.use('/api/customers', require('./routes/api/customers'));
app.use('/api/products', require('./routes/api/products'));
app.use('/api/sales', require('./routes/api/sales'));
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

// ==================== AUTH ====================
app.use('/auth', require('./routes/login'));

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

// ==================== HEALTH CHECK ====================
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
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
  logger.error('Unhandled server error', { message: err.message });
  if (err.message?.includes('SQLITE_CANTOPEN')) {
    return res.status(503).json({ error: 'Database not available' });
  }
  res.status(500).json({ error: 'Server error' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

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
