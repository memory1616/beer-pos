const { Client } = require('ssh2');
const fs = require('fs');

// Read key and normalize line endings (fix Windows CRLF -> LF)
let privateKey = fs.readFileSync('D:/Beer/cursor_deploy_key', 'utf8');
privateKey = privateKey.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

console.log('Key starts:', privateKey.substring(0, 60));
console.log('Key ends:', privateKey.substring(privateKey.length - 60));

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');
  conn.exec('find /root /home /var/www /opt -maxdepth 4 -name "server.js" 2>/dev/null | head -20; echo "---LS---"; ls /root/ 2>/dev/null; echo "---GIT---"; ls /root/Beer 2>/dev/null', (err, stream) => {
    if (err) { console.log('Exec error:', err.message); conn.end(); return; }
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stderr.write(d));
    stream.on('close', (code) => {
      console.log('\nDone, exit:', code);
      conn.end();
    });
  });
}).on('error', (err) => {
  console.log('SSH error:', err.message, '| level:', err.level);
}).connect({
  host: '103.75.183.57',
  port: 22,
  username: 'root',
  privateKey: privateKey,
  readyTimeout: 30000
});
