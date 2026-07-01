// Add cache-busting query string to JS files
const http = require('http');

const options = {
  hostname: '103.75.183.57',
  port: 3000,
  path: '/js/sales.js',
  method: 'GET'
};

const req = http.request(options, (res) => {
  console.log('Status:', res.statusCode);
  console.log('ETag:', res.headers['etag']);
  console.log('Last-Modified:', res.headers['last-modified']);
  console.log('Content-Length:', res.headers['content-length']);
});
req.end();
