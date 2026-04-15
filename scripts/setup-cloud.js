// BeerPOS - Auto Setup Cloud URL
// Chạy script này để auto-configure cloud server URL

const CLOUD_SERVER_URL = 'http://103.75.183.57:3000';

console.log('=== BeerPOS Cloud Setup ===');
console.log('Cloud Server:', CLOUD_SERVER_URL);
console.log('');
console.log('Để apply cấu hình này:');
console.log('');
console.log('1. Mở trình duyệt và truy cập: http://localhost:3000');
console.log('2. Mở Developer Console (F12)');
console.log('3. Chạy lệnh sau:');
console.log('');
console.log(`   localStorage.setItem('cloudUrl', '${CLOUD_SERVER_URL}');`);
console.log('   location.reload();');
console.log('');
console.log('Hoặc truy cập: http://103.75.183.57:3000 trực tiếp thay vì localhost');
console.log('');

// Check if we're in browser context
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  const currentUrl = localStorage.getItem('cloudUrl');
  console.log('Current cloudUrl:', currentUrl || '(chưa set)');

  if (currentUrl !== CLOUD_SERVER_URL) {
    console.log('Setting new cloudUrl...');
    localStorage.setItem('cloudUrl', CLOUD_SERVER_URL);
    console.log('✓ Cloud URL đã được set!');
  } else {
    console.log('✓ Cloud URL đã đúng!');
  }
}

module.exports = { CLOUD_SERVER_URL };