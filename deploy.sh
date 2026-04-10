#!/bin/bash

# Beer POS - Deploy Script
# Chạy trên server sau khi pull code mới

set -e

echo "===== Beer POS Deploy ====="

# Pull code mới nhất
echo "[1/3] Pulling from git..."
git pull origin main

# Cài đặt dependencies nếu cần
echo "[2/3] Installing dependencies..."
npm install

# Restart PM2 — dùng startOrRestart để handle cả 2 trường hợp:
# - process đang chạy → restart
# - process chưa tồn tại → start từ ecosystem
echo "[3/3] Restarting PM2..."
pm2 startOrRestart ecosystem.config.js 2>/dev/null || pm2 restart beer-pos 2>/dev/null || pm2 start npm --name "beer-pos" -- start

echo "===== Deploy Complete ====="
pm2 list
