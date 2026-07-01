$key = "d:\Beer\_k_1782360718674.pem"
$hostStr = "root@103.75.183.57"

Write-Host "=== Current server DB ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "cd /root/beer-pos && sqlite3 beer.db 'SELECT COUNT(*) FROM customers; SELECT COUNT(*) FROM products; SELECT COUNT(*) FROM sales; SELECT MAX(created_at) FROM sales;' 2>&1"

Write-Host ""
Write-Host "=== Local backup 25/06 (9:10 AM) ==="
$local = sqlite3 "d:\Beer\backup\backup-2026-06-25T09-10-00.db" "SELECT COUNT(*) FROM customers; SELECT COUNT(*) FROM products; SELECT COUNT(*) FROM sales; SELECT MAX(created_at) FROM sales;" 2>&1
Write-Host $local
