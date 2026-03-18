const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/data',
  method: 'GET',
  headers: {
    'Accept': 'application/json'
  }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Content-Type:', res.headers['content-type']);
    try {
      const data = JSON.parse(body);
      console.log('expenses:', JSON.stringify(data.expenses, null, 2));
    } catch(e) {
      console.log('Response (first 1000 chars):', body.substring(0, 1000));
    }
  });
});

req.on('error', (e) => console.error('Error:', e.message));
req.end();
