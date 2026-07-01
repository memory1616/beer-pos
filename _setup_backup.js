const { Client } = require('ssh2');

const SERVER = '103.75.183.57';
const USER = 'root';
const PASS = 'Zxcv@1234';

console.log(`Connecting to ${USER}@${SERVER}...`);

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');

  // Configure backup script
  const cmd = `
    cd ~/beer-pos && \

    # Create backup directory
    mkdir -p ~/beer-pos/backups && \

    # Create backup script
    cat > ~/beer-pos/backup.sh << 'BACKUP_SCRIPT'
#!/bin/bash
BACKUP_DIR="$HOME/beer-pos/backups"
DB_FILE="$HOME/beer-pos/beer.db"
DATE=$(date +%Y-%m-%d-%H%M)

if [ -f "$DB_FILE" ]; then
  cp "$DB_FILE" "$BACKUP_DIR/backup-$DATE.db"
  # Keep only last 7 backups
  ls -t "$BACKUP_DIR"/backup-*.db | tail -n +8 | xargs -r rm
  echo "Backup created: backup-$DATE.db"
else
  echo "Database file not found!"
fi
BACKUP_SCRIPT

    chmod +x ~/beer-pos/backup.sh && \

    # Run initial backup
    ~/beer-pos/backup.sh && \

    # Setup cron job (daily at 11pm)
    (crontab -l 2>/dev/null | grep -v "backup.sh"; echo "0 23 * * * $HOME/beer-pos/backup.sh >> $HOME/beer-pos/backups/cron.log 2>&1") | crontab - && \

    # Show cron jobs
    echo ""
    echo "=== Cron jobs ==="
    crontab -l && \

    # Show backups
    echo ""
    echo "=== Backups ==="
    ls -la ~/beer-pos/backups/
  `;

  conn.exec(cmd, (err, stream) => {
    if (err) { console.error('Exec error:', err.message); conn.end(); return; }

    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stderr.write(d));
    stream.on('close', (code) => {
      console.log('\nBackup configured! Exit code:', code);
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
