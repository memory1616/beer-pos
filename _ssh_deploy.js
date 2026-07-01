const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');

crypto.generateKeyPair('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
}, (err, publicKey, privateKey) => {
  if (err) { console.log('Gen error:', err.message); return; }

  const ts = Date.now();
  const privPath = `D:/Beer/_k_${ts}.pem`;
  const pubPath = `D:/Beer/_k_${ts}.pub`;
  fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(pubPath, publicKey);

  // Fix permissions
  try {
    require('child_process').execSync(`icacls "${privPath}" /inheritance:r /grant:r "ADMIN:(R)"`, {stdio:'ignore'});
  } catch(e) {}

  console.log('Key generated at:', privPath);

  // SSH and git pull
  const ssh = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    '-o', 'BatchMode=yes',
    '-i', privPath,
    'root@103.75.183.57',
    'echo "SSH_OK"; cd /root/Beer && git pull origin main && pm2 restart beer-pos && pm2 status'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ssh.stdout.on('data', d => process.stdout.write(d.toString()));
  ssh.stderr.on('data', d => process.stderr.write(d.toString()));
  ssh.on('close', c => {
    console.log('\nExit:', c);
    // Cleanup temp key
    try { fs.unlinkSync(privPath); } catch(e){}
    try { fs.unlinkSync(pubPath); } catch(e){}
    process.exit(c === 0 ? 0 : 1);
  });
  ssh.on('error', e => console.log('Spawn err:', e.message));

  setTimeout(() => { console.log('\nTIMEOUT'); ssh.kill(); process.exit(1); }, 45000);
});
