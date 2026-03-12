const express = require('express');
const router = express.Router();
const path = require('path');

// GET /backup - Serve HTML file
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../views/backup.html'));
});

module.exports = router;
