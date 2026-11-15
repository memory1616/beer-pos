#!/usr/bin/env bash
# Fix .env to be production-ready for cloud server
ENV_FILE=/var/www/beer-pos/.env

# Backup
cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)"

# Update production settings
sed -i 's|^IS_CLOUD_SERVER=.*|IS_CLOUD_SERVER=true|' "$ENV_FILE"
sed -i 's|^CLOUD_MODE=.*|CLOUD_MODE=true|' "$ENV_FILE"
sed -i 's|^CLOUD_DOMAIN=.*|CLOUD_DOMAIN=http://103.75.183.57|' "$ENV_FILE"
sed -i 's|^ADMIN_DOMAIN=.*|ADMIN_DOMAIN=admin.biatuoitayninh.store|' "$ENV_FILE"
sed -i 's|^PUBLIC_DOMAIN=.*|PUBLIC_DOMAIN=biatuoitayninh.store|' "$ENV_FILE"
sed -i 's|^DISTRIBUTOR_NAME=.*|DISTRIBUTOR_NAME=BeerPOS Pro+|' "$ENV_FILE"
sed -i 's|^NODE_ENV=.*|NODE_ENV=production|' "$ENV_FILE"

echo "=== Updated .env (production settings) ==="
grep -E "^(NODE_ENV|IS_CLOUD|CLOUD_MODE|CLOUD_DOMAIN|ADMIN_DOMAIN|PUBLIC_DOMAIN|DISTRIBUTOR_NAME)" "$ENV_FILE"

echo ""
echo "=== Restarting PM2 ==="
pm2 restart all 2>&1 | tail -5
sleep 2
echo ""
echo "=== Verify /api/discover ==="
curl -sS http://localhost:3000/api/discover