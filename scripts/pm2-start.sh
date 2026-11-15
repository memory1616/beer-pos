#!/usr/bin/env bash
set -e
cd /var/www/beer-pos

echo "=== Stopping old processes ==="
pm2 delete all 2>&1 | tail -3 || true

echo "=== Starting with ecosystem config ==="
# Set NODE_ENV for production
export NODE_ENV=production

# Start with ecosystem config (env: production)
pm2 start ecosystem.config.js --env production 2>&1 | tail -10
pm2 save 2>&1 | tail -3

echo "=== Setting up PM2 startup ==="
STARTUP_CMD=$(pm2 startup | tail -1)
echo "Run this: $STARTUP_CMD"
# Auto-execute the startup command if it's a simple systemd setup
if [[ "$STARTUP_CMD" == *sudo* ]]; then
    echo "(Skipping auto-startup due to sudo requirement)"
else
    eval "$STARTUP_CMD" 2>&1 || echo "(Startup setup may need manual step)"
fi

echo "=== PM2 Status ==="
pm2 status
pm2 list

echo "=== Checking if server is listening ==="
sleep 3
ss -tlnp | grep 3000 || echo "Port 3000 not yet listening, will check logs"
tail -20 logs/out.log 2>&1 || true