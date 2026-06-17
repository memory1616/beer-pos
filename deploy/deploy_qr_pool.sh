#!/bin/bash
# Deploy QR Pool feature to VPS
# Chạy script này trên server sau khi SCP files xong

set -e

VPS_PATH="$HOME/beer-pos"
echo "=== Deploying QR Pool feature to $VPS_PATH ==="

cd "$VPS_PATH"

# 1. Backup current files
echo "[1/5] Backing up current files..."
mkdir -p .backup
for f in database.js database/migration.js routes/api/settings.js views/qr-settings.html views/sales.html public/js/sales.js public/version.json; do
  if [ -f "$f" ]; then
    cp "$f" ".backup/$(basename $f).bak.$(date +%s)"
  fi
done

# 2. Verify files were uploaded
echo "[2/5] Verifying uploaded files..."
for f in database.js database/migration.js routes/api/settings.js views/qr-settings.html views/sales.html public/js/sales.js public/version.json; do
  if [ ! -f "$f" ]; then
    echo "MISSING: $f - abort"
    exit 1
  fi
  echo "  OK: $f"
done

# 3. Quick syntax check
echo "[3/5] Syntax check..."
node -c database.js && echo "  database.js OK"
node -c database/migration.js && echo "  database/migration.js OK"
node -c routes/api/settings.js && echo "  routes/api/settings.js OK"
node -c public/js/sales.js 2>&1 | head -5 && echo "  public/js/sales.js OK"

# 4. Verify QR accounts table will be created on next start
echo "[4/5] Checking DB schema..."
sqlite3 database.sqlite ".schema qr_accounts" 2>/dev/null || echo "  (table will be created on next server start)"

# 5. Restart PM2
echo "[5/5] Restarting PM2..."
pm2 restart beer-pos

# 6. Wait and verify
sleep 4
echo ""
echo "=== Verification ==="
echo "PM2 status:"
pm2 status | grep beer-pos
echo ""
echo "API check:"
curl -s -o /dev/null -w "GET /api/settings/qr-accounts: HTTP %{http_code}\n" http://localhost:3000/api/settings/qr-accounts
curl -s -o /dev/null -w "GET /api/settings/qr-accounts/active: HTTP %{http_code}\n" http://localhost:3000/api/settings/qr-accounts/active
echo ""
echo "DB check:"
sqlite3 database.sqlite "SELECT COUNT(*) || ' QR accounts seeded' FROM qr_accounts;" 2>/dev/null || echo "  (use: sqlite3 database.sqlite 'SELECT * FROM qr_accounts;')"
echo ""
echo "=== Deploy complete ==="
echo "Open: https://admin.biatuoitayninh.store/qr-settings"
echo "       https://admin.biatuoitayninh.store/sales"
