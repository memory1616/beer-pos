$key = "_k_1782360718674.pem"
$hostStr = "root@103.75.183.57"

Write-Host "=== All customers in DB ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "cd /root/beer-pos && sqlite3 beer.db 'SELECT id, name, archived, deleted, created_at FROM customers ORDER BY id;' 2>&1"

Write-Host ""
Write-Host "=== API customers count ==="
$s = ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "curl -s 'http://127.0.0.1:3000/api/customers?limit=100' > /tmp/customers.json && node -p \"const d=JSON.parse(require('fs').readFileSync('/tmp/customers.json','utf8')); 'API total: ' + d.total + ' | Created at: ' + d.customers.map(c=>c.created_at).join(', ');\" 2>&1"
Write-Host $s
