$key = "d:\Beer\_k_1782360718674.pem"
$hostStr = "root@103.75.183.57"

Write-Host "=== Test admin subdomain ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "curl -s http://127.0.0.1:3000/api/customers 2>&1 | head -20"

Write-Host ""
Write-Host "=== Test server directly ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "curl -s http://127.0.0.1:3000/api/customers 2>&1 | head -20"

Write-Host ""
Write-Host "=== Check PM2 logs ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "pm2 logs beer-pos --lines 20 --nostream 2>&1"

Write-Host ""
Write-Host "=== Check nginx error logs ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "tail -20 /var/log/nginx/error.log 2>/dev/null"
