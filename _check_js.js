const http = require('http');

const options = {
  hostname: '103.75.183.57',
  port: 3000,
  path: '/js/sales.js',
  method: 'GET'
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    // Search for the bonus check
    const lines = data.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('MONTHLY_BONUS') && lines[i].includes('reward_liters_used')) {
        console.log('Found at line', i + 1);
        console.log(lines.slice(i, i + 5).join('\n'));
        break;
      }
    }
  });
});
req.end();
