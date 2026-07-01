$key = "_k_1782360718674.pem"
$hostStr = "root@103.75.183.57"

Write-Host "=== Test API customers ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "curl -s http://127.0.0.1:3000/api/customers 2>&1 | head -50"

Write-Host ""
Write-Host "=== Check if archived filter is applied ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "cd /root/beer-pos && sqlite3 beer.db 'SELECT COUNT(*) FROM customers WHERE archived = 0;' 2>&1"

Write-Host ""
Write-Host "=== Check logs after restart ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "tail -5 /root/.pm2/logs/beer-pos-error.log 2>&1"
