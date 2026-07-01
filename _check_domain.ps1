$key = "d:\Beer\_k_1782360718674.pem"
$hostStr = "root@103.75.183.57"

Write-Host "=== Check nginx config ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "cat /etc/nginx/sites-enabled/beerpos.conf 2>/dev/null || cat /etc/nginx/conf.d/*.conf 2>/dev/null | grep -A5 'server_name'"

Write-Host ""
Write-Host "=== Check if admin.biatuoitayninh.store resolves to server ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "nslookup admin.biatuoitayninh.store 2>/dev/null || curl -s https://dns.google/resolve?name=admin.biatuoitayninh.store 2>/dev/null | head -5"

Write-Host ""
Write-Host "=== Check Cloud API endpoints ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "grep -r 'cloud\|Cloud' /root/beer-pos/routes/ 2>/dev/null | head -10"

Write-Host ""
Write-Host "=== Server public IP ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "curl -s ifconfig.me"
