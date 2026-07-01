const { Client } = require('ssh2');
const fs = require('fs');
const { createHash, randomBytes } = require('crypto');

const privateKey = fs.readFileSync('D:/Beer/cursor_deploy_key', 'utf8');
const publicKey = fs.readFileSync('D:/Beer/cursor_deploy_key.pub', 'utf8').trim();

console.log('Public key:', publicKey);
console.log('Private key starts with:', privateKey.substring(0, 50));

const conn = new Client();

conn.on('ready', () => {
  console.log('\nSSH Connected!');
  conn.exec('echo "Deploy success!" && git -C ~/beer-pos log --oneline -3', (err, stream) => {
    if (err) { console.log('Exec error:', err.message); conn.end(); return; }
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stderr.write(d));
    stream.on('close', (code) => {
      console.log('\nExit code:', code);
      
      // Pull and restart
      if (code === 0) {
        conn.exec('cd ~/beer-pos && git pull && pm2 restart beer-pos && sleep 2 && pm2 status', (err2, s2) => {
          s2.on('data', d => process.stdout.write(d));
          s2.stderr.on('data', d => process.stderr.write(d));
          s2.on('close', (c2) => {
            console.log('\nDeploy done! Exit:', c2);
            conn.end();
          });
        });
      } else {
        conn.end();
      }
    });
  });
}).on('error', (err) => {
  console.log('\nSSH error:', err.message);
}).connect({
  host: '103.75.183.57',
  port: 22,
  username: 'root',
  privateKey: privateKey,
  readyTimeout: 30000
});
