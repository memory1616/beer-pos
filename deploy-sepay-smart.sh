#!/bin/bash
# Deploy: Gạch nợ thông minh Sepay (nhận diện khách theo số tài khoản)
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

echo "=== 4. VERIFY MIGRATION 067 ==="
sqlite3 database.sqlite "PRAGMA table_info(customers);" | grep -E "bank_account" || echo "MISSING bank_account"
sqlite3 database.sqlite "PRAGMA table_info(sepay_transactions);" | grep -E "sender_|match_" || echo "MISSING tx cols"
sqlite3 database.sqlite "SELECT key, value FROM settings WHERE key LIKE 'sepay_smart%';"

echo "=== 5. SEED: đăng ký số TK cho khách 29 ==="
sqlite3 database.sqlite "UPDATE customers SET bank_account='1988888779779', bank_account_name='BUI TRUONG VAN', updated_at=CURRENT_TIMESTAMP WHERE id=29 AND (bank_account IS NULL OR bank_account='');"
sqlite3 -header -column database.sqlite "SELECT id, name, bank_account, bank_account_name FROM customers WHERE bank_account IS NOT NULL;"

echo "=== 6. REMATCH giao dịch đang chờ ==="
node -e "
const S = require('./src/services/debt/DebtSepayService');
S.resmartMatchPending({}).then(r => {
  console.log('scanned=' + r.scanned + ' settled=' + r.settled + ' failed=' + r.failed);
  console.log(JSON.stringify(r.details, null, 2));
  process.exit(0);
}).catch(e => { console.error('ERR', e.message); process.exit(1); });
" 2>&1 | grep -vE '^\[' | tail -40

echo "=== 7. VERIFY GIAO DỊCH ==="
sqlite3 -header -column database.sqlite "SELECT id, substr(content,1,45) AS content, transfer_amount, status, customer_id, match_method, sender_account, note FROM sepay_transactions ORDER BY id DESC LIMIT 8;"

echo "=== 8. VERIFY ROUTES ==="
for u in /api/debt-ledger/sepay/status /debts; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3000$u")
  echo "$u -> $code"
done

echo "=== 9. PM2 ERRORS ==="
pm2 logs beer-pos --lines 200 --nostream --err 2>/dev/null | grep -iE "error|fatal|exception" | grep -v "ADMIN_PASSWORD" | tail -8 || echo "(no errors)"

echo "=== DEPLOY_DONE ==="
