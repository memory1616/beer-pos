@echo off
REM Kiểm tra nhanh server production qua SSH key (khong dung mat khau).
REM Dung alias `beer-server` trong ~/.ssh/config - xem docs/BEER_CLEANUP_PLAN.md §12.
ssh beer-server "cd /var/www/beer-pos && echo '---FILES---' && ls -la | head -20 && echo '---SALES---' && sqlite3 database.sqlite 'SELECT id, date, total, type FROM sales ORDER BY id DESC LIMIT 20;' && echo '---TODAY---' && sqlite3 database.sqlite \"SELECT COUNT(*) FROM sales WHERE date(date) = date('now', 'localtime') AND type = 'sale';\""
