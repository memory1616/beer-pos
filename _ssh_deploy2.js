const { Client } = require('ssh2');
const fs = require('fs');
const { execSync } = require('child_process');
const crypto = require('crypto');

// Generate a new RSA key pair for server access
console.log('Generating RSA key pair...');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
});

console.log('Private key generated.');
console.log('Public key:');
console.log(publicKey);
console.log('\n--- INSTRUCTIONS ---');
console.log('1. Add the above public key to /root/.ssh/authorized_keys on 103.75.183.57');
console.log('2. Then re-run this script');
console.log('\nPrivate key saved to d:/Beer/_server_key.pem');

// Save private key
fs.writeFileSync('D:/Beer/_server_key.pem', privateKey, { mode: 0o600 });

// Test connection with the new key
console.log('\n--- TESTING CONNECTION ---');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');
  conn.exec('git -C /root/Beer pull origin main && pm2 restart beer-pos', (err, stream) => {
    if (err) { console.log('Exec error:', err.message); conn.end(); return; }
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stderr.write(d));
    stream.on('close', (code) => {
      console.log('\nDone! Exit:', code);
      conn.end();
    });
  });
}).on('error', (err) => {
  console.log('SSH error:', err.message);
}).connect({
  host: '103.75.183.57',
  port: 22,
  username: 'root',
  privateKey: privateKey,
  readyTimeout: 20000
});
