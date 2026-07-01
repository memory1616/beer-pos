<#
.SYNOPSIS
    BeerPOS - Local Deploy Script (Windows PowerShell)

.DESCRIPTION
    Đồng bộ files từ local lên VPS qua SCP, sau đó chạy deploy.sh trên server.
    KHÔNG cần password (dùng SSH key đã setup ở C:\Users\ADMIN\.ssh\id_ed25519).

.PARAMETER ServerHost
    VPS hostname/IP (default: 103.75.183.57)

.PARAMETER Path
    File hoặc thư mục local cần deploy (relative hoặc absolute)

.PARAMETER All
    Sync toàn bộ project (database.js, views/, public/js/, routes/, server.js, ...)

.PARAMETER SkipConfirm
    Bỏ qua bước xác nhận

.EXAMPLE
    .\deploy_local.ps1 -Path ".\views\qr-settings.html"
    .\deploy_local.ps1 -Path ".\public\js\sales.js"
    .\deploy_local.ps1 -All
    .\deploy_local.ps1 -Path ".\routes\api\settings.js" -SkipConfirm

.NOTES
    Author: BeerPOS Team
    Requires: OpenSSH client (built-in on Win10+) + SSH key in ~/.ssh/
#>

[CmdletBinding()]
param(
    [string]$ServerHost = "103.75.183.57",
    [string]$User = "root",
    [string]$Path = "",
    [switch]$All,
    [switch]$SkipConfirm
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$VPSPath = "/root/beer-pos"
$StagingPath = "/root/beer-pos_new"

# Colors
function Write-Step($msg) { Write-Host "`n===> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  [ERR] $msg" -ForegroundColor Red }

# --- 0. Pre-flight checks ---
Write-Step "Pre-flight checks"

# Check SSH
$ssh = (Get-Command ssh -ErrorAction SilentlyContinue)
if (-not $ssh) {
    Write-Err "ssh not found. OpenSSH client is built-in on Win10+. Enable it in Settings > Apps > Optional Features."
    exit 1
}
Write-OK "ssh found: $($ssh.Source)"

# Check SSH key
$keyPath = "d:\Beer\_k_1782360718674.pem"
$sshCommon = @("-i", $keyPath, "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes")

if (-not (Test-Path $keyPath)) {
    Write-Warn "SSH key not found at $keyPath"
    Write-Host "    Generate with: ssh-keygen -t ed25519"
    $ans = Read-Host "    Continue anyway? (y/N)"
    if ($ans -ne "y") { exit 1 }
} else {
    Write-OK "SSH key found: $keyPath"
}

# Test connection
Write-Step "Test SSH connection to $User@$ServerHost"
$testResult = ssh @sshCommon -o ConnectTimeout=8 "$User@$ServerHost" "echo CONN_OK: \$(whoami)@\$(hostname)" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Err "Cannot SSH. Check key + server status."
    Write-Host $testResult
    exit 1
}
Write-OK $testResult

# --- 1. Build list of files to deploy ---
Write-Step "Determining files to deploy"

$items = @()
if ($All) {
    # Sync full project (excluding node_modules, .git, logs, etc.)
    $exclude = @("node_modules", ".git", "coverage", ".backup", "backups", "*.log", "*.db", "*.sqlite*")
    $items = Get-ChildItem -Path $ProjectRoot -Recurse -File |
        Where-Object {
            $rel = $_.FullName.Substring($ProjectRoot.Length + 1)
            -not ($exclude | Where-Object { $rel -like "*$_*" })
        } |
        ForEach-Object { $_.FullName.Substring($ProjectRoot.Length + 1) }
    Write-OK "All mode: $($items.Count) files"
} elseif ($Path) {
    $abs = if (Test-Path $Path) { (Resolve-Path $Path).Path } else { Join-Path $ProjectRoot $Path }
    if (-not (Test-Path $abs)) {
        Write-Err "Path not found: $abs"
        exit 1
    }
    # Use relative path from project root (preserves directory structure for SCP)
    $relPath = $abs.Substring($ProjectRoot.Length + 1)
    $items = @($relPath)
    Write-OK "Single item: $($items -join ', ')"
} else {
    Write-Err "Specify -Path <file> or -All"
    exit 1
}

# --- 2. Confirm ---
if (-not $SkipConfirm) {
    Write-Host ""
    Write-Host "Files to deploy ($($items.Count)):" -ForegroundColor Yellow
    $items | Select-Object -First 20 | ForEach-Object { Write-Host "  - $_" }
    if ($items.Count -gt 20) { Write-Host "  ... and $($items.Count - 20) more" }
    Write-Host ""
    $ans = Read-Host "Deploy to $User@$ServerHost ? (y/N)"
    if ($ans -ne "y") {
        Write-Warn "Cancelled by user"
        exit 0
    }
}

# --- 3. Clean staging + SCP ---
Write-Step "Uploading to staging $StagingPath"

ssh @sshCommon "$User@$ServerHost" "rm -rf $StagingPath && mkdir -p $StagingPath" 2>&1 | Out-Null

# Use scp -r for each item to preserve directory structure
$scpArgs = @("-r", "-i", $keyPath, "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes")
$okCount = 0
$failCount = 0
foreach ($item in $items) {
    $local = Join-Path $ProjectRoot $item
    $remote = "${User}@${ServerHost}:${StagingPath}/"
    $output = scp @scpArgs $local $remote 2>&1
    if ($LASTEXITCODE -eq 0) {
        $okCount++
    } else {
        Write-Err "SCP failed for $item"
        Write-Host $output
        $failCount++
    }
}

Write-OK "Uploaded: $okCount, Failed: $failCount"
if ($failCount -gt 0 -and $okCount -eq 0) {
    Write-Err "All uploads failed - abort"
    exit 1
}

# --- 4. Run deploy.sh on server ---
Write-Step "Running deploy.sh on server"

$deployCmd = "bash $VPSPath/deploy/deploy.sh"
ssh @sshCommon "$User@$ServerHost" $deployCmd
$deployExit = $LASTEXITCODE

if ($deployExit -eq 0) {
    Write-Step "DEPLOY SUCCESS" -Color Green
} else {
    Write-Err "Deploy failed (exit code $deployExit)"
    Write-Host "Check: ssh $User@$ServerHost 'pm2 logs beer-pos --lines 50'"
    exit $deployExit
}

# --- 5. Optional: verify API ---
Write-Step "Quick API check"
$apiCheck = ssh @sshCommon "$User@$ServerHost" "curl -s -o /dev/null -w 'health=%{http_code}\n' http://127.0.0.1:3000/health"
Write-Host "  $apiCheck"

Write-Step "Done"
