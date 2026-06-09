#!/bin/bash
set -e

echo "=== Pulling latest code ==="
cd ~/beer-pos
git pull

echo "=== Installing dependencies ==="
npm install --production

echo "=== Restarting PM2 ==="
pm2 restart beer-pos

echo "=== Deploy complete ==="
