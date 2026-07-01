const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');

  const cmd = `cd ~/beer-pos && node -e "
const Database = require('better-sqlite3');
console.log('better-sqlite3 version:', Database.prototype.constructor.name);
const db = new Database('database.sqlite', { readonly: true });
console.log('Journal mode:', db.pragma('journal_mode')[0].journal_mode);
console.log('User version:', db.pragma('user_version')[0].user_version);
const c = db.prepare('SELECT COUNT(*) as c FROM customers').get();
const s = db.prepare('SELECT COUNT(*) as s FROM sales').get();
console.log('Customers:', c.c, '| Sales:', s.s);
db.close();
"`;

  conn.exec(cmd, (err, stream) => {
    if (err) { console.error('Exec error:', err.message); conn.end(); return; }

    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stderr.write(d));
    stream.on('close', () => conn.end());
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
