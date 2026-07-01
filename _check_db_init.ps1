$key = "_k_1782360718674.pem"
$hostStr = "root@103.75.183.57"

Write-Host "=== Check server.js database init ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "grep -n 'database\|\.db\|\.sqlite' /root/beer-pos/server.js | head -20"

Write-Host ""
Write-Host "=== Check database.js ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "grep -n 'database\|\.db\|\.sqlite' /root/beer-pos/database.js | head -20"
