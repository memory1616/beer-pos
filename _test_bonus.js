// Test script to check if bonus info is shown correctly
const http = require('http');

// Fetch sale 545
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
    
    console.log('Sale data:');
    console.log('  promo_type:', sale.promo_type);
    console.log('  reward_liters_used:', sale.reward_liters_used);
    
    // Simulate the check in buildVolumePromoNote
    const invoice = sale; // API returns sale as invoice object
    if (invoice.promo_type === 'MONTHLY_BONUS' || invoice.reward_liters_used > 0) {
      const rewardLiters = invoice.reward_liters_used || (invoice.promo_free_liters || 0);
      console.log('\n✅ BONUS CHECK PASSED: rewardLiters =', rewardLiters);
      console.log('   Expected output: "Đơn trả thưởng +' + rewardLiters + 'L"');
    } else {
      console.log('\n❌ BONUS CHECK FAILED - will show progress instead');
    }
  });
});
req.end();
