$key = "_k_1782360718674.pem"
$hostStr = "root@103.75.183.57"

Write-Host "=== Check API route source ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "grep -n 'deleted\|archived\|WHERE' /root/beer-pos/routes/api/customers.js | head -30"

Write-Host ""
Write-Host "=== Check products ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "curl -s 'http://127.0.0.1:3000/api/products' | head -c 500"
