const { Client } = require('ssh2');
const fs = require('fs');

const privateKey = fs.readFileSync('D:/Beer/cursor_deploy_key', 'utf8');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');
  
  conn.exec('find /root /home /var/www /opt -maxdepth 4 -name "server.js" 2>/dev/null | head -20; echo "---"; ls /root/ 2>/dev/null', (err, stream) => {
    if (err) { console.log('Exec error:', err.message); conn.end(); return; }
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stderr.write(d));
    stream.on('close', (code) => {
      console.log('\nDone, exit code:', code);
      conn.end();
    });
  });
}).on('error', (err) => {
  console.log('SSH error:', err.message);
  console.log('Error code:', err.level);
}).connect({
  host: '103.75.183.57',
  port: 22,
  username: 'root',
  privateKey: privateKey,
  readyTimeout: 30000,
  algorithms: {
    kex: [
      'ecdh-sha2-nistp256',
      'ecdh-sha2-nistp384',
      'ecdh-sha2-nistp521',
      'diffie-hellman-group-exchange-sha256',
      'diffie-hellman-group14-sha256',
      'diffie-hellman-group14-sha1'
    ],
    cipher: [
      'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
      'aes128-cbc', 'aes192-cbc', 'aes256-cbc', 'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com'
    ],
    serverHostKey: ['ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-ed25519'],
    hmac: [
      'hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1'
    ]
  }
});
