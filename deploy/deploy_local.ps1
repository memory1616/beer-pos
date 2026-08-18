<#
.SYNOPSIS
    BeerPOS - Local Deploy Script (Windows PowerShell)

.DESCRIPTION
    Dong bo files tu local len VPS qua SCP, sau do chay deploy.sh tren server.
    KHONG can password (dung SSH key da setup o C:\Users\ADMIN\.ssh\config
    voi Host alias "beer-server", hoac tu cursor_deploy_key).

.PARAMETER ServerHost
    VPS hostname/IP (default: 103.75.183.57)

.PARAMETER User
    SSH user (default: root)

.PARAMETER Path
    File hoac thu muc local can deploy (relative hoac absolute)

.PARAMETER All
    Sync toan bo project (database.js, views/, public/js/, routes/, server.js, ...)

.PARAMETER KeyPath
    Duong dan SSH key (default: uu tien cursor_deploy_key, fallback $HOME\.ssh\id_ed25519)

.PARAMETER SkipConfirm
    Bo qua buoc xac nhan

.PARAMETER UseHostAlias
    Dung SSH Host alias "beer-server" (da config trong ~/.ssh/config)

.EXAMPLE
    .\deploy_local.ps1 -Path ".\views\qr-settings.html"
    .\deploy_local.ps1 -Path ".\public\js\sales.js"
    .\deploy_local.ps1 -All
    .\deploy_local.ps1 -Path ".\routes\api\settings.js" -SkipConfirm
    .\deploy_local.ps1 -All -UseHostAlias

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
    [string]$KeyPath = "",
    [switch]$SkipConfirm,
    [switch]$UseHostAlias
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

# Resolve SSH key path (priority: -KeyPath > cursor_deploy_key > ~/.ssh/id_ed25519)
if (-not $KeyPath) {
    $candidates = @(
        "d:\Beer\cursor_deploy_key",
        "$HOME\.ssh\id_ed25519",
        "$HOME\.ssh\id_ed25519_beer",
        "$HOME\.ssh\id_rsa"
    )
    foreach ($cand in $candidates) {
        if (Test-Path $cand) {
            $KeyPath = $cand
            break
        }
    }
}

if (-not $KeyPath -or -not (Test-Path $KeyPath)) {
    Write-Err "No SSH key found. Tried:"
    Write-Host "  - d:\Beer\cursor_deploy_key" -ForegroundColor Gray
    Write-Host "  - $HOME\.ssh\id_ed25519" -ForegroundColor Gray
    Write-Host "  - $HOME\.ssh\id_ed25519_beer" -ForegroundColor Gray
    Write-Host "  - $HOME\.ssh\id_rsa" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Generate with: ssh-keygen -t ed25519" -ForegroundColor Yellow
    Write-Host "Or use -KeyPath <path>" -ForegroundColor Yellow
    exit 1
}
Write-OK "SSH key: $KeyPath"

# Build SSH options
if ($UseHostAlias) {
    $sshHost = "beer-server"
    $sshCommon = @("-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes")
    $scpKeyArg = @()  # Host alias already specifies IdentityFile
    $sshTarget = $sshHost
} else {
    $sshHost = "$User@$ServerHost"
    $sshCommon = @("-i", $KeyPath, "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes")
    $scpKeyArg = @("-i", $KeyPath)
    $sshTarget = $sshHost
}

# Test connection
Write-Step "Test SSH connection to $sshTarget"
$testCmd = if ($UseHostAlias) { $sshTarget } else { $sshHost }
$testResult = ssh @sshCommon -o ConnectTimeout=8 "$testCmd" "echo CONN_OK: \$(whoami)@\$(hostname)" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Err "Cannot SSH. Check key + server status."
    Write-Host $testResult
    exit 1
}
Write-OK $testResult

# --- 1. Build list of files to deploy ---
Write-Step "Determining files to deploy"

# Exclusion patterns - CHI sync source code, KHONG dong bo:
# - node_modules (npm install se tu chay tren server)
# - .git (git pull se tu lam)
# - database sqlite files (production DB, KHONG DUOC PHEP overwrite)
# - backups, logs, coverage (chi ton bandwidth)
# - sensitive credentials (.env, .pem)
$exclude = @(
    "node_modules",
    ".git",
    "coverage",
    ".backup",
    "backups",
    "backup",
    "logs",
    "__pycache__",
    "*.log",
    "*.db",
    "*.sqlite",
    "*.sqlite-shm",
    "*.sqlite-wal",
    ".env",
    ".env.local",
    ".env.*.local",
    "*.pem",
    "*.key",
    "*.bak",
    "*.bak.*",
    "*.old",
    "*.bak.*"
)

$items = @()
if ($All) {
    # Sync full project (exclude heavy/sensitive files)
    $items = Get-ChildItem -Path $ProjectRoot -Recurse -File |
        Where-Object {
            $rel = $_.FullName.Substring($ProjectRoot.Length + 1)
            # Skip if matches any exclusion
            $skip = $false
            foreach ($ex in $exclude) {
                # Check if exclusion applies to directory part of path
                $pathParts = $rel -split '[\\/]'
                if ($pathParts -contains $ex) { $skip = $true; break }
                # Check wildcard patterns (file extension)
                if ($ex -like "*.*" -and $rel -like $ex) { $skip = $true; break }
            }
            -not $skip
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
    $items | Select-Object -First 30 | ForEach-Object { Write-Host "  - $_" }
    if ($items.Count -gt 30) { Write-Host "  ... and $($items.Count - 30) more" }
    Write-Host ""
    $ans = Read-Host "Deploy to $sshHost ? (y/N)"
    if ($ans -ne "y") {
        Write-Warn "Cancelled by user"
        exit 0
    }
}

# --- 3. Clean staging + SCP ---
Write-Step "Uploading to staging $StagingPath"

# Clean remote staging
$cleanCmd = "rm -rf $StagingPath && mkdir -p $StagingPath"
if ($UseHostAlias) {
    ssh @sshCommon $sshTarget $cleanCmd 2>&1 | Out-Null
} else {
    ssh @sshCommon $sshTarget $cleanCmd 2>&1 | Out-Null
}

# Use scp -r for each item to preserve directory structure
$scpArgs = @("-r") + $scpKeyArg + @("-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes")
$okCount = 0
$failCount = 0
$failItems = @()

foreach ($item in $items) {
    $local = Join-Path $ProjectRoot $item
    if ($UseHostAlias) {
        $remote = "${sshTarget}:${StagingPath}/"
    } else {
        $remote = "${User}@${ServerHost}:${StagingPath}/"
    }
    $output = scp @scpArgs $local $remote 2>&1
    if ($LASTEXITCODE -eq 0) {
        $okCount++
    } else {
        Write-Err "SCP failed for $item"
        Write-Host $output
        $failCount++
        $failItems += $item
    }
}

Write-OK "Uploaded: $okCount, Failed: $failCount"
if ($failCount -gt 0) {
    Write-Warn "Failed items:"
    $failItems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
}
if ($failCount -gt 0 -and $okCount -eq 0) {
    Write-Err "All uploads failed - abort"
    exit 1
}

# --- 4. Run deploy.sh on server ---
Write-Step "Running deploy.sh on server"

$deployCmd = "bash $VPSPath/deploy/deploy.sh"
if ($UseHostAlias) {
    ssh @sshCommon $sshTarget $deployCmd
} else {
    ssh @sshCommon $sshHost $deployCmd
}
$deployExit = $LASTEXITCODE

if ($deployExit -eq 0) {
    Write-Step "DEPLOY SUCCESS" -Color Green
} else {
    Write-Err "Deploy failed (exit code $deployExit)"
    Write-Host "Check:"
    Write-Host "  - ssh $sshHost 'pm2 logs beer-pos --lines 50'"
    Write-Host "  - ssh $sshHost 'tail -50 /var/www/beer-pos/logs/deploy.log'"
    exit $deployExit
}

# --- 5. Optional: verify API ---
Write-Step "Quick API check"
$apiCmd = "curl -s -o /dev/null -w 'health=%{http_code}\n' http://127.0.0.1:3000/health"
if ($UseHostAlias) {
    $apiCheck = ssh @sshCommon $sshTarget $apiCmd
} else {
    $apiCheck = ssh @sshCommon $sshHost $apiCmd
}
Write-Host "  $apiCheck"

Write-Step "Done"
