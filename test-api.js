const http = require('http');

const postData = JSON.stringify({
  category: 'Hư hỏng',
  amount: 40000,
  date: '2026-03-18',
  description: 'Test API'
});

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/expenses',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response:', body);
  });
});

req.on('error', (e) => {
  console.error('Error:', e.message);
});

req.write(postData);
req.end();
