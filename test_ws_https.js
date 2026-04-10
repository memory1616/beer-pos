const https = require('https');
const crypto = require('crypto');

console.log('[TEST 2] HTTPS WebSocket handshake via Nginx...');
const key = crypto.randomBytes(16).toString('base64');
const req = https.request({
  hostname: 'admin.biatuoitayninh.store',
  port: 443,
  path: '/',
  method: 'GET',
  headers: {
    'Upgrade': 'websocket',
    'Connection': 'Upgrade',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Version': '13',
  }
}, (res) => {
  console.log('HTTPS WS status:', res.statusCode);
  console.log('Upgrade header:', res.headers.upgrade);
  console.log('Connection:', res.headers.connection);
  res.on('data', (d) => process.stdout.write(d));
  res.on('end', () => process.exit(0));
});
req.on('error', (e) => { console.log('ERROR:', e.message); process.exit(1); });
req.end();
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 8000);
