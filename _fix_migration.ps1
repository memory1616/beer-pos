$key = "_k_1782360718674.pem"
$hostStr = "root@103.75.183.57"

Write-Host "=== Run migrations ==="
$migrate = ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "cd /root/beer-pos && node -e \`\"
const { runMigrations } = require('./database/migration');
runMigrations().then(() => {
  console.log('Migrations OK');
  process.exit(0);
}).catch(e => {
  console.error('Migration error:', e.message);
  process.exit(1);
});
\`\" 2>&1"
Write-Host $migrate

Write-Host ""
Write-Host "=== Verify ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "cd /root/beer-pos && sqlite3 beer.db 'SELECT COUNT(*) FROM sync_meta; SELECT COUNT(*) FROM customers;' 2>&1"

Write-Host ""
Write-Host "=== Restart PM2 ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "pm2 restart beer-pos && sleep 5" 2>&1 | tail -3

Write-Host ""
Write-Host "=== Test /dashboard/data ==="
ssh -i $key -o StrictHostKeyChecking=no -o BatchMode=yes $hostStr "curl -s http://127.0.0.1:3000/dashboard/data | head -200" 2>&1
