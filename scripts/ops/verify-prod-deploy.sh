#!/usr/bin/env bash
# So sánh số liệu DB production sau deploy với baseline.
set -euo pipefail
cd /var/www/beer-pos

echo "=== SỐ LIỆU HIỆN TẠI ==="
sqlite3 database.sqlite "SELECT 'sales_active=' || COUNT(*) FROM sales WHERE archived=0"
sqlite3 database.sqlite "SELECT 'sales_total=' || COUNT(*) FROM sales"
sqlite3 database.sqlite "SELECT 'customers=' || COUNT(*) FROM customers"
sqlite3 database.sqlite "SELECT 'products=' || COUNT(*) FROM products"
sqlite3 database.sqlite "SELECT 'revenue=' || IFNULL(SUM(total),0) FROM sales WHERE archived=0"
sqlite3 database.sqlite "SELECT 'app_users=' || COUNT(*) FROM app_users"

echo
echo "=== INTEGRITY ==="
sqlite3 database.sqlite "PRAGMA integrity_check"
echo -n "foreign_key_check rows: "
sqlite3 database.sqlite "PRAGMA foreign_key_check" | wc -l

echo
echo "=== BẢNG NGHIỆP VỤ (migration 048) ==="
for t in customer_segments delivery_schedules delivery_schedule_items debt_transactions sync_dedup; do
  n=$(sqlite3 database.sqlite "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$t'")
  echo "  $t: exists=$n"
done
echo -n "  customers.tier: "
sqlite3 database.sqlite "PRAGMA table_info(customers)" | grep -c "|tier|" || true
echo -n "  customers.segment_id: "
sqlite3 database.sqlite "PRAGMA table_info(customers)" | grep -c "|segment_id|" || true

echo
echo "=== ASSETS ĐÃ XÓA (phải = 0 hoặc không tồn tại) ==="
for f in public/js/api.js public/js/realtime-client.js public/sw.js public/css/ui-components.css \
         public/landing-assets/beer.mp4 public/landing-assets/beer-web.mp4 \
         public/css/tailwind.css src/store/index.js; do
  [ -e "$f" ] && echo "  STILL EXISTS: $f" || echo "  removed: $f"
done

echo
echo "=== PM2 ==="
pm2 list 2>/dev/null | grep -E 'beer-pos' || true
echo -n "  health: "
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/health
