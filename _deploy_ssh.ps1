# Deploy script using PowerShell SSH

$server = "103.75.183.57"
$user = "root"

Write-Host "Deploying to server: $server"

# Commands to run on server
$commands = @"
cd ~/beer-pos
echo '=== Current commit ==='
git log --oneline -3
echo ''
echo '=== Git pull ==='
git pull origin main
echo ''
echo '=== New commit ==='
git log --oneline -3
echo ''
echo '=== Restart PM2 ==='
pm2 restart beer-pos
sleep 3
echo ''
echo '=== PM2 Status ==='
pm2 status
echo ''
echo '=== Health Check ==='
curl -s http://127.0.0.1:3000/health
"@

# Run via SSH
Write-Host "Running commands..."
$result = ssh -o StrictHostKeyChecking=no -i "D:\Beer\cursor_deploy_key" "${user}@${server}" $commands 2>&1

Write-Host $result

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nDeploy SUCCESS!"
} else {
    Write-Host "`nDeploy FAILED!"
}
