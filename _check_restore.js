const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

console.log(`Connecting to ${USER}@${SERVER}...`);

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');

  const cmd = `
    cd ~/beer-pos && \

    # Check current database
    echo "=== Current database info ==="
    ls -la beer.db
    sqlite3 beer.db "SELECT COUNT(*) as customers FROM customers; SELECT COUNT(*) as products FROM products; SELECT COUNT(*) as sales FROM sales;" 2>/dev/null || echo "sqlite3 not found or db error"

    echo ""
    echo "=== Backups available ==="
    ls -la backups/

    echo ""
    echo "=== Latest backup ==="
    LATEST=$(ls -t backups/backup-*.db 2>/dev/null | head -1)
    if [ -n "$LATEST" ]; then
      echo "Latest backup: $LATEST"
      ls -la "$LATEST"
      echo ""
      echo "Backup content:"
      sqlite3 "$LATEST" "SELECT COUNT(*) as customers FROM customers; SELECT COUNT(*) as products FROM products; SELECT COUNT(*) as sales FROM sales;" 2>/dev/null || echo "Cannot read backup"
    fi

    echo ""
    echo "=== If data is wrong, restoring from backup ==="
    LATEST=$(ls -t backups/backup-*.db 2>/dev/null | head -1)
    if [ -n "$LATEST" ] && [ -s "$LATEST" ]; then
      echo "Restoring $LATEST to beer.db..."
      cp "$LATEST" beer.db
      ls -la beer.db
      echo ""
      echo "After restore:"
      sqlite3 beer.db "SELECT COUNT(*) as customers FROM customers; SELECT COUNT(*) as products FROM products; SELECT COUNT(*) as sales FROM sales;" 2>/dev/null || echo "Cannot read"
    else
      echo "No valid backup found or backup is empty"
    fi

    echo ""
    echo "=== Restart PM2 ==="
    pm2 restart beer-pos
    sleep 2
    pm2 status
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
