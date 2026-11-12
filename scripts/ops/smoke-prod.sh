#!/usr/bin/env bash
# Smoke test các route trên production (chạy trên server, qua localhost:3000).
set -uo pipefail
BASE="http://127.0.0.1:3000"

check() {
  local path="$1" expect="$2"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$path")
  if [ "$code" = "$expect" ]; then
    echo "PASS  $path -> $code"
  else
    echo "FAIL  $path -> $code (expected $expect)"
  fi
}

echo "=== ROUTE TỪNG BỊ SHADOW (phải 200) ==="
check /api/sync/status 200
check /api/customers/alerts 200
check /api/promotions/near-tier 200
check /api/session/check-migration 200
check /api/sales/export 200
check /api/segments 200

echo
echo "=== TRANG CHÍNH (phải 200) ==="
for p in / /login /dashboard /customers /customers/1 /sale /stock /kegs /report /analytics \
         /expenses /purchases /promo-settings /qr-settings /sales-staff /devices \
         /walkin-kegs /delivery /api/docs /health; do
  check "$p" 200
done

echo
echo "=== DRIVER PORTAL ==="
# /driver chỉ mở trên driver domain → localhost trả 302 là ĐÚNG thiết kế
check /driver 302
for p in /auth/driver /driver/ban-hang /driver/giao-hang /driver/khach-hang /driver/phieu-thu-vo; do
  check "$p" 200
done
printf 'driver subdomain / -> '
curl -s -o /dev/null -w '%{http_code} (expected 200)\n' -H 'Host: driver.biatuoitayninh.store' "$BASE/"

echo
echo "=== ASSET ĐÃ XÓA (phải 404) ==="
for p in /js/api.js /js/realtime-client.js /js/empty-state.js /js/segmentation.js \
         /css/ui-components.css /landing-assets/beer.mp4 /landing-assets/beer-web.mp4 \
         /css/tailwind.css; do
  check "$p" 404
done

echo
echo "=== ASSET CÒN (phải 200) ==="
for p in /sw.v2.js /js/realtime.js /js/vendor/dexie.min.js /js/vendor/chart.umd.min.js \
         /css/unified.css /css/driver.css /css/driver-system.css; do
  check "$p" 200
done

echo
echo "=== SW (phải 200, KHÔNG redirect — SW script không được nằm sau redirect) ==="
check /sw.js 200
check /sw.v2.js 200
# Nội dung /sw.js phải giống hệt /sw.v2.js để SW cũ tự update
if curl -s "$BASE/sw.js" | diff -q - "$BASE/sw.v2.js" >/dev/null 2>&1; then
  echo "PASS: /sw.js == /sw.v2.js (nội dung giống hệt)"
else
  echo "FAIL: /sw.js khác /sw.v2.js"
  FAIL=$((FAIL+1))
fi
