# Deploy BeerPOS to Server
# Run this script and enter your SSH password when prompted

$server = "103.75.183.57"
$user = "root"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  BeerPOS Deploy Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Read password securely
Write-Host "Enter SSH password: " -NoNewline
$pass = Read-Host -AsSecureString
$passBstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($pass)
$password = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($passBstr)

# Build SSH command
$commands = @"
cd ~/beer-pos && git pull origin main && pm2 restart beer-pos && sleep 3 && pm2 status && curl -s http://127.0.0.1:3000/health
"@

Write-Host ""
Write-Host "Deploying..." -ForegroundColor Yellow

# Run SSH with password
$env:SSHPASS = $password
sshpass -e ssh -o StrictHostKeyChecking=no ${user}@${server} $commands

# Clear password from memory
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passBstr)
Remove-Variable pass, password, passBstr

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nDeploy SUCCESS!" -ForegroundColor Green
} else {
    Write-Host "`nDeploy FAILED! Exit code: $LASTEXITCODE" -ForegroundColor Red
}
