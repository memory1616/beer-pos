const fs = require('fs');
const { execSync } = require('child_process');

// Generate SSH key using ssh-keygen
console.log('Generating new SSH key...');

try {
  // Delete existing key if any
  if (fs.existsSync('_new_deploy_key')) fs.unlinkSync('_new_deploy_key');
  if (fs.existsSync('_new_deploy_key.pub')) fs.unlinkSync('_new_deploy_key.pub');
  
  // Generate key
  execSync('ssh-keygen -t ed25519 -f _new_deploy_key -N "" -C "cursor-deploy"', { 
    stdio: 'inherit',
    cwd: 'd:/Beer'
  });
  
  console.log('\n=== Public Key (add to server) ===');
  console.log(fs.readFileSync('d:/Beer/_new_deploy_key.pub', 'utf8'));
  console.log('===================================\n');
  
} catch (e) {
  console.error('Error generating key:', e.message);
}
