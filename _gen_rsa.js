const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');

crypto.generateKeyPair('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
}, (err, publicKey, privateKey) => {
  if (err) { console.log('Gen error:', err.message); return; }

  const privPath = 'D:/Beer/_server_rsa2.pem';
  const pubPath = 'D:/Beer/_server_rsa2.pub';
  try { fs.unlinkSync(privPath); } catch(e) {}
  try { fs.unlinkSync(pubPath); } catch(e) {}
  fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(pubPath, publicKey);

  // Fix permissions
  require('child_process').execSync(`icacls "D:\\Beer\\_server_rsa2.pem" /inheritance:r /grant:r "ADMIN:(R)"`, {stdio:'ignore'});

  console.log('Key generated.');
  console.log('\n=== PUBLIC KEY (paste this into server authorized_keys) ===');
  process.stdout.write(publicKey);
  console.log('\n=== END ===');

  // Try SSH
  console.log('\nTesting SSH...');
  const ssh = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    '-o', 'BatchMode=yes',
    '-i', 'D:/Beer/_server_rsa2.pem',
    'root@103.75.183.57',
    'echo "SSH_OK"; git -C /root/Beer log --oneline -3; pwd'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ssh.stdout.on('data', d => process.stdout.write(d.toString()));
  ssh.stderr.on('data', d => process.stderr.write(d.toString()));
  ssh.on('close', c => console.log('\nExit:', c));
  ssh.on('error', e => console.log('Spawn err:', e.message));

  setTimeout(() => { console.log('\nTIMEOUT'); ssh.kill(); }, 30000);
});