const express = require('express');
const router = express.Router();
const db = require('../database');
const path = require('path');

// GET /kegs - Serve keg management page
router.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, '../views/kegs.html'));
});

module.exports = router;
