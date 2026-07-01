const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

console.log(`Connecting to ${USER}@${SERVER}...`);

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');

  // Clone with HTTPS and restart
  const cmd = `
    cd ~ && \
    mv beer-pos beer-pos_old 2>/dev/null || true && \
    git clone https://github.com/memory1616/beer-pos.git beer-pos_new && \
    mv beer-pos_old/beer.db beer-pos_new/ 2>/dev/null || true && \
    rm -rf beer-pos_old && \
    mv beer-pos_new beer-pos && \
    cd beer-pos && \
    git log --oneline -3 && \
    npm install --production --no-audit --no-fund 2>/dev/null || true && \
    pm2 restart beer-pos && \
    sleep 3 && \
    pm2 status && \
    curl -s http://127.0.0.1:3000/health
  `;

  conn.exec(cmd, (err, stream) => {
    if (err) { console.error('Exec error:', err.message); conn.end(); return; }

    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stderr.write(d));
    stream.on('close', (code) => {
      console.log('\nDone! Exit code:', code);
      conn.end();
      process.exit(code === 0 ? 0 : 1);
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
