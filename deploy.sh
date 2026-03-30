#!/bin/bash

# Beer POS - Deploy Script
# Chạy trên server sau khi pull code mới

echo "===== Beer POS Deploy ====="

# Pull code mới nhất
echo "[1/3] Pulling from git..."
git pull origin main

# Cài đặt dependencies nếu cần
echo "[2/3] Installing dependencies..."
npm install

# Restart PM2
echo "[3/3] Restarting PM2..."
pm2 restart beer-pos

echo "===== Deploy Complete ====="
pm2 status beer-pos
