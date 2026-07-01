const { Client } = require('ssh2');
const fs = require('fs');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';
const LOCAL_DB = 'd:/Beer/backups/db_2026-06-24.sqlite';

console.log(`Checking file size...`);
const stats = fs.statSync(LOCAL_DB);
console.log(`File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

if (stats.size > 5 * 1024 * 1024) {
  console.error('File too large for this method. Will try chunked upload...');
}

// Upload using SFTP
const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected! Starting SFTP upload...');

  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message);
      conn.end();
      return;
    }

    const readStream = fs.createReadStream(LOCAL_DB);
    const writeStream = sftp.createWriteStream('/root/beer-pos/beer.db');

    writeStream.on('close', () => {
      console.log('Upload complete!');
      sftp.end();

      // Restart PM2
      conn.exec('cd ~/beer-pos && ls -la beer.db && pm2 restart beer-pos && sleep 3 && pm2 status && curl -s http://127.0.0.1:3000/health', (err2, stream2) => {
        if (err2) { console.error('Exec error:', err2.message); conn.end(); return; }
        stream2.on('data', d => process.stdout.write(d));
        stream2.stderr.on('data', d => process.stderr.write(d));
        stream2.on('close', () => {
          conn.end();
          process.exit(0);
        });
      });
    });

    writeStream.on('error', (err) => {
      console.error('Write error:', err.message);
      sftp.end();
      conn.end();
      process.exit(1);
    });

    readStream.pipe(writeStream);
  });
}).on('error', (err) => {
  console.error('SSH error:', err.message);
  process.exit(1);
}).connect({
  host: SERVER,
  port: 22,
  username: USER,
  password: PASS,
  readyTimeout: 30000
});
