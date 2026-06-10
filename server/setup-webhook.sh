#!/bin/bash
# setup-webhook.sh — Chạy TRÊN SERVER (Ubuntu)
# Thiết lập webhook server riêng như một fallback/manual trigger cho deploy.

set -euo pipefail

WEBHOOK_DIR="/opt/webhook"
GIT_DIR="${BEER_POS_DIR:-$HOME/beer-pos}"
DEPLOY_SCRIPT="$GIT_DIR/deploy/deploy.sh"
PORT="${WEBHOOK_PORT:-3939}"
SECRET_FILE="$WEBHOOK_DIR/.secret"

if [ ! -f "$GIT_DIR/server/webhook-deploy.js" ]; then
  echo "❌ Không tìm thấy $GIT_DIR/server/webhook-deploy.js"
  exit 1
fi

echo "=== 1. Tạo thư mục ==="
sudo mkdir -p "$WEBHOOK_DIR"
sudo chown "$USER:$USER" "$WEBHOOK_DIR"

echo "=== 2. Đồng bộ file webhook ==="
cp "$GIT_DIR/server/webhook-deploy.js" "$WEBHOOK_DIR/webhook-deploy.js"
chmod +x "$WEBHOOK_DIR/webhook-deploy.js"

echo "=== 3. Tạo secret ngẫu nhiên ==="
if [ ! -f "$SECRET_FILE" ]; then
  openssl rand -hex 32 | sudo tee "$SECRET_FILE" > /dev/null
  echo "✅ Secret: $(sudo cat "$SECRET_FILE")"
else
  echo "ℹ️  Secret cũ: $(sudo cat "$SECRET_FILE")"
fi

SECRET="$(sudo cat "$SECRET_FILE")"

echo "=== 4. Khởi động webhook server với PM2 ==="
cd "$WEBHOOK_DIR"
pm2 delete webhook-beer-pos 2>/dev/null || true
WEBHOOK_PORT="$PORT" \
WEBHOOK_SECRET="$SECRET" \
BEER_POS_DIR="$GIT_DIR" \
BEER_POS_DEPLOY_SCRIPT="$DEPLOY_SCRIPT" \
pm2 start "$WEBHOOK_DIR/webhook-deploy.js" --name webhook-beer-pos --interpreter node

echo "=== 5. Lưu PM2 startup ==="
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup

echo "=== 6. Mở port webhook ==="
sudo ufw allow "$PORT/tcp" 2>/dev/null || true

echo ""
echo "========== THÔNG TIN GITHUB WEBHOOK =========="
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || echo "103.75.183.57")
echo "🌐 Payload URL : http://$SERVER_IP:$PORT/"
echo "🔐 Secret      : $SECRET"
echo "📁 Repo dir    : $GIT_DIR"
echo "📜 Deploy script: $DEPLOY_SCRIPT"
echo ""
echo "=== Test nhanh ==="
curl "http://localhost:$PORT/"
pm2 list
