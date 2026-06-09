#!/bin/bash
set -e

echo "=== Pulling latest code ==="
cd ~/beer-pos
git pull

echo "=== Installing dependencies ==="
npm install --production

echo "=== Rebuilding native modules (better-sqlite3) ==="
npm rebuild better-sqlite3

echo "=== Restarting PM2 ==="
pm2 restart beer-pos

echo "=== Deploy complete ==="
