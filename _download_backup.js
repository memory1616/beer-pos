const { Client } = require('ssh2');
const fs = require('fs');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

console.log('Downloading from backup folder...');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');

  // First check the backup file
  conn.exec('ls -la ~/beer-pos/backups/', (err, stream) => {
    if (err) { console.error('Exec error:', err.message); conn.end(); return; }

    let output = '';
    stream.on('data', d => output += d);
    stream.on('close', () => {
      console.log(output);

      // Download from backup folder instead
      conn.sftp((err, sftp) => {
        if (err) {
          console.error('SFTP error:', err.message);
          conn.end();
          return;
        }

        // Try downloading from backup folder
        const readStream = sftp.createReadStream('/root/beer-pos/backups/db_2026-06-24.sqlite');
        const writeStream = fs.createWriteStream('d:/Beer/database_server.sqlite');

        readStream.on('data', d => process.stdout.write('.'));
        writeStream.on('finish', () => {
          console.log('\nDownload complete!');
          sftp.end();

          // Verify
          try {
            const Database = require('./node_modules/better-sqlite3');
            const db = new Database('d:/Beer/database_server.sqlite', { readonly: true });
            const c = db.prepare('SELECT COUNT(*) as c FROM customers').get();
            const s = db.prepare('SELECT COUNT(*) as s FROM sales').get();
            console.log('Backup DB - Customers:', c.c, '| Sales:', s.s);
            db.close();
          } catch (e) {
            console.error('Database error:', e.message);
          }

          conn.end();
          process.exit(0);
        });

        readStream.pipe(writeStream);
      });
    });
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
