const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');

  const cmd = `
cd ~/beer-pos && \
echo "=== DB Files (including WAL) ===" && \
ls -la *.db* && \
echo "" && \
echo "=== server.js database path ===" && \
grep -i "database\\|db_path\\|filename" server.js | head -10 && \
echo "" && \
echo "=== Environment ===" && \
cat .env 2>/dev/null || echo "No .env" && \
echo "" && \
echo "=== PM2 env ===" && \
pm2 show beer-pos | grep -A5 "env" | head -15
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
