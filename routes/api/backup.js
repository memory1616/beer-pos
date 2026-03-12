const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const BACKUP_DIR = path.join(__dirname, '../backup');
const DB_PATH = path.join(__dirname, '../database.sqlite');

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// GET /api/backup - List all backups
router.get('/list', (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.db') || f.endsWith('.sqlite'))
      .map(f => {
        const stats = fs.statSync(path.join(BACKUP_DIR, f));
        return {
          name: f,
          size: formatBytes(stats.size),
          created: stats.birthtime.toISOString()
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    
    res.json({ backups: files });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to list backups' });
  }
});

// GET /api/backup/create - Create manual backup
router.get('/create', (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = `backup-${timestamp}.db`;
    const backupPath = path.join(BACKUP_DIR, backupFile);
    
    fs.copyFileSync(DB_PATH, backupPath);
    
    // Cleanup old backups (keep last 30)
    cleanupOldBackups(30);
    
    res.json({ 
      success: true, 
      message: 'Backup created successfully', 
      file: backupFile,
      size: formatBytes(fs.statSync(backupPath).size)
    });
  } catch (error) {
    console.error('Backup error:', error);
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
router.post('/restore', (req, res) => {
  const { filename } = req.body;
  
  if (!filename) {
    return res.status(400).json({ error: 'Filename required' });
  }
  
  const backupPath = path.join(BACKUP_DIR, filename);
  
  if (!fs.existsSync(backupPath)) {
    return res.status(404).json({ error: 'Backup file not found' });
  }
  
  try {
    // Create a backup of current DB before restoring
    const preRestoreBackup = `pre-restore-${Date.now()}.db`;
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, preRestoreBackup));
    
    // Copy backup file to DB
    fs.copyFileSync(backupPath, DB_PATH);
    
    res.json({ success: true, message: 'Database restored successfully. Please restart the server.' });
  } catch (error) {
    console.error('Restore error:', error);
    res.status(500).json({ error: 'Restore failed: ' + error.message });
  }
});

// POST /api/backup/auto - Toggle auto backup
router.post('/auto', (req, res) => {
  const { enabled, intervalDays } = req.body;
  
  // Store settings (in production, use a config file)
  const configPath = path.join(__dirname, '../backup-config.json');
  const config = { 
    autoBackup: enabled !== false, 
    intervalDays: intervalDays || 1 
  };
  
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  
  res.json({ success: true, message: `Auto backup ${enabled ? 'enabled' : 'disabled'}` });
});

// Helper: Cleanup old backups
function cleanupOldBackups(keepCount) {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup-') && f.endsWith('.db'))
      .map(f => ({
        name: f,
        time: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time);
    
    // Keep only the latest backups
    files.slice(keepCount).forEach(f => {
      fs.unlinkSync(path.join(BACKUP_DIR, f.name));
    });
  } catch (e) {
    console.error('Cleanup error:', e);
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
  const configPath = path.join(__dirname, '../backup-config.json');
  let config = { autoBackup: true, intervalDays: 1 };
  
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.log('Using default backup config');
    }
  }
  
  if (config.autoBackup) {
    // Run once per day (check on startup)
    const now = new Date();
    const lastBackup = getLastBackupTime();
    
    if (lastBackup && (now - lastBackup) > (config.intervalDays * 24 * 60 * 60 * 1000)) {
      console.log('Running scheduled backup...');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupFile = `backup-${timestamp}.db`;
      fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, backupFile));
      console.log('Scheduled backup completed:', backupFile);
    }
    
    // Set interval for future backups
    setInterval(() => {
      console.log('Running scheduled backup...');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupFile = `backup-${timestamp}.db`;
      fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, backupFile));
      console.log('Scheduled backup completed:', backupFile);
      cleanupOldBackups(30);
    }, config.intervalDays * 24 * 60 * 60 * 1000);
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
