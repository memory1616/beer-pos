@echo off
chcp 65001 >nul
title BeerPOS - Run Migration (Add tier column)

set SSH_HOST=103.75.183.57
set SSH_USER=root
set VPS_PATH=/root/beer-pos

echo ========================================
echo   BeerPOS - Migration: Add tier column
echo ========================================
echo.

REM Use SSH key (no password) - fails fast if key not set up
where ssh >nul 2>nul
if errorlevel 1 (
    echo ERROR: ssh not in PATH
    pause
    exit /b 1
)

echo [1/4] Kiem tra database...
ssh -o StrictHostKeyChecking=no -o BatchMode=yes %SSH_USER%@%SSH_HOST% "ls -la %VPS_PATH%/database.sqlite %VPS_PATH%/data/beerpos.db 2>&1 | head -5"

echo.
echo [2/4] Chay migration (additive, safe to re-run)...
ssh -o StrictHostKeyChecking=no -o BatchMode=yes %SSH_USER%@%SSH_HOST% "bash %VPS_PATH%/deploy/migrate_add_tier.sh"

echo.
echo [3/4] Verify schema...
ssh -o StrictHostKeyChecking=no -o BatchMode=yes %SSH_USER%@%SSH_HOST% "sqlite3 %VPS_PATH%/database.sqlite 'SELECT id, name, tier FROM customers LIMIT 3;' 2>&1"

echo.
echo [4/4] PM2 status...
ssh -o StrictHostKeyChecking=no -o BatchMode=yes %SSH_USER%@%SSH_HOST% "pm2 status | grep beer-pos"

echo.
echo ========================================
echo   Migration hoan tat!
echo ========================================
pause