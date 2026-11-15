#!/usr/bin/env bash
echo "=== SERVER FINAL STATUS ==="
echo ""
echo "=== Date/Time ==="
date
echo ""
echo "=== PM2 ==="
pm2 list
echo ""
echo "=== App + Nginx processes ==="
ps -ef | grep -E "node|nginx" | grep -v grep | head -5
echo ""
echo "=== Nginx status ==="
systemctl is-active nginx
echo ""
echo "=== Open ports ==="
ss -tlnp | head -10
echo ""
echo "=== Disk ==="
df -h / | tail -2
echo ""
echo "=== RAM ==="
free -h | head -2
echo ""
echo "=== App directory ==="
ls -la /var/www/beer-pos/ | head -10
echo ""
echo "=== Last 10 log lines ==="
tail -10 /var/www/beer-pos/logs/out.log
echo ""
echo "=== Database check ==="
sqlite3 /var/www/beer-pos/database.sqlite "SELECT COUNT(*) AS customers FROM customers; SELECT COUNT(*) AS devices FROM devices; SELECT COUNT(*) AS sales FROM sales; SELECT COUNT(*) AS products FROM products;"