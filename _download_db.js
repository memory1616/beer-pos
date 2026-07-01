const { Client } = require('ssh2');
const fs = require('fs');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

console.log('Downloading database from server...');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');

  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message);
      conn.end();
      return;
    }

    const readStream = sftp.createReadStream('/root/beer-pos/database.sqlite');
    const writeStream = fs.createWriteStream('d:/Beer/database_new.sqlite');

    readStream.on('data', d => process.stdout.write('.'));
    writeStream.on('finish', () => {
      console.log('\nDownload complete!');
      sftp.end();

      // Verify and replace
      try {
        const Database = require('./node_modules/better-sqlite3');
        const db = new Database('d:/Beer/database_new.sqlite', { readonly: true });
        const c = db.prepare('SELECT COUNT(*) as c FROM customers').get();
        const s = db.prepare('SELECT COUNT(*) as s FROM sales').get();
        console.log('Downloaded DB - Customers:', c.c, '| Sales:', s.s);
        db.close();

        // Replace old database
        fs.renameSync('d:/Beer/database.sqlite', 'd:/Beer/database.sqlite.bak');
        fs.renameSync('d:/Beer/database_new.sqlite', 'd:/Beer/database.sqlite');
        console.log('Database replaced successfully!');
      } catch (e) {
        console.error('Database error:', e.message);
      }

      conn.end();
      process.exit(0);
    });

    readStream.on('error', (err) => {
      console.error('Read error:', err.message);
      sftp.end();
      conn.end();
      process.exit(1);
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
