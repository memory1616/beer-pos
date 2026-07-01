const fs = require('fs');
const { spawn } = require('child_process');

// Check what keys exist
const files = ['_server_rsa.pem', '_server_rsa.pub', '_server_rsa2.pem', '_server_rsa2.pub', '_k_1782360718674.pem', '_k_1782360718674.pub'];
for (const f of files) {
  const path = `D:/Beer/${f}`;
  try {
    const stat = fs.statSync(path);
    console.log(`EXISTS: ${f} (${stat.size} bytes)`);
  } catch(e) {
    console.log(`MISSING: ${f}`);
  }
}

// Try to use the key that exists
const keyPath = 'D:/Beer/_k_1782360718674.pem';
const keyExists = fs.existsSync(keyPath);
console.log('\nKey path:', keyPath, 'exists:', keyExists);

if (keyExists) {
  // Get public key fingerprint to match with server
  const out = spawn('ssh-keygen', ['-y', '-f', keyPath]);
  let pub = '';
  out.stdout.on('data', d => pub += d.toString());
  out.stderr.on('data', d => process.stderr.write(d.toString()));
  out.on('close', () => {
    console.log('\nPublic key for this private key:');
    console.log(pub.trim());
    console.log('\nCompare with what you added to server.');
  });
}
