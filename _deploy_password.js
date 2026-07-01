const { Client } = require('ssh2');
const readline = require('readline');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

console.log(`Connecting to ${USER}@${SERVER}...`);

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');

  // Deploy commands
  const cmd = `
    cd ~/beer-pos 2>/dev/null || (mkdir -p ~/beer-pos && cd ~/beer-pos && git init && git remote add origin git@github.com:memory1616/beer-pos.git)
    cd ~/beer-pos
    git fetch origin
    git reset --hard origin/main
    echo "=== Deployed commit ==="
    git log --oneline -3
    echo ""
    pm2 restart beer-pos
    sleep 3
    echo "=== PM2 Status ==="
    pm2 status
    echo ""
    echo "=== Health Check ==="
    curl -s http://127.0.0.1:3000/health
  `;

  conn.exec(cmd, (err, stream) => {
    if (err) { console.error('Exec error:', err.message); conn.end(); return; }

    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stderr.write(d));
    stream.on('close', (code) => {
      console.log('\nDeploy finished! Exit code:', code);
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
