const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');

  // Fix backup script to use database.sqlite
  const cmd = `
cd ~/beer-pos && \

# Fix backup script to use correct database name
cat > ~/beer-pos/backup.sh << 'BACKUP_SCRIPT'
#!/bin/bash
BACKUP_DIR="$HOME/beer-pos/backups"
DB_FILE="$HOME/beer-pos/database.sqlite"
DATE=$(date +%Y-%m-%d-%H%M)

# Stop PM2 briefly to ensure clean backup
pm2 stop beer-pos 2>/dev/null || true
sleep 1

if [ -f "$DB_FILE" ]; then
  cp "$DB_FILE" "$BACKUP_DIR/backup-$DATE.sqlite"
  # Keep only last 7 backups
  ls -t "$BACKUP_DIR"/backup-*.sqlite | tail -n +8 | xargs -r rm
  echo "Backup created: backup-$DATE.sqlite ($(du -h $BACKUP_DIR/backup-$DATE.sqlite | cut -f1))"
else
  echo "Database file not found: $DB_FILE"
fi

# Restart PM2
pm2 start beer-pos 2>/dev/null || pm2 restart beer-pos
BACKUP_SCRIPT

chmod +x ~/beer-pos/backup.sh && \

# Run backup now
~/beer-pos/backup.sh && \

# Create a deploy script that handles database correctly
cat > ~/beer-pos/deploy.sh << 'DEPLOY_SCRIPT'
#!/bin/bash
set -e
cd ~/beer-pos

echo "=== Pulling latest code ==="
git pull origin main

echo "=== Installing dependencies ==="
npm install --production --no-audit --no-fund

echo "=== Restarting PM2 ==="
pm2 restart beer-pos

echo "=== Waiting for server ==="
sleep 3

echo "=== Status ==="
pm2 status
curl -s http://127.0.0.1:3000/health
DEPLOY_SCRIPT

chmod +x ~/beer-pos/deploy.sh && \

# Create a restore script
cat > ~/beer-pos/restore.sh << 'RESTORE_SCRIPT'
#!/bin/bash
LATEST=$(ls -t ~/beer-pos/backups/backup-*.sqlite 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then
  echo "No backup found!"
  exit 1
fi

echo "=== Stopping server ==="
pm2 stop beer-pos

echo "=== Restoring from $LATEST ==="
cp "$LATEST" ~/beer-pos/database.sqlite

echo "=== Starting server ==="
pm2 start beer-pos

echo "=== Verifying ==="
sleep 2
curl -s http://127.0.0.1:3000/health
RESTORE_SCRIPT

chmod +x ~/beer-pos/restore.sh && \

# Show summary
echo ""
echo "=== Scripts created ==="
ls -la ~/beer-pos/*.sh && \
echo "" && \
echo "=== Latest backups ===" && \
ls -la ~/beer-pos/backups/
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
