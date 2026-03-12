// Beer POS Pro v2 - Simple Server
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Quá nhiều yêu cầu, vui lòng thử lại sau' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to all API routes
app.use('/api', limiter);

// Middleware
app.use(bodyParser.json({ limit: '10mb' })); // Limit request body size
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// View engine for HTML templates
app.set('view engine', 'html');
app.engine('html', require('ejs').renderFile);

// Constants
const DISTRIBUTOR_NAME = 'Bia Tươi Gia Huy';

// API Key - Disabled for local LAN app
app.use('/api', (req, res, next) => {
  next();
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
    console.log(`[${now.toISOString()}] Auto backup created: backup-${timestamp}.db`);

    // Clean old backups (keep last 30 days)
    cleanupOldBackups(backupDir);

    return { success: true, file: backupFile };
  } catch (e) {
    console.error('Backup failed:', e.message);
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
      console.log(`Deleted old backup: ${f.name}`);
    });
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}

// Schedule daily backup at midnight
cron.schedule('0 0 * * *', () => {
  createBackup({ hourly: false });
});

// Schedule hourly backup during working hours (6 AM - 10 PM)
for (let hour = 6; hour <= 22; hour++) {
  cron.schedule(`0 ${hour} * * *`, () => {
    createBackup({ hourly: true });
  });
}

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
app.use('/report', require('./routes/report'));
app.use('/backup', require('./routes/backup'));
app.use('/devices', require('./routes/devices'));

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

// ==================== SYNC API ====================
// Simple sync endpoints for cloud backup
const db = require('./database');

// POST /api/sync/push - Push local changes to cloud (placeholder for cloud integration)
app.post('/api/sync/push', (req, res) => {
  const { cloudUrl } = req.body;

  if (!cloudUrl) {
    return res.status(400).json({ error: 'Cloud URL required' });
  }

  try {
    // Get pending sync items
    const pending = db.prepare(`
      SELECT * FROM sync_queue
      WHERE synced = 0
      ORDER BY created_at ASC
      LIMIT 50
    `).all();

    // In a real implementation, this would send data to cloud
    // For now, just mark items as synced (local-only mode)
    if (pending.length > 0) {
      const ids = pending.map(p => p.id);
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`UPDATE sync_queue SET synced = 1 WHERE id IN (${placeholders})`).run(...ids);
    }

    res.json({
      success: true,
      synced: pending.length,
      message: 'Data synced (local mode)'
    });
  } catch (err) {
    console.error('Sync push error:', err);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

// POST /api/sync/pull - Pull data from cloud (placeholder for cloud integration)
app.post('/api/sync/pull', (req, res) => {
  const { cloudUrl, lastSync } = req.body;

  if (!cloudUrl) {
    return res.status(400).json({ error: 'Cloud URL required' });
  }

  try {
    // In a real implementation, this would fetch data from cloud
    // and merge with local database
    // For now, return empty (local-only mode)

    res.json({
      success: true,
      imported: 0,
      message: 'No data to pull (local mode)'
    });
  } catch (err) {
    console.error('Sync pull error:', err);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

// GET /api/sync/status - Get sync status
app.get('/api/sync/status', (req, res) => {
  try {
    const pending = db.prepare('SELECT COUNT(*) as count FROM sync_queue WHERE synced = 0').get();
    const lastSync = db.prepare("SELECT value FROM sync_meta WHERE key = 'last_sync'").get();

    res.json({
      pending: pending.count,
      lastSync: lastSync ? lastSync.value : null
    });
  } catch (err) {
    console.error('Sync status error:', err);
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

// ==================== HEALTH CHECK ====================
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ==================== ERROR HANDLER ====================
// Middleware xử lý lỗi - tránh crash server
app.use((err, req, res, next) => {
  console.error('Server Error:', err.message);
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
app.listen(PORT, () => {
  console.log(`🍺 Beer POS Pro v2 running on port ${PORT}`);
});
