// Find what API endpoint is used to load invoice for the modal
const http = require('http');

const req = http.request({
  hostname: '103.75.183.57',
  port: 3000,
  path: '/api/sales/545',
  method: 'GET'
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const sale = JSON.parse(data);
    console.log('Fields returned by API:');
    console.log(Object.keys(sale).sort());
    console.log('\nKey fields:');
    console.log('  id:', sale.id);
    console.log('  promo_type:', sale.promo_type);
    console.log('  reward_liters_used:', sale.reward_liters_used);
    console.log('  promo_free_liters:', sale.promo_free_liters);
  });
});
req.end();