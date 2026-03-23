/**
 * Beer POS - Session API Routes
 * @module routes/api/session
 */

const express = require('express');
const router = express.Router();
const session = require('../../src/services/session');
const logger = require('../../src/utils/logger');

/**
 * GET /api/session/today - Get today's session
 */
router.get('/today', (req, res) => {
  try {
    const todaySession = session.getTodaySession();
    const stats = session.getSessionStats();
    
    res.json({
      session: todaySession,
      stats: stats
    });
  } catch (err) {
    logger.error('Error getting today session', { error: err.message });
    res.status(500).json({ error: 'Failed to get session' });
  }
});

/**
 * GET /api/session/:date - Get session by date
 */
router.get('/:date', (req, res) => {
  try {
    const { date } = req.params;
    const sessionData = session.getSessionByDate(date);
    
    if (!sessionData) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    res.json(sessionData);
  } catch (err) {
    logger.error('Error getting session', { error: err.message });
    res.status(500).json({ error: 'Failed to get session' });
  }
});

/**
 * GET /api/session/stats/:date - Get session stats by date
 */
router.get('/stats/:date', (req, res) => {
  try {
    const { date } = req.params;
    const stats = session.getSessionStats(date);
    
    res.json(stats);
  } catch (err) {
    logger.error('Error getting session stats', { error: err.message });
    res.status(500).json({ error: 'Failed to get session stats' });
  }
});

/**
 * POST /api/session/migrate - Migrate old data to session format
 */
router.post('/migrate', (req, res) => {
  try {
    // First create the sessions table if needed
    session.migrateToSessionFormat();
    
    // Then migrate old data
    const result = session.migrateOldData();
    
    res.json({
      success: true,
      message: `Migrated ${result.migrated || 0} sessions`,
      ...result
    });
  } catch (err) {
    logger.error('Error migrating session', { error: err.message });
    res.status(500).json({ error: 'Failed to migrate session' });
  }
});

/**
 * GET /api/session/check-migration - Check if old data needs migration
 */
router.get('/check-migration', (req, res) => {
  try {
    const migrationStatus = session.checkOldDataMigration();
    res.json(migrationStatus);
  } catch (err) {
    logger.error('Error checking migration status', { error: err.message });
    res.status(500).json({ error: 'Failed to check migration status' });
  }
});

module.exports = router;
