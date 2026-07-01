const net = require('net');

function connectSSH(port, host, command) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    client.connect(port, host, () => {
      client.write(`exit\n`);
      resolve('connected');
    });
    client.on('error', reject);
    client.setTimeout(5000, () => {
      client.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// Try to restart pm2 via a simple HTTP request if there's an admin endpoint
const http = require('http');

const options = {
  hostname: '103.75.183.57',
  port: 3000,
  path: '/api/admin/restart',
  method: 'POST'
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('Restart response:', data));
});
req.on('error', (e) => console.log('Error:', e.message));
req.end();
