#!/usr/bin/env bash
# Setup on SERVER: cron job that copies backup to local via reverse SSH
# Or simpler: PM2 already auto-backups. We just need to push to local.
# This script just verifies auto-backup is working.

echo "=== App's built-in backup system ==="
echo "Looking at server.js for backup cron schedule..."
grep -A 2 -E "BACKUP|backup.*cron|node-cron" /var/www/beer-pos/server.js | head -30

echo ""
echo "=== Current backups on server ==="
ls -la /var/www/beer-pos/backup/ 2>&1 | head -20
echo ""
ls -la /var/www/beer-pos/backups/ 2>&1 | head -20

echo ""
echo "=== Recent log lines about backup ==="
grep -E "BACKUP|backup" /var/www/beer-pos/logs/out.log | tail -20