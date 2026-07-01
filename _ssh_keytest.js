const { Client } = require('ssh2');
const fs = require('fs');

// Read key - try both encodings
let raw = fs.readFileSync('D:/Beer/cursor_deploy_key');
console.log('File size:', raw.length);
console.log('First 20 bytes hex:', raw.slice(0,20).toString('hex'));
console.log('Last 20 bytes hex:', raw.slice(-20).toString('hex'));

// Try as string
let str = raw.toString('utf8');
console.log('String starts:', str.substring(0, 60));
console.log('String ends:', str.substring(str.length - 60));
console.log('Contains BEGIN:', str.includes('BEGIN'));
console.log('Line count:', str.split('\n').length);

const conn = new Client();

conn.on('ready', () => {
  console.log('\n=== SSH Connected! ===');
  conn.exec('ls /root/Beer/ 2>/dev/null | head -5; git -C /root/Beer log --oneline -3 2>/dev/null', (err, stream) => {
    if (err) { console.log('Exec error:', err.message); conn.end(); return; }
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stderr.write(d));
    stream.on('close', (code) => {
      console.log('\nExit:', code);
      conn.end();
    });
  });
}).on('error', (err) => {
  console.log('SSH error:', err.message, '| level:', err.level, '| code:', err.code);
}).connect({
  host: '103.75.183.57',
  port: 22,
  username: 'root',
  privateKey: str,
  readyTimeout: 20000,
  debug: console.log
});
