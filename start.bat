@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: ========================================
::   BeerPOS - Khoi dong Cloud + Local (PM2)
:: ========================================
echo.
echo  ========================================
echo     BeerPOS - PM2 Mode
echo  ========================================
echo.

:: Kiem tra Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [LOI] Node.js chua duoc cai dat!
    pause
    exit /b 1
)

:: Kiem tra PM2
pm2 --version >nul 2>&1
if errorlevel 1 (
    echo [LOI] PM2 chua duoc cai dat!
    echo Dang cai dat PM2...
    npm install -g pm2
)

:: Dung tat ca cac process cu
echo [1/3] Dung cac server cu...
call pm2 delete all >nul 2>&1

:: Khoi dong ca hai server
echo [2/3] Khoi dong BeerPOS Local (port 3000)...
call pm2 start ecosystem.config.js --only beerpos-local

echo.
echo [3/3] Khoi dong BeerPOS Cloud (port 3001)...
call pm2 start ecosystem.config.js --only beerpos-cloud

echo.
echo  ========================================
echo   Da khoi dong xong!
echo  ========================================
echo.
call pm2 list
echo.
echo  Truy cap:
echo    Local: http://localhost:3000
echo    Cloud: http://localhost:3001
echo.
echo  Lenh quan ly:
echo    pm2 list          - Xem trang thai
echo    pm2 logs          - Xem log
echo    pm2 stop all      - Tat tat ca
echo    pm2 restart all   - Khoi dong lai
echo    pm2 delete all    - Xoa khoi PM2
echo.
