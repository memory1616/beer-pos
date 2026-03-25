// Beer POS Pro v2 - Simple Server
process.env.TZ = 'Asia/Ho_Chi_Minh';
require('dotenv').config();
const express = require('express');
const http = require('http'); // Feature #14: For WebSocket
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const os = require('os');
const logger = require('./src/utils/logger');
const { getSession, AUTH_CONFIG } = require('./middleware/auth');
const { migrateSalesToLedger } = require('./src/modules/keg');

// Feature #14: WebSocket initialization
const { initWebSocket, broadcast, sendDashboardStats, sendKegState } = require('./src/services/websocket');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Get network interfaces for logging
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

// Rate limiting configuration — skip /api/discover (LAN scan sends 500+ pings)

// Migration: đồng bộ sales cũ vào keg_ledger (chạy 1 lần)
migrateSalesToLedger();
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Quá nhiều yêu cầu, vui lòng thử lại sau' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.baseUrl + req.path === '/api/discover',
});

// Apply rate limiting to all API routes (skipping /api/discover which is a LAN ping)
app.use('/api', limiter);

// CORS for LAN cloud sync — allows requests from any device in the network
app.use('/api/sync', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Middleware
app.use(bodyParser.json({ limit: '10mb' })); // Limit request body size
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Favicon - inline SVG beer mug
app.get('/favicon.ico', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🍺</text></svg>`;
  res.type('image/svg+xml').send(svg);
});

// Request logger — only log slow requests (>500ms) or errors
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

// View engine for HTML templates
app.set('view engine', 'html');
app.engine('html', require('ejs').renderFile);

// Constants
const DISTRIBUTOR_NAME = process.env.DISTRIBUTOR_NAME || 'Bia Tươi Gia Huy';

// API routes - require authentication (except /session and /customers/login)
const { requireAuth } = require('./middleware/auth');
app.use('/api', (req, res, next) => {
  if (req.path === '/session' || req.path === '/customers/login') return next();
  requireAuth(req, res, next);
});

// Helper function to format VNĐ
function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

// Make helpers available to all routes
app.locals.formatVND = formatVND;
app.locals.DISTRIBUTOR_NAME = DISTRIBUTOR_NAME;

// ==================== AUTO BACKUP ====================
function createBackup(options = {}) {
  const backupDir = path.join(__dirname, 'backup');
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');

  // Ensure backup directory exists
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const dbPath = path.join(__dirname, 'database.sqlite');

  // Create timestamped backup
  const timestamp = `${today}-${hour}${minute}`;
  const backupFile = path.join(backupDir, `backup-${timestamp}.db`);

  try {
    fs.copyFileSync(dbPath, backupFile);
    logger.info(`Auto backup created: backup-${timestamp}.db`, { path: backupFile });

    // Clean old backups (keep last 30 days)
    cleanupOldBackups(backupDir);

    return { success: true, file: backupFile };
  } catch (e) {
    logger.error('Backup failed', { error: e.message });
    return { success: false, error: e.message };
  }
}

// Clean old backup files (keep last 30 days)
function cleanupOldBackups(backupDir) {
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('backup-') && f.endsWith('.db'))
      .map(f => ({
        name: f,
        path: path.join(backupDir, f),
        time: fs.statSync(path.join(backupDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time);

    // Keep only the 30 most recent files
    const toDelete = files.slice(30);
    toDelete.forEach(f => {
      fs.unlinkSync(f.path);
      logger.info(`Deleted old backup: ${f.name}`);
    });
  } catch (e) {
    logger.error('Cleanup error', { error: e.message });
  }
}

// Schedule daily backup at 23:00 (11 PM)
cron.schedule('0 23 * * *', () => {
  createBackup({ daily: true });
});

// ==================== WEB ROUTES ====================
app.use('/login', require('./routes/login'));
app.use('/', require('./routes/dashboard'));
app.use('/customers', require('./routes/customers'));
app.use('/sale', require('./routes/sales'));
app.use('/sales', (req, res) => res.redirect('/sale'));
app.use('/stock', require('./routes/stock'));
app.use('/analytics', require('./routes/analytics'));
app.use('/delivery', require('./routes/delivery'));
app.use('/products', require('./routes/products'));
app.use('/purchases', require('./routes/purchases'));
app.use('/kegs', require('./routes/kegs'));
app.use('/report', require('./routes/report'));
app.use('/backup', require('./routes/backup'));
app.use('/devices', require('./routes/devices'));
app.use('/expenses', require('./routes/expenses'));

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
// Feature #12: Audit log API
app.use('/api/audit', require('./routes/api/audit'));

// ==================== SYNC API ====================
// Offline-first multi-device sync
app.use('/api/sync', require('./routes/api/sync'));

// ==================== AUTH CHECK API ====================
// Quick auth check for client-side redirects
app.get('/api/auth/me', (req, res) => {
  const cookieToken = req.cookies?.[AUTH_CONFIG.cookieName];
  const headerToken = req.headers.authorization?.replace('Bearer ', '');
  const token = cookieToken || headerToken;

  if (!token) {
    return res.status(401).json({ loggedIn: false });
  }
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ loggedIn: false });
  }
  res.json({ loggedIn: true, username: session.username });
});

// ==================== HEALTH CHECK ====================
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ==================== CLOUD DISCOVERY ====================
// Giúp các thiết bị trong LAN tự động tìm cloud server
app.get('/api/discover', (req, res) => {
  // CORS for LAN cross-origin requests (browsers block cross-origin from LAN IPs)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  const { deviceId } = req.query;
  const isCloudServer = process.env.IS_CLOUD_SERVER === 'true' || process.env.CLOUD_MODE === 'true';

  // Get all LAN IP addresses of this server (skip loopback/internal)
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

  res.json({
    cloud: true,
    name: DISTRIBUTOR_NAME,
    // Array of all LAN IPs so client can pick the right one
    lanIPs,
    // Primary URL based on first found LAN IP (not req.get('host') which may be localhost)
    url: lanIPs.length > 0 ? `http://${lanIPs[0]}:${PORT}` : null,
    version: '1.0.0',
    isCloudServer,
    serverTime: new Date().toISOString()
  });
});

// ==================== ERROR HANDLER ====================
// Middleware xử lý lỗi - tránh crash server
app.use((err, req, res, next) => {
  logger.error('Unhandled server error', { message: err.message, stack: err.stack });
  if (err.message && err.message.includes('SQLITE_CANTOPEN')) {
    return res.status(503).json({ error: 'Database not available' });
  }
  res.status(500).json({ error: 'Server error' });
});

// ==================== 404 HANDLER ====================
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ==================== START SERVER ====================
// Detect cloud mode: if cloudUrl is set in env or starts as cloud
const isCloudServer = process.env.IS_CLOUD_SERVER === 'true' || process.env.CLOUD_MODE === 'true';
if (isCloudServer) {
  process.env.IS_CLOUD_SERVER = 'true';
  logger.info('Cloud server mode ENABLED');
}

// Prevent multiple instances
// Feature #14: Use http.Server for WebSocket support
const server = http.createServer(app);

// Initialize WebSocket
initWebSocket(server);

// Schedule periodic dashboard stats broadcast (every 30 seconds)
cron.schedule('*/30 * * * * *', () => {
  try {
    broadcast('dashboard:ping', { serverTime: new Date().toISOString() });
  } catch (e) {
    // Ignore errors in cron
  }
});

server.listen(PORT, HOST, () => {
  const networkIPs = getNetworkIPs();

  logger.info('Beer POS Pro v2 started');
  logger.info(`Server started at ${new Date().toISOString()}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`Hostname: ${os.hostname()}`);
  if (isCloudServer) logger.info('Mode: Cloud Server');
  logger.info('WebSocket: Enabled (socket.io)');

  const urls = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
  networkIPs.forEach(({ name, ip }) => urls.push(`http://${ip}:${PORT}`));
  logger.info(`Access URLs: ${urls.join(', ')}`);
  logger.info(`WebSocket URL: ws://localhost:${PORT}`);
});

// Handle server errors (e.g., port already in use)
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use!`);
    process.exit(1);
  }
  throw err;
});
