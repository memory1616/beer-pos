const https = require('https');
const net = require('net');
const crypto = require('crypto');

console.log('[TEST 3] Direct TCP to port 3001 via Nginx proxy IP...');
// Test: connect directly to 127.0.0.1:3001 using proper WS handshake
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
  console.log('Status:', res.statusCode, res.headers.upgrade, res.headers.connection);
  let data = '';
  res.on('data', (d) => { data += d.toString(); process.stdout.write(d); });
  res.on('end', () => {
    console.log('\nData received:', data.substring(0, 100));
    process.exit(0);
  });
});
req.on('error', (e) => { console.log('ERROR:', e.message); process.exit(1); });
req.end();
setTimeout(() => { console.log('TIMEOUT after 5s'); process.exit(1); }, 5000);
