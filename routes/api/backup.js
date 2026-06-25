const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../../src/utils/logger');

const BACKUP_DIR = path.join(__dirname, '../../backup');
const DB_PATH = path.join(__dirname, '../../database.sqlite');

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// GET /api/backup/list - List all backups
router.get('/list', async (req, res) => {
  try {
    const files = await fs.promises.readdir(BACKUP_DIR);
    const result = [];
    for (const f of files) {
      if (!f.endsWith('.db') && !f.endsWith('.sqlite')) continue;
      try {
        const stats = await fs.promises.stat(path.join(BACKUP_DIR, f));
        result.push({
          name: f,
          size: formatBytes(stats.size),
          created: stats.birthtime.toISOString()
        });
      } catch (_) {}
    }
    result.sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json({ backups: result });
  } catch (error) {
    logger.error('List backups error', { error: error.message });
    res.status(500).json({ error: 'Failed to list backups' });
  }
});

// GET /api/backup/create - Create manual backup
router.get('/create', async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = `backup-${timestamp}.db`;
    const backupPath = path.join(BACKUP_DIR, backupFile);

    await fs.promises.copyFile(DB_PATH, backupPath);

    const stats = await fs.promises.stat(backupPath);
    cleanupOldBackupsAsync(30);

    res.json({
      success: true,
      message: 'Backup created successfully',
      file: backupFile,
      size: formatBytes(stats.size)
    });
  } catch (error) {
    logger.error('Backup error', { error: error.message });
    res.status(500).json({ error: 'Backup failed: ' + error.message });
  }
});

// GET /api/backup/download/:file - Download backup file
router.get('/download/:file', (req, res) => {
  const file = req.params.file;
  const filePath = path.join(BACKUP_DIR, file);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(filePath, file);
});

// POST /api/backup/restore - Restore from backup
router.post('/restore', async (req, res) => {
  const { filename } = req.body;

  if (!filename) {
    return res.status(400).json({ error: 'Filename required' });
  }

  const backupPath = path.join(BACKUP_DIR, filename);

  if (!fs.existsSync(backupPath)) {
    return res.status(404).json({ error: 'Backup file not found' });
  }

  try {
    const preRestoreBackup = `pre-restore-${Date.now()}.db`;
    await fs.promises.copyFile(DB_PATH, path.join(BACKUP_DIR, preRestoreBackup));
    await fs.promises.copyFile(backupPath, DB_PATH);

    res.json({ success: true, message: 'Database restored successfully. Please restart the server.' });
  } catch (error) {
    logger.error('Restore error', { error: error.message });
    res.status(500).json({ error: 'Restore failed: ' + error.message });
  }
});

// POST /api/backup/auto - Toggle auto backup
router.post('/auto', (req, res) => {
  const { enabled, intervalDays } = req.body;

  const configPath = path.join(__dirname, '../../backup-config.json');
  const config = {
    autoBackup: enabled !== false,
    intervalDays: intervalDays || 1
  };

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (error) {
    logger.error('Auto backup config save error', { error: error.message });
  }

  res.json({ success: true, message: `Auto backup ${enabled ? 'enabled' : 'disabled'}` });
});

// Helper: Async cleanup old backups (fire-and-forget)
async function cleanupOldBackupsAsync(keepCount) {
  try {
    const files = await fs.promises.readdir(BACKUP_DIR);
    const withStats = [];
    for (const f of files) {
      if (!f.startsWith('backup-') || !f.endsWith('.db')) continue;
      try {
        const stats = await fs.promises.stat(path.join(BACKUP_DIR, f));
        withStats.push({ name: f, time: stats.mtime.getTime(), path: path.join(BACKUP_DIR, f) });
      } catch (_) {}
    }
    withStats.sort((a, b) => b.time - a.time);
    const toDelete = withStats.slice(keepCount);
    for (const f of toDelete) {
      try {
        await fs.promises.unlink(f.path);
      } catch (_) {}
    }
  } catch (e) {
    logger.error('Cleanup error', { error: e.message });
  }
}

// Helper: Format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Auto backup scheduler (runs on server start)
function startAutoBackupScheduler() {
  const configPath = path.join(__dirname, '../../backup-config.json');
  let config = { autoBackup: true, intervalDays: 1 };

  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      logger.info('Using default backup config');
    }
  }

  if (!config.autoBackup) return;

  const now = new Date();
  const lastBackup = getLastBackupTime();

  // Run startup backup if overdue — in background
  if (lastBackup && (now - lastBackup) > (config.intervalDays * 24 * 60 * 60 * 1000)) {
    runScheduledBackup(config.intervalDays, true).catch(err => {
      logger.error('Startup scheduled backup failed', { error: err.message });
    });
  }

  // Single setInterval for future backups
  const intervalMs = config.intervalDays * 24 * 60 * 60 * 1000;
  const timer = setInterval(() => {
    runScheduledBackup(config.intervalDays, false).catch(err => {
      logger.error('Scheduled backup failed', { error: err.message });
    });
  }, intervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  process.on('exit', () => {
    clearInterval(timer);
  });
}

// Run a scheduled backup — fully async, never blocks
async function runScheduledBackup(intervalDays, isStartup) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = `backup-${timestamp}.db`;
    await fs.promises.copyFile(DB_PATH, path.join(BACKUP_DIR, backupFile));
    logger.info('Scheduled backup completed', { backupFile, isStartup });
    cleanupOldBackupsAsync(30);
  } catch (e) {
    logger.error('Scheduled backup error', { error: e.message });
  }
}

function getLastBackupTime() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup-') && f.endsWith('.db'))
      .map(f => fs.statSync(path.join(BACKUP_DIR, f)).mtime);

    if (files.length === 0) return null;
    return new Date(Math.max(...files));
  } catch (e) {
    return null;
  }
}

// Start scheduler
startAutoBackupScheduler();

module.exports = router;
