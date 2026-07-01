const { spawn } = require('child_process');
const fs = require('fs');

const privPath = 'D:/Beer/_k_1782360718674.pem';

// SSH with the existing key
const ssh = spawn('ssh', [
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'ConnectTimeout=15',
  '-o', 'BatchMode=yes',
  '-i', privPath,
  'root@103.75.183.57',
  'echo "SSH_OK"; cd /root/beer-pos && git pull origin main && pm2 restart beer-pos && pm2 status'
], { stdio: ['ignore', 'pipe', 'pipe'] });

ssh.stdout.on('data', d => process.stdout.write(d.toString()));
ssh.stderr.on('data', d => process.stderr.write(d.toString()));
ssh.on('close', c => { console.log('\nExit:', c); process.exit(c === 0 ? 0 : 1); });
ssh.on('error', e => console.log('Spawn err:', e.message));

setTimeout(() => { console.log('\nTIMEOUT'); ssh.kill(); process.exit(1); }, 45000);
