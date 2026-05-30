// Minimal debug
const express = require('express');
const router = express.Router();

router.put('/:id', (req, res) => {
  res.send('OK from test route');
});

module.exports = router;
