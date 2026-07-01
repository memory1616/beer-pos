$key = "_k_1782360718674.pem"
$hostStr = "root@103.75.183.57"

Write-Host "=== Create migration script ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr @"
cat > /root/beer-pos/_run_migrate.js << 'SCRIPT'
const { runMigrations } = require('./database/migration');
runMigrations().then(() => {
  console.log('Migrations OK');
  process.exit(0);
}).catch(e => {
  console.error('Migration error:', e.message);
  process.exit(1);
});
SCRIPT
"@

Write-Host "=== Run migrations ==="
$migrate = ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "cd /root/beer-pos && node _run_migrate.js 2>&1"
Write-Host $migrate

Write-Host ""
Write-Host "=== Verify ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "cd /root/beer-pos && sqlite3 beer.db 'SELECT COUNT(*) FROM sync_meta; SELECT COUNT(*) FROM customers; PRAGMA table_info(customers);' 2>&1"

Write-Host ""
Write-Host "=== Restart PM2 ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "pm2 restart beer-pos 2>&1 | tail -2"

Write-Host ""
Write-Host "=== Test dashboard ==="
$dash = ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "curl -s http://127.0.0.1:3000/dashboard/data 2>&1 | head -100"
Write-Host $dash
