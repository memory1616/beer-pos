/**
 * Preview server cho landing page (chỉ dùng dev).
 * Serve public/ tĩnh + / trả về public/landing.html — bypass admin redirect.
 * Chạy: node scripts/ops/preview-landing.js [port]
 */
const express = require('express');
const path = require('path');

const PORT = parseInt(process.argv[2] || '3998', 10);
const app = express();

app.get('/', (req, res) => {
  res.type('text/html').sendFile(path.join(__dirname, '..', '..', 'public', 'landing.html'));
});

app.use(express.static(path.join(__dirname, '..', '..', 'public')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Landing preview: http://127.0.0.1:${PORT}/`);
});
