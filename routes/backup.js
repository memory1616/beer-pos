const express = require('express');
const router = express.Router();
const path = require('path');

// GET /backup - Serve HTML file
router.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, '../views/backup.html'));
});

module.exports = router;
