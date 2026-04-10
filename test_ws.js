const WebSocket = require('/root/beer-pos/node_modules/ws');

console.log('[TEST 1] Direct connect to port 3001...');
const ws = new WebSocket('http://127.0.0.1:3001');
ws.on('open', () => { console.log('DIRECT OK'); ws.close(); process.exit(0); });
ws.on('error', (e) => { console.log('DIRECT ERROR:', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 5000);
