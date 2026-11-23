#!/bin/bash
# Deploy: KHÔNG tự động gửi tin Zalo + UI "Tin chưa gửi"
# ⚠️ Script này KHÔNG gửi tin vào nhóm khách. Chỉ pull + restart + verify.
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

echo "=== 4. VERIFY: KHÔNG còn gọi tự động gửi tin ==="
grep -n "retryMissingNotifications" src/services/debt/DebtSepayService.js && echo "WARN: van con tham chieu!" || echo "OK: da go tu dong gui tin"
grep -c "listMissingNotifications" src/services/debt/DebtSepayService.js

echo "=== 5. VERIFY API (chi doc) ==="
cat > /tmp/check_missing.js <<'EOF'
const S = require('./src/services/debt/DebtNotifyService');
const r = S.listMissingNotifications({ lookbackDays: 30 });
console.log('scanned=' + r.scanned);
r.items.forEach(i => console.log('  tx' + i.txId + ' | ' + i.customerName + ' | ' + i.amount + ' | con no ' + i.balanceAfter + ' | ' + (i.groupName || 'CHUA LIEN KET NHOM')));
EOF
cp /tmp/check_missing.js ./check_missing.js
timeout 30 node check_missing.js > /tmp/check_out.txt 2>&1
rm -f check_missing.js
grep -vE '^\[|^Keg|^ ' /tmp/check_out.txt | head -20

echo "=== 6. VERIFY log thong bao khong bi tu sinh ==="
sqlite3 -header -column database.sqlite "SELECT COUNT(*) AS total, MAX(created_at) AS newest FROM debt_notifications;"

echo "=== 7. VERIFY ROUTES ==="
for u in /debts /api/debt-ledger/notify/missing /api/debt-ledger/notify/resend; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3000$u")
  echo "$u -> $code"
done
echo "UI 'Tin chưa gửi': $(curl -s http://127.0.0.1:3000/debts | grep -c 'Tin chưa gửi')"
echo "UI resendNotify: $(curl -s http://127.0.0.1:3000/debts | grep -c 'resendNotify')"

echo "=== 8. PM2 ERRORS ==="
pm2 logs beer-pos --lines 200 --nostream --err 2>/dev/null | grep -iE "error|fatal|exception" | grep -v "ADMIN_PASSWORD" | tail -8 || echo "(no errors)"

echo "=== DEPLOY_DONE ==="
