const { Client } = require('ssh2');
const fs = require('fs');

const privateKey = fs.readFileSync('D:/Beer/cursor_deploy_key', 'utf8');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');
  
  // Find the project directory first
  conn.exec('find /root /home /var/www /opt -maxdepth 3 -name "package.json" -path "*/Beer*" -o -name "server.js" -path "*/Beer*" 2>/dev/null | head -20', (err, stream) => {
    if (err) { console.log('Find error:', err.message); conn.end(); return; }
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stderr.write(d));
    stream.on('close', (code) => {
      console.log('\nFind done, code:', code);
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
  readyTimeout: 30000
});
