const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');

  const cmd = `
cd ~/beer-pos && \
echo "=== Current DB files ===" && \
ls -la *.sqlite* *.db* 2>/dev/null && \
echo "" && \
echo "=== Renaming beer.db to database.sqlite ===" && \
mv beer.db database.sqlite && \
rm -f beer.db-shm beer.db-wal 2>/dev/null || true && \
echo "" && \
echo "=== New DB files ===" && \
ls -la *.sqlite* && \
echo "" && \
echo "=== Verify database ===" && \
node -e "
const Database = require('better-sqlite3');
const db = new Database('database.sqlite', { readonly: true });
const customers = db.prepare('SELECT COUNT(*) as c FROM customers').get();
const sales = db.prepare('SELECT COUNT(*) as s FROM sales').get();
console.log('Customers:', customers.c);
console.log('Sales:', sales.s);
db.close();
" && \
echo "" && \
echo "=== Restarting PM2 ===" && \
pm2 restart beer-pos && \
sleep 3 && \
pm2 status && \
echo "" && \
echo "=== Health Check ===" && \
curl -s http://127.0.0.1:3000/health
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
