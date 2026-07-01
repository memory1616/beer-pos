const { Client } = require('ssh2');
const fs = require('fs');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';
const LOCAL_DB = 'd:/Beer/backups/db_2026-06-24.sqlite';

console.log(`Uploading database to ${USER}@${SERVER}...`);

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');

  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message);
      conn.end();
      return;
    }

    // Remove old database files first
    conn.exec('cd ~/beer-pos && rm -f database.sqlite database.sqlite-shm database.sqlite-wal', (err2, stream2) => {
      stream2.on('data', d => process.stdout.write(d));
      stream2.on('close', () => {
        console.log('Removed old database. Uploading new one...');

        const readStream = fs.createReadStream(LOCAL_DB);
        const writeStream = sftp.createWriteStream('/root/beer-pos/database.sqlite');

        writeStream.on('close', () => {
          console.log('Upload complete!');
          sftp.end();

          // Restart PM2
          conn.exec(`cd ~/beer-pos && ls -la database.sqlite && node -e "
const Database = require('better-sqlite3');
const db = new Database('database.sqlite', { readonly: true });
const c = db.prepare('SELECT COUNT(*) as c FROM customers').get();
const s = db.prepare('SELECT COUNT(*) as s FROM sales').get();
console.log('Customers:', c.c);
console.log('Sales:', s.s);
db.close();
" && pm2 restart beer-pos && sleep 3 && curl -s http://127.0.0.1:3000/health`, (err3, stream3) => {
            stream3.on('data', d => process.stdout.write(d));
            stream3.stderr.on('data', d => process.stderr.write(d));
            stream3.on('close', () => {
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
