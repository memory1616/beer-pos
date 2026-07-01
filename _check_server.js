const http = require('http');

const options = {
  hostname: '103.75.183.57',
  port: 3000,
  path: '/health',
  method: 'GET'
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Health:', data);
    
    // Now check if we can reach the actual API
    const apiReq = http.request({
      hostname: '103.75.183.57',
      port: 3000,
      path: '/api/sales?page=1&limit=1',
      method: 'GET'
    }, (apiRes) => {
      let apiData = '';
      apiRes.on('data', chunk => apiData += chunk);
      apiRes.on('end', () => {
        const sale = JSON.parse(apiData).sales[0];
        console.log('Latest sale:', {
          id: sale.id,
          deliver_kegs: sale.deliver_kegs,
          items_qty: sale.items_qty,
          reward_liters_used: sale.reward_liters_used
        });
      });
    });
    apiReq.end();
  });
});
req.end();
