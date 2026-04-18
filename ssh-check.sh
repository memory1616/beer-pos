#!/bin/bash
export SSHPASS='Zxcv@1234'
sshpass -e ssh -o StrictHostKeyChecking=no root@103.75.183.57 "cd ~/beer-pos && pwd && ls -la && echo '---' && sqlite3 database.sqlite 'SELECT id, date, total, type FROM sales ORDER BY id DESC LIMIT 20;'" 2>&1
