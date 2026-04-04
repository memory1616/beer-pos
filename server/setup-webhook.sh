#!/bin/bash
# setup-webhook.sh — Chạy TRÊN SERVER (Ubuntu)
# Giả sử deploy.sh đã có sẵn tại /root/beer-pos/deploy.sh

set -e

WEBHOOK_DIR="/opt/webhook"
GIT_DIR="/root/beer-pos"
DEPLOY_SCRIPT="/root/beer-pos/deploy.sh"
PORT=3939
SECRET_FILE="$WEBHOOK_DIR/.secret"

echo "=== 1. Tạo thư mục ==="
sudo mkdir -p "$WEBHOOK_DIR"
sudo chown $USER:$USER "$WEBHOOK_DIR"

echo "=== 2. Copy webhook-deploy.js lên server ==="
# Từ local: scp webhook-deploy.js root@103.75.183.57:$WEBHOOK_DIR/
# Hoặc copy trực tiếp nếu đã SSH vào máy này
echo "📋 Chạy từ local: scp webhook-deploy.js root@103.75.183.57:$WEBHOOK_DIR/"
echo "   Sau đó tiếp tục bước 3."

echo "=== 3. Tạo secret ngẫu nhiên ==="
if [ ! -f "$SECRET_FILE" ]; then
  openssl rand -hex 32 | sudo tee "$SECRET_FILE" > /dev/null
  echo "✅ Secret: $(sudo cat $SECRET_FILE)"
else
  echo "ℹ️  Secret cũ: $(sudo cat $SECRET_FILE)"
fi

SECRET=$(sudo cat "$SECRET_FILE")

echo "=== 4. Khởi động webhook server với PM2 ==="
cd "$WEBHOOK_DIR"
pm2 delete webhook 2>/dev/null || true
WEBHOOK_PORT=$PORT WEBHOOK_SECRET="$SECRET" \
  node webhook-deploy.js &
sleep 2

echo "=== 5. Lưu PM2 startup ==="
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup

echo "=== 6. Mở port 3939 ==="
sudo ufw allow 3939/tcp 2>/dev/null || true

echo ""
echo "========== THÔNG TIN GITHUB WEBHOOK =========="
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || echo "103.75.183.57")
echo "🌐 Payload URL : http://$SERVER_IP:$PORT/"
echo "🔐 Secret      : $SECRET"
echo "📁 Repo dir    : $GIT_DIR"
echo "📜 Deploy script: $DEPLOY_SCRIPT"
echo ""
echo "=== Test nhanh ==="
curl http://localhost:$PORT/
pm2 list