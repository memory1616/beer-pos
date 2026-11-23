#!/bin/bash
# Deploy: bù thông báo Zalo bị mất + gửi lại thủ công
set -uo pipefail
APP_DIR=/var/www/beer-pos
cd "$APP_DIR"

echo "=== 1. GIT PULL ==="
git pull origin main
git log --oneline -1

echo "=== 2. BACKUP DB ==="
cp database.sqlite "database.sqlite.bak.$(date +%Y%m%d_%H%M%S)" 2>/dev/null && echo "backup OK" || echo "backup skipped"

echo "=== 3. RESTART PM2 ==="
pm2 restart beer-pos --update-env
sleep 6

echo "=== 4. GỬI LẠI TIN THÔNG BÁO BỊ MẤT ==="
cat > /tmp/retry_notify.js <<'EOF'
const S = require('./src/services/debt/DebtNotifyService');
(async () => {
  const r = await S.retryMissingNotifications({ lookbackDays: 30 });
  console.log('scanned=' + r.scanned + ' sent=' + r.sent + ' failed=' + r.failed);
  console.log(JSON.stringify(r.details, null, 2));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
EOF
cp /tmp/retry_notify.js ./retry_notify.js
timeout 60 node retry_notify.js > /tmp/retry_out.txt 2>&1
rm -f retry_notify.js
grep -vE '^\[|^Keg|^ ' /tmp/retry_out.txt | head -40

echo "=== 5. VERIFY LOG THÔNG BÁO ==="
sqlite3 -header -column database.sqlite "SELECT id, customer_id, customer_name, event_type, amount, status, error, created_at FROM debt_notifications ORDER BY id DESC LIMIT 8;"

echo "=== 6. VERIFY ROUTES ==="
for u in /debts /api/debt-ledger/notify/settings; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3000$u")
  echo "$u -> $code"
done
curl -s http://127.0.0.1:3000/debts | grep -c 'retryMissingNotify'

echo "=== 7. PM2 ERRORS ==="
pm2 logs beer-pos --lines 200 --nostream --err 2>/dev/null | grep -iE "error|fatal|exception" | grep -v "ADMIN_PASSWORD" | tail -8 || echo "(no errors)"

echo "=== DEPLOY_DONE ==="
