@echo off
echo Zxcv@1234 > temp_pass.txt
echo Connecting to server...
"C:\Program Files\Git\usr\bin\ssh.exe" -o StrictHostKeyChecking=no -o BatchMode=yes root@103.75.183.57 "cd ~/beer-pos && pwd && echo '---FILES---' && ls -la && echo '---SALES---' && sqlite3 database.sqlite 'SELECT id, date, total, type FROM sales ORDER BY id DESC LIMIT 20;' && echo '---TODAY---' && sqlite3 database.sqlite \"SELECT COUNT(*) FROM sales WHERE date(date) = date('now', 'localtime') AND type = 'sale';\""
del temp_pass.txt
