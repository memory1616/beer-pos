$key = "_k_1782360718674.pem"
$hostStr = "root@103.75.183.57"

Write-Host "=== Check all customers with archived status ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "cd /root/beer-pos && sqlite3 beer.db 'SELECT id, name, archived, deleted, created_at FROM customers ORDER BY id;' 2>&1"

Write-Host ""
Write-Host "=== Check customers returned by API (limit 3) ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "curl -s 'http://127.0.0.1:3000/api/customers?limit=100' | node -e \"const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('Total API customers:', d.total); d.customers.forEach(c=>console.log(c.id, c.name, c.created_at));\" 2>&1"
