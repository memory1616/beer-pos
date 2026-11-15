#!/usr/bin/env bash
echo "=== Test web from server (localhost) ==="
curl -sS -o /dev/null -w "HTTP_STATUS=%{http_code} TIME=%{time_total}s\n" http://localhost:3000/

echo ""
echo "=== /api/discover ==="
curl -sS http://localhost:3000/api/discover 2>&1 | head -20

echo ""
echo "=== /api/health (if exists) ==="
curl -sS http://localhost:3000/api/health 2>&1 | head -10

echo ""
echo "=== / (root) ==="
curl -sS http://localhost:3000/ 2>&1 | head -10

echo ""
echo "=== Recent logs ==="
tail -30 /var/www/beer-pos/logs/out.log

echo ""
echo "=== Errors? ==="
test -f /var/www/beer-pos/logs/err.log && tail -10 /var/www/beer-pos/logs/err.log || echo "(no err.log)"