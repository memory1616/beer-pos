#!/usr/bin/env bash
# Deploy an toàn cho module Sổ công nợ (mô hình ghi nợ khi tạo đơn).
# 1. Backup database.sqlite
# 2. Pull code
# 3. Restart PM2
# 4. Verify
set -euo pipefail

APP_DIR="/var/www/beer-pos"
TS="$(date +%Y%m%d_%H%M%S)"

echo "=== [1/4] Backup database ==="
cd "$APP_DIR"
cp -a database.sqlite "backups/database.sqlite.pre-debt-oncreate.${TS}.bak" 2>/dev/null || {
  mkdir -p backups
  cp -a database.sqlite "backups/database.sqlite.pre-debt-oncreate.${TS}.bak"
}
echo "Backup: backups/database.sqlite.pre-debt-oncreate.${TS}.bak"

echo "=== [2/4] Pull code ==="
git pull --ff-only origin main

echo "=== [3/4] Restart PM2 ==="
pm2 restart beer-pos --update-env
sleep 3
pm2 list | grep beer-pos || true

echo "=== [4/4] Verify settings ==="
node -e "
const db = require('./database');
const rows = db.prepare(\"SELECT key, value FROM settings WHERE key LIKE 'debt_%' OR key='max_debt_per_customer'\").all();
rows.forEach(r => console.log('  ', r.key, '=', r.value));
const t = db.prepare('SELECT COUNT(*) c FROM debt_transactions').get();
console.log('   debt_transactions rows =', t.c);
"

echo "=== DONE ==="
