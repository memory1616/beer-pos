const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');

  // Create a check script on server
  const checkScript = `
const Database = require('better-sqlite3');
const db = new Database('beer.db', { readonly: true });

console.log('=== Database Info ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

console.log('\\n=== Record counts ===');
tables.forEach(t => {
  try {
    const c = db.prepare('SELECT COUNT(*) as c FROM ' + t.name).get();
    console.log(t.name + ': ' + c.c);
  } catch(e) {}
});

db.close();
`;

  const cmd = `
cd ~/beer-pos && cat > check_db.js << 'SCRIPTEOF'
${checkScript}
SCRIPTEOF
node check_db.js
`;

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
