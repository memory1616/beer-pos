const http = require('http');

const data = JSON.stringify({
  category: 'Xang dau',
  amount: 1200000,
  date: '2026-03-18',
  description: 'Test'
});

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/expenses',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response:', body);
  });
});

req.on('error', (e) => console.error('Error:', e.message));
req.write(data);
req.end();
