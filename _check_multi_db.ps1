$key = "_k_1782360718674.pem"
$hostStr = "root@103.75.183.57"

Write-Host "=== Check if multiple DB files exist ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "ls -la /root/beer-pos/*.db /root/beer-pos/*.sqlite 2>/dev/null"

Write-Host ""
Write-Host "=== Check database.sqlite customers ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "sqlite3 /root/beer-pos/database.sqlite 'SELECT COUNT(*) FROM customers; SELECT * FROM customers LIMIT 3;' 2>&1"

Write-Host ""
Write-Host "=== Check server.js - which DB is used ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "grep -n 'beer\.db\|database\.js\|DATABASE\|open(' /root/beer-pos/server.js | head -20"
