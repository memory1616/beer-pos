const { spawn } = require('child_process');

// Use Windows OpenSSH which supports ED25519 keys
const ssh = spawn('ssh', [
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'ConnectTimeout=15',
  '-i', 'D:/Beer/cursor_deploy_key',
  'root@103.75.183.57',
  'cd /root/Beer && git pull origin main && pm2 restart beer-pos 2>&1'
], {
  stdio: ['ignore', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';

ssh.stdout.on('data', (data) => {
  const text = data.toString();
  stdout += text;
  process.stdout.write(text);
});

ssh.stderr.on('data', (data) => {
  const text = data.toString();
  stderr += text;
  process.stderr.write(text);
});

ssh.on('close', (code) => {
  console.log('\n=== EXIT CODE:', code, '===');
  process.exit(code || 0);
});

ssh.on('error', (err) => {
  console.log('Spawn error:', err.message);
  process.exit(1);
});

// Timeout after 60s
setTimeout(() => {
  console.log('\nTimeout! Killing process...');
  ssh.kill();
  process.exit(1);
}, 60000);
