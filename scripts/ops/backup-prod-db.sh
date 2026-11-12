#!/usr/bin/env bash
# Backup DB production bằng SQLite VACUUM INTO (an toàn hơn copy file khi có WAL)
set -euo pipefail
cd /var/www/beer-pos

TS="$(date +%Y%m%d_%H%M%S)"
OUT="backups/pre_cleanup_${TS}.sqlite"

node -e "
const D = require('better-sqlite3');
const db = new D('database.sqlite', { readonly: true });
db.exec(\"VACUUM INTO '${OUT}'\");
db.close();
console.log('VACUUM INTO ok');
"

ls -la "$OUT"
echo '--- baseline (để so sánh sau deploy) ---'
sqlite3 database.sqlite "SELECT 'sales_active=' || COUNT(*) FROM sales WHERE archived=0"
sqlite3 database.sqlite "SELECT 'sales_total=' || COUNT(*) FROM sales"
sqlite3 database.sqlite "SELECT 'customers=' || COUNT(*) FROM customers"
sqlite3 database.sqlite "SELECT 'products=' || COUNT(*) FROM products"
sqlite3 database.sqlite "SELECT 'revenue=' || IFNULL(SUM(total),0) FROM sales WHERE archived=0"
sqlite3 database.sqlite "SELECT 'app_users=' || COUNT(*) FROM app_users"
sqlite3 database.sqlite "PRAGMA integrity_check"
