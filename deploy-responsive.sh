#!/bin/bash
# Deploy: tối ưu responsive + bottom menu cho trang /preorders, /delivery, /regions
set -uo pipefail
APP_DIR=/var/www/beer-pos
cd "$APP_DIR"

echo "=== 1. GIT PULL ==="
git pull origin main
git log --oneline -1

echo "=== 2. RESTART PM2 ==="
pm2 restart beer-pos --update-env
sleep 5

echo "=== 3. VERIFY FILES ==="
for f in public/css/bottomnav.css public/js/layout.js views/preorders.html views/delivery.html views/regions.html; do
  if [ -f "$f" ]; then echo "OK  $f"; else echo "MISS $f"; fi
done

echo "=== 4. VERIFY ROUTES ==="
for u in /preorders /delivery /regions /css/bottomnav.css; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3000$u")
  echo "$u -> $code"
done

echo "=== 5. PM2 ERRORS ==="
pm2 logs beer-pos --lines 150 --nostream --err 2>/dev/null | grep -iE "error|fatal|exception" | grep -v "ADMIN_PASSWORD" | tail -8 || echo "(no errors)"

echo "=== DEPLOY_DONE ==="
