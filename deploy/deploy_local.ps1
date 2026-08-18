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

$ErrorActionPreference = "Continue"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

# Server app directory - WARNING: must match VPS_PATH in deploy.sh
# Production VPS uses /var/www/beer-pos (NOT /root/beer-pos)
# Override via env var: $env:VPS_PATH_OVERRIDE = "/some/path"
$VPSPath = if ($env:VPS_PATH_OVERRIDE) { $env:VPS_PATH_OVERRIDE } else { "/var/www/beer-pos" }
$StagingPath = "$VPSPath`_new"

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

# SSH "Permanently added" warning writes to stderr and PowerShell treats
# it as a non-terminating error. Use .NET Process to fully suppress.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "ssh"
$psi.Arguments = ($sshCommon -join " ") + " -o ConnectTimeout=8 `"$testCmd`" `"echo CONN_OK: \$(whoami)@\$(hostname)`""
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true

try {
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit(10000) | Out-Null
    $testExit = $proc.ExitCode
} catch {
    Write-Err "Cannot start SSH: $_"
    exit 1
}

$testOutput = $stdout + $stderr
if ($testExit -ne 0 -or $stdout -notmatch "CONN_OK") {
    Write-Err "Cannot SSH. Check key + server status. (exit=$testExit)"
    Write-Host $testOutput
    exit 1
}
Write-OK $stdout.Trim()

# --- 1. Build list of files to deploy ---
Write-Step "Determining files to deploy"

# Exclusion patterns - CHI sync source code, KHONG dong bo:
#
# Nhom 1: Directory can exclude (tên chính xác)
$excludeDirs = @(
    "node_modules",      # npm install se tu chay tren server
    ".git",              # git pull se tu lam
    "coverage",          # coverage reports
    ".backup",           # backup files cua deploy.sh
    "backups",           # database backups
    "backup",            # legacy backup dir
    "logs",              # log files
    "__pycache__",       # python cache
    ".husky",            # git hooks
    ".cursor",           # cursor IDE config
    "deploy",            # KHONG deploy deploy.sh len staging (se copy qua .backup)
    "scripts"            # dev/debug scripts
)

# Nhom 2: Wildcard patterns (file extension hoặc prefix)
$excludeGlobs = @(
    "*.log",
    "*.db",
    "*.sqlite",
    "*.sqlite-shm",
    "*.sqlite-wal",
    "*.bak",
    "*.bak.*",
    "*.old",
    "*.tmp",
    "*.swp",
    "*.pyc",
    "*.pyo"
)

# Nhom 3: Sensitive files (KHONG BAO GIO deploy) - exact match hoặc glob
$excludeSensitive = @(
    ".env",
    ".env.local",
    ".env.*.local",
    ".env.production",
    ".env.example.bak",
    ".git-commit-msg.txt",
    ".git-commit-msg-deploy*.txt",
    "pass.txt",
    "*.pem",
    "*.key",
    "*_rsa*",
    "*_rsa2*",
    "*_deploy_key*",
    "cursor_deploy_key",
    "cursor_deploy_key.pub",
    "id_ed25519",
    "id_ed25519.pub",
    "id_rsa*",
    "known_hosts",
    "config"            # SSH config cua ~\.ssh\config
)

# Nhom 4: Files leak debug / temp / scratch (bắt đầu bằng _ hoặc prefix đặc biệt)
$excludeScratch = @(
    "_*.py",
    "_*.pem",
    "_*.sql",
    "_*.sqlite",
    "_*.db",
    "_*.key",
    "_*.gz",
    "_*.sh",
    "_*.bat",
    "_*.txt",           # _deploy_test_marker.txt, _commit_msg.txt, _test_*.txt
    "_*.md",            # _notes.md, _scratch.md
    "_*.json",          # _data.json, _test_data.json
    "_*.log",           # _app.log, _scratch.log
    "_commit_msg.txt",
    "debug_*.py",
    "debug_*.js",
    "test_*.py",        # python tests
    "why_*.py",
    "check_*.py",
    "inspect_*.py",
    "precheck_*.py",
    "query_*.py",
    "pull_*.py",
    "find_*.py",
    "run_*.py",
    "verify_*.py",
    "update_*.py",
    "upload*.py",  # uploadsakey.py, uploadrclone.py, upload_sa_key.py, upload_and_restore.py
    "restore_*.py",
    "swap_files.py",
    "save_file.py",
    "start_pm2.py",
    "npm_install.py",
    "direct_node.py",
    "force_restart.py",
    "restart_test.py",
    "final_test.py",
    "rebuild.py",
    "simple_check.py",
    "ssh_*.py",
    "ssh-*",
    "ssh_*",
    "fix-*.bat",
    "stage-fix.bat",
    "commit-fix.bat",
    "deploy-fix.bat",
    "check-*.bat",
    "check-*.sh",
    "test-*.bat",
    "test-*.js",
    "diag-*.bat",
    "diag-*.sh",
    "smoke-test.bat",
    "finaltest.py",
    "final-*.py",
    "e2e_test.py",
    # Touch / scratch files (deploy test markers)
    "_deploy_test_*",
    "_touch_*",
    "_scratch_*"
)

# Nhom 5: Other noisy files
$excludeOther = @(
    "*.zip",
    "*.rar",
    "*.7z",
    "*.tar",
    "*.tar.gz",
    "*.tgz",
    "package-lock.json",  # server se tao lai khi npm install
    "yarn.lock",
    "pnpm-lock.yaml",
    "tsconfig.tsbuildinfo",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    "*.mp4",              # video demo (lon)
    "*.mov",
    "*.avi",
    "*.png.bak"
)

# Helper function: check if path matches any pattern
function Test-Excluded([string]$relPath, [string[]]$dirs, [string[]]$globs, [string[]]$sensitive, [string[]]$scratch, [string[]]$other) {
    # Check directory components (any path part matches a dir name)
    $pathParts = $relPath -split '[\\/]'
    foreach ($dir in $dirs) {
        if ($pathParts -contains $dir) { return $true }
    }

    $fileName = Split-Path $relPath -Leaf

    # Check glob patterns (file name matches wildcard)
    foreach ($glob in $globs) {
        if ($fileName -like $glob) { return $true }
    }

    # Check sensitive (exact match OR wildcard)
    foreach ($pat in $sensitive) {
        if ($pat -like "*\*") {
            # contains wildcard, use -like
            if ($fileName -like $pat) { return $true }
        } elseif ($pat -like "*\?*") {
            if ($fileName -like $pat) { return $true }
        } else {
            # exact match
            if ($fileName -eq $pat) { return $true }
        }
    }

    # Check scratch patterns
    foreach ($pat in $scratch) {
        if ($fileName -like $pat) { return $true }
    }

    # Check other
    foreach ($pat in $other) {
        if ($fileName -like $pat) { return $true }
    }

    return $false
}

# Quick test: print excluded paths to verify logic
$testExcluded = @{
    "pass.txt" = $true
    "cursor_deploy_key" = $true
    "cursor_deploy_key.pub" = $true
    "id_ed25519" = $true
    "my_private_key.pem" = $true
    "_debug.py" = $true
    "debug_db.py" = $true
    "node_modules\foo.js" = $true
    ".env" = $true
    ".env.local" = $true
    "server.js" = $false
    "database.js" = $false
    "routes\api\sales.js" = $false
    "package.json" = $false
}
$testsOk = 0; $testsFail = 0
foreach ($k in $testExcluded.Keys) {
    $expected = $testExcluded[$k]
    $actual = Test-Excluded -relPath $k -dirs $excludeDirs -globs $excludeGlobs -sensitive $excludeSensitive -scratch $excludeScratch -other $excludeOther
    if ($expected -eq $actual) {
        $testsOk++
    } else {
        $testsFail++
        Write-Warn "Test FAIL: '$k' expected=$expected got=$actual"
    }
}
Write-OK "Exclude unit tests: $testsOk ok, $testsFail fail"

$items = @()
if ($All) {
    # Sync full project (exclude heavy/sensitive files)
    $items = Get-ChildItem -Path $ProjectRoot -Recurse -File |
        Where-Object {
            $rel = $_.FullName.Substring($ProjectRoot.Length + 1)
            -not (Test-Excluded -relPath $rel -dirs $excludeDirs -globs $excludeGlobs -sensitive $excludeSensitive -scratch $excludeScratch -other $excludeOther)
        } |
        ForEach-Object { $_.FullName.Substring($ProjectRoot.Length + 1) }

    # Sanity check: verify no sensitive files leaked
    $leaked = @()
    foreach ($item in $items) {
        if (Test-Excluded -relPath $item -dirs $excludeDirs -globs $excludeGlobs -sensitive $excludeSensitive -scratch $excludeScratch -other $excludeOther) {
            $leaked += $item
        }
    }
    if ($leaked.Count -gt 0) {
        Write-Err "LEAK: $($leaked.Count) sensitive files would be deployed!"
        $leaked | Select-Object -First 10 | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
        exit 1
    }
    Write-OK "All mode: $($items.Count) files (leak check: PASS)"
} elseif ($Path) {
    $abs = if (Test-Path $Path) { (Resolve-Path $Path).Path } else { Join-Path $ProjectRoot $Path }
    if (-not (Test-Path $abs)) {
        Write-Err "Path not found: $abs"
        exit 1
    }
    # Use relative path from project root (preserves directory structure for SCP)
    $relPath = $abs.Substring($ProjectRoot.Length + 1)

    # Abort if user explicitly tries to deploy a sensitive file
    if (Test-Excluded -relPath $relPath -dirs $excludeDirs -globs $excludeGlobs -sensitive $excludeSensitive -scratch $excludeScratch -other $excludeOther) {
        Write-Err "Refusing to deploy sensitive file: $relPath"
        Write-Host "  This file matches an exclude pattern (sensitive, debug, or scratch)." -ForegroundColor Yellow
        exit 1
    }
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
