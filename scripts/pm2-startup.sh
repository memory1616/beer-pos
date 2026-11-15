#!/usr/bin/env bash
# Setup PM2 to start on boot
echo "=== Current systemd setup ==="
systemctl is-enabled pm2-root 2>&1 || true

echo ""
echo "=== pm2 startup command ==="
pm2 startup

echo ""
echo "=== Save current process list ==="
pm2 save --force

echo ""
echo "=== Verify ==="
ls -la /root/.pm2/dump.pm2 2>&1
echo "PM2 startup registered"